import type {
  GroceryAiService,
  ParsedGroceryItem,
  ProductSelectionResult,
} from '../ai/groceryAi.js';
import { logger } from '../logger.js';
import type { BotDatabase } from '../store/database.js';
import type { StoreManager } from './storeManager.js';
import type {
  CartComparisonResult,
  CartItem,
  CartState,
  CatalogProduct,
  CheckoutResult,
  DeliverySlot,
  SellingMethodCode,
  StoreCartQuote,
  StoreId,
  StoreMeta,
} from './types.js';

export interface StoreAddItemOutcome {
  storeId: StoreId;
  meta: StoreMeta;
  status: 'added' | 'not_found' | 'error';
  product?: CatalogProduct;
  addedQty?: number;
  finalQuantity?: number;
  alternatives?: CatalogProduct[];
  cart?: CartState;
  error?: string;
}

export interface MultiStoreAddItemResult {
  request: ParsedGroceryItem;
  outcomes: StoreAddItemOutcome[];
  cheapestItemStoreId: StoreId | null;
}

export interface StoreRemoveItemOutcome {
  storeId: StoreId;
  meta: StoreMeta;
  removedItem: CartItem | null;
  cart?: CartState;
  error?: string;
}

export interface StoreAdjustOutcome {
  storeId: StoreId;
  meta: StoreMeta;
  productCode: string;
  newQuantity: number;
  cart?: CartState;
  error?: string;
}

export interface MirrorStoreSummary {
  storeId: StoreId;
  meta: StoreMeta;
  matchedCount: number;
  missingItems: string[];
  error?: string;
}

export interface MirrorCartResult {
  sourceStoreId: StoreId;
  sourceOrderInUpdateMode: string | null;
  totalSourceItems: number;
  storeSummaries: MirrorStoreSummary[];
  comparison: CartComparisonResult;
}

export function rankStoreQuotes(quotes: StoreCartQuote[]): CartComparisonResult {
  const valid = quotes.filter((q) => !q.error && q.inStockCount > 0);
  const maxCoverage = valid.reduce((m, q) => Math.max(m, q.inStockCount), 0);

  const sorted = [...quotes].sort((a, b) => {
    const aValid = !a.error && a.inStockCount > 0;
    const bValid = !b.error && b.inStockCount > 0;
    if (aValid !== bValid) return aValid ? -1 : 1;
    if (!aValid && !bValid) {
      // Non-errored empty carts before errored carts
      if (Boolean(a.error) !== Boolean(b.error)) return a.error ? 1 : -1;
      return 0;
    }

    // Prefer stores that have full/highest item coverage before partial carts
    const aHasMax = a.inStockCount >= maxCoverage;
    const bHasMax = b.inStockCount >= maxCoverage;
    if (aHasMax !== bHasMax) return aHasMax ? -1 : 1;

    // If neither has max coverage, prefer higher coverage
    if (!aHasMax && !bHasMax && a.inStockCount !== b.inStockCount) {
      return b.inStockCount - a.inStockCount;
    }

    // Primary price ranking: lowest estimatedTotal (items + delivery fee)
    if (Math.abs(a.estimatedTotal - b.estimatedTotal) > 0.005) {
      return a.estimatedTotal - b.estimatedTotal;
    }
    return a.subtotal - b.subtotal;
  });

  const validSorted = sorted.filter((q) => !q.error && q.inStockCount > 0);
  const cheapest = validSorted[0] ?? null;

  const completeSorted = validSorted.filter((q) => q.missingItemsCount === 0);
  const cheapestComplete = completeSorted[0] ?? cheapest;

  // Compare savings against other valid stores with comparable coverage (or all valid stores)
  const comparablePool =
    validSorted.filter((q) => q.inStockCount >= maxCoverage).length >= 2
      ? validSorted.filter((q) => q.inStockCount >= maxCoverage)
      : validSorted;

  const second = comparablePool[1] ?? null;
  const mostExpensive =
    comparablePool.length >= 2
      ? comparablePool[comparablePool.length - 1]!
      : null;

  const savingsVsSecondCheapest =
    cheapest && second
      ? Math.max(0, Number((second.estimatedTotal - cheapest.estimatedTotal).toFixed(2)))
      : 0;
  const savingsVsMostExpensive =
    cheapest && mostExpensive
      ? Math.max(
          0,
          Number((mostExpensive.estimatedTotal - cheapest.estimatedTotal).toFixed(2)),
        )
      : 0;

  return {
    quotes: sorted,
    cheapestStoreId: cheapest?.storeId ?? null,
    cheapestCompleteStoreId: cheapestComplete?.storeId ?? null,
    savingsVsSecondCheapest,
    savingsVsMostExpensive,
  };
}

