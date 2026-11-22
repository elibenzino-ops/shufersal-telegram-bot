import type { BotDatabase } from '../store/database.js';
import { normalizeHebrewQuery } from '../utils/format.js';
import { AsyncMutex } from '../utils/mutex.js';
import type {
  ActiveOrderSummary,
  CartItem,
  CartState,
  CatalogProduct,
  CheckoutResult,
  DeliverySlot,
  SellingMethodCode,
  StoreClient,
  StoreId,
  StoreMeta,
} from './types.js';

export class StoreManager {
  private readonly mutex = new AsyncMutex();

  constructor(
    private readonly client: StoreClient,
    private readonly db: BotDatabase,
  ) {}

  get storeId(): StoreId {
    return this.client.storeId;
  }

  get meta(): StoreMeta {
    return this.client.meta;
  }

  get pendingOperations(): number {
    return this.mutex.pending;
  }

  getAuthWarning(): string | null {
    return this.client.getAuthWarning?.() ?? null;
  }

  async search(query: string, limit = 15): Promise<CatalogProduct[]> {
    return this.mutex.runExclusive(async () => {
      const results = await this.client.searchProducts(query, limit);
      const tagged = results.map((p) => ({
        ...p,
        storeId: p.storeId ?? this.storeId,
      }));
      this.db.cacheProducts(tagged, this.storeId);
      return tagged;
    });
  }

  async addOrIncrementProduct(params: {
    chatId: number;
    senderName: string;
    product: CatalogProduct;
    quantity: number;
    mode: 'increment' | 'set';
    comment?: string;
  }): Promise<{
    cart: CartState;
    previousQuantity: number;
    finalQuantity: number;
  }> {
    return this.mutex.runExclusive(async () => {
      const taggedProduct: CatalogProduct = {
        ...params.product,
        storeId: this.storeId,
      };
      this.db.cacheProducts([taggedProduct], this.storeId);

      const currentCart = await this.client.getCartState();
      const existing = currentCart.items.find(
        (i) => i.productCode === taggedProduct.code,
      );
      const previousQuantity = existing?.quantity ?? 0;
      const targetQuantity =
        params.mode === 'increment'
          ? Number((previousQuantity + params.quantity).toFixed(2))
          : Number(params.quantity.toFixed(2));

      const updatedCart = await this.client.setItemsInCart([
        {
          productCode: taggedProduct.code,
          quantity: targetQuantity,
          sellingMethod: taggedProduct.sellingMethod,
          comment: params.comment,
        },
      ]);

      this.db.addContributor(
        params.chatId,
        taggedProduct.code,
        params.senderName,
        this.storeId,
      );

      return {
        cart: this.enrichCart(params.chatId, updatedCart),
        previousQuantity,
        finalQuantity: targetQuantity,
      };
    });
  }

  async setMatchedItemsBatch(params: {
    chatId: number;
    senderName: string;
    entries: Array<{ product: CatalogProduct; quantity: number }>;
  }): Promise<CartState> {
    return this.mutex.runExclusive(async () => {
      if (params.entries.length === 0) {
        const rawCart = await this.client.getCartState();
        return this.enrichCart(params.chatId, rawCart);
      }

      const taggedProducts = params.entries.map((e) => ({
        ...e.product,
        storeId: this.storeId,
      }));
      this.db.cacheProducts(taggedProducts, this.storeId);

      const inputs = params.entries.map((e) => ({
        productCode: e.product.code,
        quantity: Number(e.quantity.toFixed(2)),
        sellingMethod: e.product.sellingMethod,
      }));

      const updatedCart = await this.client.setItemsInCart(inputs);

      for (const p of taggedProducts) {
        this.db.addContributor(
          params.chatId,
          p.code,
          params.senderName,
          this.storeId,
        );
      }

      return this.enrichCart(params.chatId, updatedCart);
    });
  }

