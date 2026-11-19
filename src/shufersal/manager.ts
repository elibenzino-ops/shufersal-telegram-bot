import type { BotDatabase } from '../store/database.js';
import { AsyncMutex } from '../utils/mutex.js';
import type { ShufersalClient } from './client.js';
import type {
  ActiveOrderSummary,
  CartItem,
  CartState,
  CatalogProduct,
  CheckoutResult,
  DeliverySlot,
  ShufersalSellingMethodCode,
} from './types.js';

export class ShufersalManager {
  private readonly mutex = new AsyncMutex();

  constructor(
    private readonly client: ShufersalClient,
    private readonly db: BotDatabase,
  ) {}

  get pendingOperations(): number {
    return this.mutex.pending;
  }

  async search(query: string, limit = 15): Promise<CatalogProduct[]> {
    return this.mutex.runExclusive(async () => {
      const results = await this.client.searchProducts(query, limit);
      this.db.cacheProducts(results);
      return results;
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
      this.db.cacheProducts([params.product]);

      const currentCart = await this.client.getCartState();
      const existing = currentCart.items.find(
        (i) => i.productCode === params.product.code,
      );
      const previousQuantity = existing?.quantity ?? 0;
      const targetQuantity =
        params.mode === 'increment'
          ? Number((previousQuantity + params.quantity).toFixed(2))
          : Number(params.quantity.toFixed(2));

      const updatedCart = await this.client.setItemsInCart([
        {
          productCode: params.product.code,
          quantity: targetQuantity,
          sellingMethod: params.product.sellingMethod,
          comment: params.comment,
        },
      ]);

      this.db.addContributor(
        params.chatId,
        params.product.code,
        params.senderName,
      );

      return {
        cart: this.enrichCart(params.chatId, updatedCart),
        previousQuantity,
        finalQuantity: targetQuantity,
      };
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

      const match = enriched.items.find((item) => {
        const name = (item.productName ?? '').toLowerCase();
        return (
          name.includes(needle) ||
          needle.includes(name) ||
          item.productCode.toLowerCase() === needle
        );
      });

      if (!match) {
        return { removedItem: null, cart: enriched };
      }

      const nextCart = await this.client.removeFromCart(
        match.productCode,
        match.entryNumber,
      );
      this.db.removeProductContributors(params.chatId, match.productCode);

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
      this.db.cacheProducts([params.newProduct]);

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
          this.db.removeProductContributors(params.chatId, params.oldProductCode);
        } else {
          cartState = await this.client.updateCartItemQuantity(
            params.oldProductCode,
            remainingOld,
            oldEntry.entryNumber,
          );
        }
      }

      const existingNew = cartState.items.find(
        (i) => i.productCode === params.newProduct.code,
      );
      const finalNewQuantity = Number(
        ((existingNew?.quantity ?? 0) + params.quantity).toFixed(2),
      );

      cartState = await this.client.setItemsInCart([
        {
          productCode: params.newProduct.code,
          quantity: finalNewQuantity,
          sellingMethod: params.newProduct.sellingMethod,
        },
      ]);

      this.db.addContributor(
        params.chatId,
        params.newProduct.code,
        params.senderName,
      );
      this.db.recordPreference(
        params.rawQuery,
        params.newProduct.code,
        params.newProduct.name,
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
    sellingMethod: ShufersalSellingMethodCode;
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
      const nextQty = Math.max(0, Number((currentQty + params.delta).toFixed(2)));

      let updated: CartState;
      if (nextQty <= 0) {
        updated = item
          ? await this.client.removeFromCart(params.productCode, item.entryNumber)
          : current;
        this.db.removeProductContributors(params.chatId, params.productCode);
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
      this.db.clearChatContributors(chatId);
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

  async loadOrderForUpdate(chatId: number, orderCode: string): Promise<CartState> {
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
        this.client.getSelectedTimeSlot(),
        this.client.getActiveOrders(),
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
      this.db.clearChatContributors(chatId);
      return result;
    });
  }

  async shutdown(): Promise<void> {
    await this.client.shutdown();
  }

  private enrichCart(chatId: number, cart: CartState): CartState {
    const contributors = this.db.getContributorsByChat(chatId);
    const enrichedItems: CartItem[] = cart.items.map((item) => {
      const cached = this.db.getCachedProduct(item.productCode);
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
      items: enrichedItems,
    };
  }
}