export class MultiStoreManager {
  private readonly managers = new Map<StoreId, StoreManager>();
  private readonly orderedStoreIds: StoreId[];

  constructor(
    storeManagers: StoreManager[],
    private readonly db: BotDatabase,
  ) {
    if (storeManagers.length === 0) {
      throw new Error('At least one StoreManager must be configured');
    }
    this.orderedStoreIds = [];
    for (const mgr of storeManagers) {
      this.managers.set(mgr.storeId, mgr);
      this.orderedStoreIds.push(mgr.storeId);
    }
  }

  getEnabledStores(): StoreMeta[] {
    return this.orderedStoreIds.map((id) => this.managers.get(id)!.meta);
  }

  getEnabledStoreIds(): StoreId[] {
    return [...this.orderedStoreIds];
  }

  getStore(storeId: StoreId): StoreManager | undefined {
    return this.managers.get(storeId);
  }

  getPrimaryStore(): StoreManager {
    return (
      this.managers.get('shufersal') ??
      this.managers.get(this.orderedStoreIds[0]!)!
    );
  }

  isMultiStore(): boolean {
    return this.orderedStoreIds.length > 1;
  }

  async searchAcrossStores(
    query: string,
    limitPerStore = 6,
    onlyStoreId?: StoreId,
  ): Promise<
    Array<{
      storeId: StoreId;
      meta: StoreMeta;
      products: CatalogProduct[];
      error?: string;
    }>
  > {
    const targetIds = onlyStoreId
      ? this.orderedStoreIds.filter((id) => id === onlyStoreId)
      : this.orderedStoreIds;

    const settled = await Promise.all(
      targetIds.map(async (storeId) => {
        const mgr = this.managers.get(storeId)!;
        try {
          const products = await mgr.search(query, limitPerStore);
          return { storeId, meta: mgr.meta, products };
        } catch (err) {
          logger.warn(`Search failed on store ${storeId}`, err);
          return {
            storeId,
            meta: mgr.meta,
            products: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    return settled;
  }

  async addItemAcrossStores(params: {
    chatId: number;
    senderName: string;
    request: ParsedGroceryItem;
    ai: GroceryAiService;
  }): Promise<MultiStoreAddItemResult> {
    const mode = params.request.action === 'set' ? 'set' : 'increment';

    this.db.upsertShoppingListItem({
      chatId: params.chatId,
      query: params.request.searchQuery,
      quantity: params.request.quantity,
      mode,
      unitPreference: params.request.unitPreference,
      senderName: params.senderName,
    });

    // 1. Search all enabled stores in parallel
    const searchResults = await Promise.all(
      this.orderedStoreIds.map(async (storeId) => {
        const mgr = this.managers.get(storeId)!;
        try {
          const candidates = await mgr.search(params.request.searchQuery, 15);
          return { storeId, mgr, candidates, error: null as string | null };
        } catch (err) {
          logger.warn(`Search failed on ${storeId} for "${params.request.searchQuery}"`, err);
          return {
            storeId,
            mgr,
            candidates: [] as CatalogProduct[],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    // 2. Select best product in each store, sharing the first matched barcode for apples-to-apples SKU matching
    const selections = new Map<StoreId, ProductSelectionResult>();
    let sharedBarcode: string | null = null;

    for (const sr of searchResults) {
      if (sr.error || sr.candidates.length === 0) continue;
      const learned = this.db.getPreference(
        params.request.searchQuery,
        sr.storeId,
      );
      const selection = await params.ai.selectBestProduct({
        request: params.request,
        candidates: sr.candidates,
        learnedProductCode: learned?.productCode ?? null,
        preferredBarcode: sharedBarcode,
        storeName: sr.mgr.meta.displayName,
      });
      selections.set(sr.storeId, selection);
      if (!sharedBarcode && selection.selected?.barcode) {
        sharedBarcode = selection.selected.barcode;
      }
    }

    // 3. Add selected products to each store's online cart in parallel
    const outcomes: StoreAddItemOutcome[] = await Promise.all(
      searchResults.map(async (sr): Promise<StoreAddItemOutcome> => {
        if (sr.error) {
          return {
            storeId: sr.storeId,
            meta: sr.mgr.meta,
            status: 'error',
            error: sr.error,
          };
        }

        const selection = selections.get(sr.storeId);
        if (!selection?.selected) {
          return {
            storeId: sr.storeId,
            meta: sr.mgr.meta,
            status: 'not_found',
          };
        }

        try {
          const { cart, finalQuantity } = await sr.mgr.addOrIncrementProduct({
            chatId: params.chatId,
            senderName: params.senderName,
            product: selection.selected,
            quantity: selection.adjustedQuantity,
            mode,
            comment: params.request.pickerComment,
          });
          return {
            storeId: sr.storeId,
            meta: sr.mgr.meta,
            status: 'added',
            product: selection.selected,
            addedQty: selection.adjustedQuantity,
            finalQuantity,
            alternatives: selection.alternatives,
            cart,
          };
        } catch (err) {
          logger.warn(`Add to cart failed on ${sr.storeId}`, err);
          return {
            storeId: sr.storeId,
            meta: sr.mgr.meta,
            status: 'error',
            product: selection.selected,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    // Find which store had the cheapest unit/line price for this item
    const addedOutcomes = outcomes.filter(
      (o) => o.status === 'added' && o.product && o.product.price > 0,
    );
    addedOutcomes.sort(
      (a, b) =>
        (a.product!.price * (a.addedQty ?? 1)) -
        (b.product!.price * (b.addedQty ?? 1)),
    );

    return {
      request: params.request,
      outcomes,
      cheapestItemStoreId: addedOutcomes[0]?.storeId ?? null,
    };
  }

  async removeAcrossStores(params: {
    chatId: number;
    query: string;
  }): Promise<StoreRemoveItemOutcome[]> {
    this.db.removeShoppingListItem(params.chatId, params.query);

    return Promise.all(
      this.orderedStoreIds.map(async (storeId): Promise<StoreRemoveItemOutcome> => {
        const mgr = this.managers.get(storeId)!;
        try {
          const { removedItem, cart } = await mgr.removeMatchingProduct({
            chatId: params.chatId,
            query: params.query,
          });
          return { storeId, meta: mgr.meta, removedItem, cart };
        } catch (err) {
          logger.warn(`Remove failed on ${storeId}`, err);
          return {
            storeId,
            meta: mgr.meta,
            removedItem: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
  }

  async adjustQuantityAcrossStores(params: {
    chatId: number;
    targets: Array<{
      storeId: StoreId;
      productCode: string;
      sellingMethod: SellingMethodCode;
    }>;
    delta: number;
  }): Promise<StoreAdjustOutcome[]> {
    return Promise.all(
      params.targets.map(async (t): Promise<StoreAdjustOutcome> => {
        const mgr = this.managers.get(t.storeId);
        if (!mgr) {
          return {
            storeId: t.storeId,
            meta: this.getPrimaryStore().meta,
            productCode: t.productCode,
            newQuantity: 0,
            error: `חנות ${t.storeId} לא פעילה`,
          };
        }
        try {
          const { cart, newQuantity } = await mgr.adjustQuantityByDelta({
            chatId: params.chatId,
            productCode: t.productCode,
            sellingMethod: t.sellingMethod,
            delta: params.delta,
          });
          return {
            storeId: t.storeId,
            meta: mgr.meta,
            productCode: t.productCode,
            newQuantity,
            cart,
          };
        } catch (err) {
          logger.warn(`Adjust quantity failed on ${t.storeId}`, err);
          return {
            storeId: t.storeId,
            meta: mgr.meta,
            productCode: t.productCode,
            newQuantity: 0,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
  }

  async compareCarts(chatId: number): Promise<CartComparisonResult> {
    const shoppingListCount = this.db.getShoppingList(chatId).length;

    const rawQuotes = await Promise.all(
      this.orderedStoreIds.map(async (storeId): Promise<StoreCartQuote> => {
        const mgr = this.managers.get(storeId)!;
        try {
          const [cart, selectedSlot] = await Promise.all([
            mgr.getEnrichedCart(chatId),
            mgr.getSelectedSlot().catch(() => null),
          ]);
          const inStockCount = cart.items.filter((i) => i.inStock).length;
          const outOfStockCount = cart.items.filter((i) => !i.inStock).length;
          const subtotal = Number(cart.totalPrice.toFixed(2));
          const deliveryFee =
            selectedSlot?.deliveryFee ??
            cart.deliveryFee ??
            mgr.meta.defaultDeliveryFee ??
            0;
          const estimatedTotal = Number((subtotal + deliveryFee).toFixed(2));
          const minimumOrderAmount = mgr.meta.minimumOrderAmount;
          const belowMinimum =
            minimumOrderAmount !== null &&
            inStockCount > 0 &&
            subtotal < minimumOrderAmount;

          return {
            storeId,
            meta: mgr.meta,
            cart,
            selectedSlot,
            inStockCount,
            outOfStockCount,
            expectedItemsCount: shoppingListCount,
            missingItemsCount: 0,
            subtotal,
            deliveryFee: Number(deliveryFee.toFixed(2)),
            estimatedTotal,
            belowMinimum,
            minimumOrderAmount,
            isGuestSession: Boolean(cart.isGuestSession),
            error: null,
          };
        } catch (err) {
          logger.warn(`compareCarts failed for ${storeId}`, err);
          return {
            storeId,
            meta: mgr.meta,
            cart: null,
            selectedSlot: null,
            inStockCount: 0,
            outOfStockCount: 0,
            expectedItemsCount: shoppingListCount,
            missingItemsCount: shoppingListCount,
            subtotal: 0,
            deliveryFee: mgr.meta.defaultDeliveryFee ?? 0,
            estimatedTotal: 0,
            belowMinimum: false,
            minimumOrderAmount: mgr.meta.minimumOrderAmount,
            isGuestSession: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    // Derive expected item baseline as max(shoppingListCount, max inStockCount across stores)
    const maxObserved = rawQuotes.reduce(
      (max, q) => Math.max(max, q.inStockCount),
      shoppingListCount,
    );
    const finalizedQuotes = rawQuotes.map((q) => ({
      ...q,
      expectedItemsCount: maxObserved,
      missingItemsCount: q.error
        ? maxObserved
        : Math.max(0, maxObserved - q.inStockCount),
    }));

    return rankStoreQuotes(finalizedQuotes);
  }

  async clearCart(chatId: number, storeId?: StoreId): Promise<
    Array<{ storeId: StoreId; meta: StoreMeta; ok: boolean; error?: string }>
  > {
    const targetIds = storeId
      ? this.orderedStoreIds.filter((id) => id === storeId)
      : this.orderedStoreIds;

    if (!storeId) {
      this.db.clearShoppingList(chatId);
    }

    return Promise.all(
      targetIds.map(async (id) => {
        const mgr = this.managers.get(id)!;
        try {
          await mgr.clearCart(chatId);
          return { storeId: id, meta: mgr.meta, ok: true };
        } catch (err) {
          return {
            storeId: id,
            meta: mgr.meta,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
  }

  async clearOtherStores(
    chatId: number,
    keepStoreId: StoreId,
  ): Promise<
    Array<{ storeId: StoreId; meta: StoreMeta; ok: boolean; error?: string }>
  > {
    const otherIds = this.orderedStoreIds.filter((id) => id !== keepStoreId);
    return Promise.all(
      otherIds.map(async (id) => {
        const mgr = this.managers.get(id)!;
        try {
          await mgr.clearCart(chatId);
          return { storeId: id, meta: mgr.meta, ok: true };
        } catch (err) {
          return {
            storeId: id,
            meta: mgr.meta,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
  }

  async checkoutStore(
    chatId: number,
    storeId: StoreId,
    options: { removeMissingItems: boolean },
  ): Promise<CheckoutResult> {
    const mgr = this.managers.get(storeId);
    if (!mgr) {
      throw new Error(`החנות ${storeId} אינה מופעלת`);
    }
    const result = await mgr.checkout(chatId, options);
    this.db.clearShoppingList(chatId);
    return result;
  }

  async getAvailableSlots(storeId: StoreId): Promise<DeliverySlot[]> {
    const mgr = this.managers.get(storeId);
    if (!mgr) return [];
    return mgr.getAvailableSlots();
  }

  async mirrorCartToOtherStores(params: {
    chatId: number;
    sourceStoreId: StoreId;
    senderName: string;
    ai: GroceryAiService;
    clearTargetFirst?: boolean;
    onProgress?: (done: number, total: number) => Promise<void> | void;
  }): Promise<MirrorCartResult> {
    const sourceMgr = this.managers.get(params.sourceStoreId);
    if (!sourceMgr) {
      throw new Error(`החנות ${params.sourceStoreId} אינה מופעלת`);
    }

    const sourceCart = await sourceMgr.getEnrichedCart(params.chatId);
    const sourceItems = sourceCart.items.filter(
      (i) => i.inStock && i.quantity > 0,
    );
    const targetManagers = this.orderedStoreIds
      .filter((id) => id !== params.sourceStoreId)
      .map((id) => this.managers.get(id)!);

    if (sourceItems.length === 0 || targetManagers.length === 0) {
      const comparison = await this.compareCarts(params.chatId);
      return {
        sourceStoreId: params.sourceStoreId,
        sourceOrderInUpdateMode: sourceCart.orderInUpdateMode,
        totalSourceItems: sourceItems.length,
        storeSummaries: targetManagers.map((m) => ({
          storeId: m.storeId,
          meta: m.meta,
          matchedCount: 0,
          missingItems: [],
        })),
        comparison,
      };
    }

    const summaryByStore = new Map<StoreId, MirrorStoreSummary>();
    const failedStores = new Set<StoreId>();

    for (const mgr of targetManagers) {
      summaryByStore.set(mgr.storeId, {
        storeId: mgr.storeId,
        meta: mgr.meta,
        matchedCount: 0,
        missingItems: [],
      });
    }

    // Clear target carts first so the comparison matches the source cart 1:1
    if (params.clearTargetFirst !== false) {
      await Promise.all(
        targetManagers.map(async (mgr) => {
          try {
            await mgr.clearCart(params.chatId);
          } catch (err) {
            logger.warn(`Failed clearing ${mgr.storeId} before mirror`, err);
            const msg = err instanceof Error ? err.message : String(err);
            const entry = summaryByStore.get(mgr.storeId)!;
            entry.error = msg;
            failedStores.add(mgr.storeId);
          }
        }),
      );
    }

    // Reset canonical shopping list to mirror the source cart items
    this.db.clearShoppingList(params.chatId);

    for (let idx = 0; idx < sourceItems.length; idx++) {
      const item = sourceItems[idx]!;
      const displayName = (item.productName ?? item.productCode).trim();
      const cached = this.db.getCachedProduct(
        item.productCode,
        params.sourceStoreId,
      );
      const strippedCode = item.productCode.replace(/^P_/i, '').trim();
      const sourceBarcode =
        cached?.barcode ??
        (/^\d{6,14}$/.test(strippedCode) ? strippedCode : null);

      const sellingMethod =
        item.sellingMethod ?? cached?.sellingMethod ?? 'BY_UNIT';
      const request: ParsedGroceryItem = {
        rawText: displayName,
        searchQuery: displayName,
        action: 'set',
        quantity: item.quantity,
        unitPreference: sellingMethod === 'BY_WEIGHT' ? 'WEIGHT' : 'UNIT',
      };

      this.db.upsertShoppingListItem({
        chatId: params.chatId,
        query: displayName,
        quantity: item.quantity,
        mode: 'set',
        unitPreference: request.unitPreference,
        senderName: params.senderName,
      });

      await Promise.all(
        targetManagers.map(async (targetMgr) => {
          if (failedStores.has(targetMgr.storeId)) return;
          const summary = summaryByStore.get(targetMgr.storeId)!;
          try {
            let candidates: CatalogProduct[] = [];
            // Try exact barcode search first for fast, apples-to-apples SKU matching
            if (sourceBarcode) {
              candidates = await targetMgr.search(sourceBarcode, 8).catch(() => []);
            }
            const hasInStockBarcode = candidates.some(
              (c) => c.inStock && c.purchasable,
            );
            if (!hasInStockBarcode && displayName) {
              candidates = await targetMgr.search(displayName, 12);
            }

            const learned = this.db.getPreference(displayName, targetMgr.storeId);
            const selection = await params.ai.selectBestProduct({
              request,
              candidates,
              learnedProductCode: learned?.productCode ?? null,
              preferredBarcode: sourceBarcode,
              storeName: targetMgr.meta.displayName,
            });

            if (!selection.selected) {
              summary.missingItems.push(displayName);
              return;
            }

            await targetMgr.addOrIncrementProduct({
              chatId: params.chatId,
              senderName: params.senderName,
              product: selection.selected,
              quantity: selection.adjustedQuantity,
              mode: 'increment',
            });
            summary.matchedCount++;
          } catch (err) {
            logger.warn(
              `Mirror item "${displayName}" failed on ${targetMgr.storeId}`,
              err,
            );
            const msg = err instanceof Error ? err.message : String(err);
            // If the store itself is blocked/auth-failed, stop hammering it for remaining items
            if (
              msg.includes('CAPTCHA') ||
              msg.includes('WAF') ||
              msg.includes('התחברות')
            ) {
              summary.error = msg;
              failedStores.add(targetMgr.storeId);
            } else {
              summary.missingItems.push(displayName);
            }
          }
        }),
      );

      if (params.onProgress) {
        await params.onProgress(idx + 1, sourceItems.length);
      }
    }

    const comparison = await this.compareCarts(params.chatId);
    return {
      sourceStoreId: params.sourceStoreId,
      sourceOrderInUpdateMode: sourceCart.orderInUpdateMode,
      totalSourceItems: sourceItems.length,
      storeSummaries: targetManagers.map((m) => summaryByStore.get(m.storeId)!),
      comparison,
    };
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.managers.values()].map((m) => m.shutdown()),
    );
  }
}