  async removeMatchingProduct(params: {
    chatId: number;
    query: string;
  }): Promise<{
    removedItem: CartItem | null;
    cart: CartState;
  }> {
    return this.mutex.runExclusive(async () => {
      const rawCart = await this.client.getCartState();
      const enriched = this.enrichCart(params.chatId, rawCart);
      const needle = params.query.trim().toLowerCase();
      const normalizedNeedle = normalizeHebrewQuery(params.query);
      const needleTokens = normalizedNeedle.split(' ').filter((t) => t.length > 0);

      // 1. Direct code or contiguous substring match
      let match = enriched.items.find((item) => {
        const name = (item.productName ?? '').toLowerCase();
        const normName = normalizeHebrewQuery(item.productName ?? '');
        return (
          item.productCode.toLowerCase() === needle ||
          (needle.length > 0 && name.includes(needle)) ||
          (normalizedNeedle.length > 0 && normName.includes(normalizedNeedle)) ||
          (name.length > 0 && needle.includes(name))
        );
      });

      // 2. Multi-word token match (e.g. "חלב תנובה" matches "חלב מפוסטר 3% תנובה בקרטון")
      if (!match && needleTokens.length > 0) {
        let bestItem: CartItem | undefined;
        let bestScore = 0;

        for (const item of enriched.items) {
          const normName = normalizeHebrewQuery(item.productName ?? '');
          if (!normName) continue;
          const matchedTokens = needleTokens.filter((t) => normName.includes(t));
          const ratio = matchedTokens.length / needleTokens.length;
          if (matchedTokens.length > 0 && ratio >= 0.5 && ratio > bestScore) {
            bestScore = ratio;
            bestItem = item;
          }
        }
        match = bestItem;
      }

      if (!match) {
        return { removedItem: null, cart: enriched };
      }

      const nextCart = await this.client.removeFromCart(
        match.productCode,
        match.entryNumber,
      );
      this.db.removeProductContributors(
        params.chatId,
        match.productCode,
        this.storeId,
      );

      return {
        removedItem: match,
        cart: this.enrichCart(params.chatId, nextCart),
      };
    });
  }

  async removeProductByCode(params: {
    chatId: number;
    productCode: string;
  }): Promise<{
    removedItem: CartItem | null;
    cart: CartState;
  }> {
    return this.mutex.runExclusive(async () => {
      const rawCart = await this.client.getCartState();
      const enriched = this.enrichCart(params.chatId, rawCart);
      const match = enriched.items.find(
        (item) => item.productCode === params.productCode,
      );

      if (!match) {
        return { removedItem: null, cart: enriched };
      }

      const nextCart = await this.client.removeFromCart(
        match.productCode,
        match.entryNumber,
      );
      this.db.removeProductContributors(
        params.chatId,
        match.productCode,
        this.storeId,
      );

      return {
        removedItem: match,
        cart: this.enrichCart(params.chatId, nextCart),
      };
    });
  }

  async replaceProduct(params: {
    chatId: number;
    senderName: string;
    rawQuery: string;
    oldProductCode: string;
    newProduct: CatalogProduct;
    quantity: number;
  }): Promise<{
    cart: CartState;
    finalNewQuantity: number;
  }> {
    return this.mutex.runExclusive(async () => {
      const taggedNew: CatalogProduct = {
        ...params.newProduct,
        storeId: this.storeId,
      };
      this.db.cacheProducts([taggedNew], this.storeId);

      let cartState = await this.client.getCartState();
      const oldEntry = cartState.items.find(
        (i) => i.productCode === params.oldProductCode,
      );

      if (oldEntry) {
        const remainingOld = Number(
          (oldEntry.quantity - params.quantity).toFixed(2),
        );
        if (remainingOld <= 0) {
          cartState = await this.client.removeFromCart(
            params.oldProductCode,
            oldEntry.entryNumber,
          );
          this.db.removeProductContributors(
            params.chatId,
            params.oldProductCode,
            this.storeId,
          );
        } else {
          cartState = await this.client.updateCartItemQuantity(
            params.oldProductCode,
            remainingOld,
            oldEntry.entryNumber,
          );
        }
      }

      const existingNew = cartState.items.find(
        (i) => i.productCode === taggedNew.code,
      );
      const finalNewQuantity = Number(
        ((existingNew?.quantity ?? 0) + params.quantity).toFixed(2),
      );

      cartState = await this.client.setItemsInCart([
        {
          productCode: taggedNew.code,
          quantity: finalNewQuantity,
          sellingMethod: taggedNew.sellingMethod,
        },
      ]);

      this.db.addContributor(
        params.chatId,
        taggedNew.code,
        params.senderName,
        this.storeId,
      );
      this.db.recordPreference(
        params.rawQuery,
        taggedNew.code,
        taggedNew.name,
        this.storeId,
      );

      return {
        cart: this.enrichCart(params.chatId, cartState),
        finalNewQuantity,
      };
    });
  }

  async adjustQuantityByDelta(params: {
    chatId: number;
    productCode: string;
    sellingMethod: SellingMethodCode;
    delta: number;
  }): Promise<{
    cart: CartState;
    newQuantity: number;
  }> {
    return this.mutex.runExclusive(async () => {
      const current = await this.client.getCartState();
      const item = current.items.find(
        (i) => i.productCode === params.productCode,
      );
      const currentQty = item?.quantity ?? 0;
      const nextQty = Math.max(
        0,
        Number((currentQty + params.delta).toFixed(2)),
      );

      let updated: CartState;
      if (nextQty <= 0) {
        updated = item
          ? await this.client.removeFromCart(
              params.productCode,
              item.entryNumber,
            )
          : current;
        this.db.removeProductContributors(
          params.chatId,
          params.productCode,
          this.storeId,
        );
      } else if (item) {
        updated = await this.client.updateCartItemQuantity(
          params.productCode,
          nextQty,
          item.entryNumber,
        );
      } else {
        updated = await this.client.setItemsInCart([
          {
            productCode: params.productCode,
            quantity: nextQty,
            sellingMethod: params.sellingMethod,
          },
        ]);
      }

      return {
        cart: this.enrichCart(params.chatId, updated),
        newQuantity: nextQty,
      };
    });
  }

  async getEnrichedCart(chatId: number): Promise<CartState> {
    return this.mutex.runExclusive(async () => {
      const rawCart = await this.client.getCartState();
      return this.enrichCart(chatId, rawCart);
    });
  }

  async clearCart(chatId: number): Promise<void> {
    return this.mutex.runExclusive(async () => {
      await this.client.clearCart();
      this.db.clearChatContributors(chatId, this.storeId);
    });
  }

  async getAvailableSlots(): Promise<DeliverySlot[]> {
    return this.mutex.runExclusive(async () => {
      return this.client.getAvailableTimeSlots();
    });
  }

  async getSelectedSlot(): Promise<DeliverySlot | null> {
    return this.mutex.runExclusive(async () => {
      return this.client.getSelectedTimeSlot();
    });
  }

  async selectSlot(slotCode: string): Promise<DeliverySlot> {
    return this.mutex.runExclusive(async () => {
      return this.client.selectTimeSlot(slotCode);
    });
  }

  async getActiveOrders(): Promise<ActiveOrderSummary[]> {
    return this.mutex.runExclusive(async () => {
      return this.client.getActiveOrders();
    });
  }

  async loadOrderForUpdate(
    chatId: number,
    orderCode: string,
  ): Promise<CartState> {
    return this.mutex.runExclusive(async () => {
      const cart = await this.client.putOrderInUpdateMode(orderCode);
      return this.enrichCart(chatId, cart);
    });
  }

  async getPreCheckoutSnapshot(chatId: number): Promise<{
    cart: CartState;
    selectedSlot: DeliverySlot | null;
    activeOrders: ActiveOrderSummary[];
  }> {
    return this.mutex.runExclusive(async () => {
      const [rawCart, selectedSlot, activeOrders] = await Promise.all([
        this.client.getCartState(),
        this.client.getSelectedTimeSlot().catch(() => null),
        this.client.getActiveOrders().catch(() => []),
      ]);
      return {
        cart: this.enrichCart(chatId, rawCart),
        selectedSlot,
        activeOrders,
      };
    });
  }

  async checkout(
    chatId: number,
    options: { removeMissingItems: boolean },
  ): Promise<CheckoutResult> {
    return this.mutex.runExclusive(async () => {
      const result = await this.client.placeOrder(options);
      this.db.clearChatContributors(chatId, this.storeId);
      return {
        ...result,
        storeId: result.storeId ?? this.storeId,
      };
    });
  }

  supportsSmsOtpLogin(): boolean {
    return Boolean(
      this.client.startSmsOtpLogin && this.client.completeSmsOtpLogin,
    );
  }

  isAuthenticated(): boolean {
    return this.client.isAuthenticated ? this.client.isAuthenticated() : true;
  }

  async startSmsOtpLogin(phoneNumber: string): Promise<{ message: string }> {
    if (!this.client.startSmsOtpLogin) {
      throw new Error(`התחברות SMS אינה נתמכת עבור ${this.meta.displayName}`);
    }
    return this.mutex.runExclusive(async () => {
      return this.client.startSmsOtpLogin!(phoneNumber);
    });
  }

  async completeSmsOtpLogin(
    otpCode: string,
  ): Promise<{ message: string; isAuthenticated: boolean }> {
    if (!this.client.completeSmsOtpLogin) {
      throw new Error(`התחברות SMS אינה נתמכת עבור ${this.meta.displayName}`);
    }
    return this.mutex.runExclusive(async () => {
      return this.client.completeSmsOtpLogin!(otpCode);
    });
  }

  async shutdown(): Promise<void> {
    await this.client.shutdown();
  }

  private enrichCart(chatId: number, cart: CartState): CartState {
    const contributors = this.db.getContributorsByChat(chatId, this.storeId);
    const enrichedItems: CartItem[] = cart.items.map((item) => {
      const cached = this.db.getCachedProduct(item.productCode, this.storeId);
      return {
        ...item,
        productName:
          item.productName ??
          cached?.name ??
          `מוצר (${item.productCode})`,
        unitDescription: cached?.unitDescription ?? item.unitDescription ?? null,
        sellingMethod:
          item.sellingMethod ?? cached?.sellingMethod ?? 'BY_UNIT',
        requestedBy: contributors.get(item.productCode) ?? [],
      };
    });

    return {
      ...cart,
      storeId: cart.storeId ?? this.storeId,
      items: enrichedItems,
    };
  }
}
