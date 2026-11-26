import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GroceryAiService,
  extractRecommendedGeminiModel,
  extractRetryDelayMs,
  extractTargetStoreFromCommand,
  extractTargetStoreFromNaturalText,
  type ParsedGroceryItem,
} from '../src/ai/groceryAi.js';
import {
  createTelegramBot,
  renderComparisonHtml,
} from '../src/bot/telegramBot.js';
import { parseEnabledStores, type AppConfig } from '../src/config.js';
import { BotDatabase } from '../src/store/database.js';
import {
  HaziHinamClient,
  parseHaziHinamCartResponse,
  parseHaziHinamDeliverySlots,
  parseHaziHinamOrders,
  parseHaziHinamProduct,
} from '../src/stores/haziHinamClient.js';
import {
  MultiStoreManager,
  buildMirrorSearchQueries,
  rankStoreQuotes,
} from '../src/stores/multiStoreManager.js';
import { StoreManager } from '../src/stores/storeManager.js';
import {
  STORE_META,
  StoreManualVerificationRequiredError,
  type CartState,
  type CatalogProduct,
  type DeliverySlot,
  type StoreCartQuote,
  type StoreClient,
  type StoreId,
} from '../src/stores/types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('parseEnabledStores', () => {
  it('enables Shufersal and Hazi Hinam by default when Shufersal credentials exist, and omits Shufersal when absent', () => {
    expect(parseEnabledStores(undefined, true)).toEqual([
      'shufersal',
      'hazi_hinam',
    ]);
    expect(parseEnabledStores(undefined, false)).toEqual(['hazi_hinam']);
  });

  it('supports English and Hebrew store aliases and ignores removed stores', () => {
    expect(parseEnabledStores('שופרסל, חצי חינם', true)).toEqual([
      'shufersal',
      'hazi_hinam',
    ]);
    expect(parseEnabledStores('hazi,haviv,victory', false)).toEqual([
      'hazi_hinam',
    ]);
  });
});

describe('HaziHinamClient', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hazi-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses Hazi Hinam catalog products accurately (sale price, barcode, weight)', () => {
    const prod = parseHaziHinamProduct({
      Id: 278017,
      BarKod: '7290004127329',
      Name: "קוטג' 5% תנובה",
      ManufacturerName: 'תנובה',
      Price_Regular: 6.9,
      Price_NET: 5.9,
      Weight: 250,
      WeightUnit: 'גרם',
      PricePerUnitDesc: '2.36 ₪ ל-100 גרם',
      IsInStock: true,
      IsWeight: false,
      Img: 'https://cdn.hazi-hinam.co.il/cottage.jpg',
    });

    expect(prod).not.toBeNull();
    expect(prod?.code).toBe('278017');
    expect(prod?.storeId).toBe('hazi_hinam');
    expect(prod?.barcode).toBe('7290004127329');
    expect(prod?.price).toBe(5.9);
    expect(prod?.sellingMethod).toBe('BY_UNIT');
    expect(prod?.promotionMsg).toContain('₪6.90');
  });

  it('authenticates via OAuth2, searches, adds to cart, selects delivery slot, and returns checkout handoff link', async () => {
    const serverCartItems: Array<Record<string, unknown>> = [];
    const futureDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const futureYmd = futureDate.toISOString().slice(0, 10);
    let reservedSlotBody: Record<string, unknown> | null = null;

    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.endsWith('/connect/token')) {
        return jsonResponse({
          access_token: 'hazi-oauth-token-1234567890',
          expires_in: 86400,
        });
      }

      if (url.includes('/proxy/api/item/getItemsBySearch')) {
        return jsonResponse({
          IsOK: true,
          Results: {
            Items: [
              {
                Id: 1001,
                BarKod: '7290004127329',
                Name: "קוטג' 5% תנובה",
                ManufacturerName: 'תנובה',
                Price_Regular: 6.2,
                IsInStock: true,
              },
            ],
          },
        });
      }

      if (url.includes('/proxy/api/item/addItemToCart')) {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as {
          Object: { ItemId: number; Quantity: number };
        };
        serverCartItems.push({
          ItemId: parsed.Object.ItemId,
          Name: "קוטג' 5% תנובה",
          Quantity: parsed.Object.Quantity,
          Price_NET: 6.2,
          TotalPrice: Number((6.2 * parsed.Object.Quantity).toFixed(2)),
          IsInStock: true,
        });
        return jsonResponse({ IsOK: true });
      }

      if (url.includes('/proxy/api/cart/getCart')) {
        return jsonResponse({
          IsOK: true,
          Results: {
            Items: serverCartItems,
            TotalPrice: serverCartItems.reduce(
              (s, i) => s + Number(i['TotalPrice'] ?? 0),
              0,
            ),
          },
        });
      }

      if (url.includes('/proxy/api/delivery/getDeliveryDates')) {
        return jsonResponse({
          IsOK: true,
          Results: {
            Dates: [
              {
                Date: futureYmd,
                Hours: [
                  {
                    Id: 7001,
                    FromHour: '10:00',
                    ToHour: '12:00',
                    Price: 24.9,
                    IsAvailable: true,
                  },
                  {
                    Id: 7002,
                    FromHour: '12:00',
                    ToHour: '14:00',
                    Price: 29.9,
                    IsAvailable: false,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes('/proxy/api/delivery/setDeliveryDate')) {
        reservedSlotBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse({ IsOK: true });
      }

      if (url.includes('/proxy/api/order/getOrders')) {
        return jsonResponse({
          IsOK: true,
          Results: {
            Orders: [
              {
                OrderId: 88123,
                StatusName: 'התקבלה',
                DeliveryDate: futureYmd,
                FromHour: '10:00',
                ToHour: '12:00',
                TotalToPay: 245.5,
                ItemsCount: 18,
              },
              {
                OrderId: 88000,
                StatusName: 'בוטלה',
                DeliveryDate: futureYmd,
                TotalToPay: 100,
                ItemsCount: 5,
              },
            ],
          },
        });
      }

      return jsonResponse({ IsOK: true });
    }) as unknown as typeof fetch;

    const sessionFilePath = path.join(tmpDir, 'hazi-session.json');
    const client = new HaziHinamClient({
      username: 'user@example.com',
      password: 'secret',
      sessionFilePath,
      fetchFn: mockFetch,
    });

    const products = await client.searchProducts("קוטג' 5%");
    expect(products).toHaveLength(1);
    expect(products[0]?.code).toBe('1001');
    expect(client.isAuthenticated()).toBe(true);

    const cart = await client.setItemsInCart([
      { productCode: '1001', quantity: 2, sellingMethod: 'BY_UNIT' },
    ]);
    expect(cart.items).toHaveLength(1);
    expect(cart.totalPrice).toBe(12.4);
    expect(cart.isGuestSession).toBe(false);

    // Fetch and reserve a delivery slot just like Shufersal
    const slots = await client.getAvailableTimeSlots();
    expect(slots).toHaveLength(1);
    expect(slots[0]?.code).toBe('7001');
    expect(slots[0]?.deliveryFee).toBe(24.9);

    const chosen = await client.selectTimeSlot('7001');
    expect(chosen.code).toBe('7001');
    expect(reservedSlotBody).not.toBeNull();
    expect((await client.getSelectedTimeSlot())?.code).toBe('7001');

    // Persisted session restores both authentication and selected slot across restarts
    const reloadedClient = new HaziHinamClient({
      username: 'user@example.com',
      password: 'secret',
      sessionFilePath,
      fetchFn: mockFetch,
    });
    expect(reloadedClient.isAuthenticated()).toBe(true);
    expect((await reloadedClient.getSelectedTimeSlot())?.code).toBe('7001');

    // Active orders exclude cancelled orders
    const orders = await client.getActiveOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]?.code).toBe('88123');
    expect(orders[0]?.totalPrice).toBe(245.5);

    // Checkout raises manual checkout handoff with selected slot details & direct cart link
    await expect(
      client.placeOrder({ removeMissingItems: true }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof StoreManualVerificationRequiredError &&
        err.message.includes('חלון משלוח שנבחר')
      );
    });
  });

  it('parses Hazi Hinam cart responses, flat/nested delivery slots, and active orders', () => {
    const parsedCart = parseHaziHinamCartResponse(
      {
        Results: {
          Cart: {
            Items: [
              {
                ItemId: 555,
                Name: 'חלב 3%',
                Quantity: 3,
                Price_NET: 6.8,
                IsInStock: true,
              },
            ],
            DeliveryPrice: 29.9,
          },
        },
      },
      29.9,
      false,
    );
    expect(parsedCart?.totalPrice).toBe(20.4);
    expect(parsedCart?.deliveryFee).toBe(29.9);

    const parsedSlots = parseHaziHinamDeliverySlots(
      {
        Results: {
          Shipments: [
            {
              ShipmentId: 'S2',
              FromDate: '2026-12-02T14:00:00Z',
              FromHour: '16:00',
              ToHour: '18:00',
              DeliveryPrice: 19.9,
              IsAvailable: true,
            },
            {
              ShipmentId: 'S1',
              FromDate: '2026-12-01T08:00:00Z',
              FromHour: '10:00',
              ToHour: '12:00',
              DeliveryPrice: 29.9,
              IsAvailable: true,
            },
            {
              ShipmentId: 'S3',
              FromDate: '2026-12-01T12:00:00Z',
              FromHour: '14:00',
              ToHour: '16:00',
              IsFull: true,
            },
          ],
        },
      },
      29.9,
    );
    expect(parsedSlots.map((s) => s.code)).toEqual(['S1', 'S2']);
    expect(parsedSlots[1]?.deliveryFee).toBe(19.9);

    const parsedOrders = parseHaziHinamOrders({
      Results: {
        Orders: [
          {
            OrderNumber: 'HH-500',
            DeliveryDate: '2026-12-05',
            FromHour: '09:00',
            ToHour: '11:00',
            TotalPrice: 310,
            ItemsCount: 22,
            StatusName: 'אושרה',
          },
        ],
      },
    });
    expect(parsedOrders).toHaveLength(1);
    expect(parsedOrders[0]?.code).toBe('HH-500');
    expect(parsedOrders[0]?.deliveryHoursText).toBe('09:00–11:00');
  });
});

describe('rankStoreQuotes & MultiStoreManager (Shufersal + Hazi Hinam)', () => {
  let tmpDir: string;
  let db: BotDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-store-test-'));
    db = new BotDatabase(path.join(tmpDir, 'test.sqlite'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeMockStoreClient(
    storeId: StoreId,
    catalog: CatalogProduct[],
    deliveryFee: number,
    slots: DeliverySlot[] = [],
  ): StoreClient {
    let items: CartState['items'] = [];
    let selectedSlot: DeliverySlot | null = null;
    return {
      storeId,
      meta: { ...STORE_META[storeId], defaultDeliveryFee: deliveryFee },
      searchProducts: vi.fn(async (query: string) => {
        const q = query.trim().toLowerCase();
        const exact = catalog.filter(
          (p) =>
            p.barcode === q ||
            p.code.toLowerCase() === q ||
            p.name.toLowerCase().includes(q),
        );
        return exact.length > 0 ? exact : catalog;
      }),
      getCartState: vi.fn(async () => ({
        storeId,
        items: [...items],
        totalPrice: Number(items.reduce((s, i) => s + i.itemPrice, 0).toFixed(2)),
        deliveryFee: selectedSlot?.deliveryFee ?? deliveryFee,
        orderInUpdateMode: null,
        isGuestSession: false,
      })),
      setItemsInCart: vi.fn(async (inputs) => {
        for (const inp of inputs) {
          const prod = catalog.find((p) => p.code === inp.productCode);
          const idx = items.findIndex((i) => i.productCode === inp.productCode);
          const entry = {
            entryNumber: idx >= 0 ? items[idx]!.entryNumber : items.length,
            productCode: inp.productCode,
            productName: prod?.name ?? inp.productCode,
            quantity: inp.quantity,
            itemPrice: Number(((prod?.price ?? 0) * inp.quantity).toFixed(2)),
            inStock: true,
            sellingMethod: inp.sellingMethod,
          };
          if (idx >= 0) items[idx] = entry;
          else items.push(entry);
        }
        return {
          storeId,
          items: [...items],
          totalPrice: Number(items.reduce((s, i) => s + i.itemPrice, 0).toFixed(2)),
          deliveryFee: selectedSlot?.deliveryFee ?? deliveryFee,
          orderInUpdateMode: null,
          isGuestSession: false,
        };
      }),
      updateCartItemQuantity: vi.fn(async (code, qty) => {
        const prod = catalog.find((p) => p.code === code);
        items = items.map((i) =>
          i.productCode === code
            ? {
                ...i,
                quantity: qty,
                itemPrice: Number(((prod?.price ?? 0) * qty).toFixed(2)),
              }
            : i,
        );
        return {
          storeId,
          items: [...items],
          totalPrice: Number(items.reduce((s, i) => s + i.itemPrice, 0).toFixed(2)),
          deliveryFee: selectedSlot?.deliveryFee ?? deliveryFee,
          orderInUpdateMode: null,
        };
      }),
      removeFromCart: vi.fn(async (code) => {
        items = items.filter((i) => i.productCode !== code);
        return {
          storeId,
          items: [...items],
          totalPrice: Number(items.reduce((s, i) => s + i.itemPrice, 0).toFixed(2)),
          deliveryFee: selectedSlot?.deliveryFee ?? deliveryFee,
          orderInUpdateMode: null,
        };
      }),
      clearCart: vi.fn(async () => {
        items = [];
      }),
      getAvailableTimeSlots: vi.fn(async () => slots),
      getSelectedTimeSlot: vi.fn(async () => selectedSlot),
      selectTimeSlot: vi.fn(async (slotCode: string) => {
        const match = slots.find((s) => s.code === slotCode);
        if (!match) throw new Error(`Slot ${slotCode} not found`);
        selectedSlot = match;
        return match;
      }),
      getActiveOrders: vi.fn(async () => []),
      putOrderInUpdateMode: vi.fn(async () => {
        throw new Error('not supported');
      }),
      placeOrder: vi.fn(async () => ({
        storeId,
        orderCode: `ORD-${storeId}`,
        deliveryIso: new Date().toISOString(),
        totalPrice: Number(items.reduce((s, i) => s + i.itemPrice, 0).toFixed(2)),
        wasOrderUpdate: false,
        removedOutOfStockCodes: [],
      })),
      isAuthenticated: () => true,
      shutdown: vi.fn(async () => {}),
    };
  }

  it('builds carts across Shufersal and Hazi Hinam, matches barcodes, and picks the cheapest cart', async () => {
    const barcode = '7290004127329';
    const shufersalClient = makeMockStoreClient(
      'shufersal',
      [
        {
          code: 'P_7290004127329',
          storeId: 'shufersal',
          barcode,
          name: "קוטג' תנובה 5%",
          brandName: 'תנובה',
          unitDescription: '250 גרם',
          sellingMethod: 'BY_UNIT',
          price: 7.2,
          formattedPrice: '₪7.20',
          pricePerUnitText: null,
          promotionMsg: null,
          inStock: true,
          purchasable: true,
          categoryName: 'גבינות',
          imageUrl: null,
        },
      ],
      29.9,
    );

    const haziClient = makeMockStoreClient(
      'hazi_hinam',
      [
        {
          code: '9999',
          storeId: 'hazi_hinam',
          barcode: '7299999999999',
          name: "קוטג' מותג פרטי 5%",
          brandName: 'אחר',
          unitDescription: '250 גרם',
          sellingMethod: 'BY_UNIT',
          price: 5.0,
          formattedPrice: '₪5.00',
          pricePerUnitText: null,
          promotionMsg: null,
          inStock: true,
          purchasable: true,
          categoryName: 'גבינות',
          imageUrl: null,
        },
        {
          code: '278017',
          storeId: 'hazi_hinam',
          barcode,
          name: "קוטג' תנובה 5%",
          brandName: 'תנובה',
          unitDescription: '250 גרם',
          sellingMethod: 'BY_UNIT',
          price: 5.9,
          formattedPrice: '₪5.90',
          pricePerUnitText: null,
          promotionMsg: null,
          inStock: true,
          purchasable: true,
          categoryName: 'גבינות',
          imageUrl: null,
        },
      ],
      29.9,
    );

    const multi = new MultiStoreManager(
      [new StoreManager(shufersalClient, db), new StoreManager(haziClient, db)],
      db,
    );

    const mockAi = {
      selectBestProduct: vi.fn(
        async (params: {
          request: ParsedGroceryItem;
          candidates: CatalogProduct[];
          preferredBarcode?: string | null;
        }) => {
          const match =
            (params.preferredBarcode
              ? params.candidates.find((c) => c.barcode === params.preferredBarcode)
              : undefined) ?? params.candidates[0]!;
          return {
            selected: match,
            adjustedQuantity: params.request.quantity,
            alternatives: params.candidates.filter((c) => c.code !== match.code),
          };
        },
      ),
    } as unknown as GroceryAiService;

    const chatId = -100555;
    const addRes = await multi.addItemAcrossStores({
      chatId,
      senderName: 'אלי',
      request: {
        rawText: "4 קוטג' תנובה 5%",
        searchQuery: "קוטג' תנובה 5%",
        action: 'add',
        quantity: 4,
        unitPreference: 'UNIT',
      },
      ai: mockAi,
    });

    expect(addRes.outcomes.every((o) => o.status === 'added')).toBe(true);
    expect(
      addRes.outcomes.find((o) => o.storeId === 'hazi_hinam')?.product?.code,
    ).toBe('278017');
    expect(addRes.cheapestItemStoreId).toBe('hazi_hinam');

    // Compare carts (Hazi Hinam: 23.60 + 29.90 = 53.50; Shufersal: 28.80 + 29.90 = 58.70)
    const comparison = await multi.compareCarts(chatId);
    expect(comparison.cheapestStoreId).toBe('hazi_hinam');
    expect(comparison.quotes.map((q) => q.storeId)).toEqual([
      'hazi_hinam',
      'shufersal',
    ]);
    expect(comparison.savingsVsSecondCheapest).toBe(5.2);
    expect(comparison.savingsVsMostExpensive).toBe(5.2);

    const html = renderComparisonHtml(comparison);
    expect(html).toContain('חצי חינם');
    expect(html).toContain('הזול ביותר');
    expect(html).toContain('₪5.20');

    const order = await multi.checkoutStore(chatId, comparison.cheapestStoreId!, {
      removeMissingItems: true,
    });
    expect(order.orderCode).toBe('ORD-hazi_hinam');

    const cleared = await multi.clearOtherStores(chatId, 'hazi_hinam');
    expect(cleared.map((c) => c.storeId)).toEqual(['shufersal']);
    expect(cleared.every((c) => c.ok)).toBe(true);
  });

  it('prefers full-coverage carts over cheaper partial carts missing items', () => {
    const quotes: StoreCartQuote[] = [
      {
        storeId: 'hazi_hinam',
        meta: STORE_META.hazi_hinam,
        cart: null,
        selectedSlot: null,
        inStockCount: 2,
        outOfStockCount: 0,
        expectedItemsCount: 5,
        missingItemsCount: 3,
        subtotal: 20,
        deliveryFee: 29.9,
        estimatedTotal: 49.9, // Cheaper only because 3 items are missing!
        belowMinimum: true,
        minimumOrderAmount: 200,
        isGuestSession: false,
        error: null,
      },
      {
        storeId: 'shufersal',
        meta: STORE_META.shufersal,
        cart: null,
        selectedSlot: null,
        inStockCount: 5,
        outOfStockCount: 0,
        expectedItemsCount: 5,
        missingItemsCount: 0,
        subtotal: 120,
        deliveryFee: 29.9,
        estimatedTotal: 149.9,
        belowMinimum: false,
        minimumOrderAmount: null,
        isGuestSession: false,
        error: null,
      },
    ];

    const ranked = rankStoreQuotes(quotes);
    expect(ranked.cheapestStoreId).toBe('shufersal');
    expect(ranked.quotes.map((q) => q.storeId)).toEqual([
      'shufersal',
      'hazi_hinam',
    ]);
  });

  it('migrates legacy single-store SQLite tables cleanly and isolates preferences per store', () => {
    const legacyPath = path.join(tmpDir, 'legacy.sqlite');
    const raw = new DatabaseSync(legacyPath);
    raw.exec(`
      CREATE TABLE product_cache (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        brand_name TEXT,
        unit_description TEXT,
        selling_method TEXT NOT NULL,
        price REAL NOT NULL,
        formatted_price TEXT NOT NULL,
        price_per_unit_text TEXT,
        promotion_msg TEXT,
        in_stock INTEGER NOT NULL DEFAULT 1,
        purchasable INTEGER NOT NULL DEFAULT 1,
        category_name TEXT,
        image_url TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE learned_preferences (
        normalized_query TEXT PRIMARY KEY,
        product_code TEXT NOT NULL,
        product_name TEXT NOT NULL,
        chosen_count INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE cart_contributors (
        chat_id INTEGER NOT NULL,
        product_code TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, product_code, sender_name)
      );
      INSERT INTO learned_preferences VALUES ('חלב', 'P_111', 'חלב שופרסל', 3, 1000);
    `);
    raw.close();

    const migrated = new BotDatabase(legacyPath);
    try {
      expect(migrated.getPreference('חלב', 'shufersal')?.productCode).toBe('P_111');
      expect(migrated.getPreference('חלב', 'hazi_hinam')).toBeNull();

      migrated.recordPreference('חלב', 'HH_222', 'חלב חצי חינם', 'hazi_hinam');
      expect(migrated.getPreference('חלב', 'shufersal')?.productCode).toBe('P_111');
      expect(migrated.getPreference('חלב', 'hazi_hinam')?.productCode).toBe('HH_222');
    } finally {
      migrated.close();
    }
  });

  it('mirrors a loaded Shufersal order to Hazi Hinam via barcode-first search and compares totals', async () => {
    const cottageBarcode = '7290004127329';
    const milkBarcode = '7290000000111';

    const shufersalClient = makeMockStoreClient('shufersal', [], 29.9);
    vi.mocked(shufersalClient.getCartState).mockImplementation(async () => ({
      storeId: 'shufersal',
      items: [
        {
          entryNumber: 0,
          productCode: `P_${cottageBarcode}`,
          productName: "קוטג' תנובה 5%",
          quantity: 3,
          itemPrice: 21.6,
          inStock: true,
          sellingMethod: 'BY_UNIT',
        },
        {
          entryNumber: 1,
          productCode: `P_${milkBarcode}`,
          productName: 'חלב תנובה 3%',
          quantity: 2,
          itemPrice: 13.6,
          inStock: true,
          sellingMethod: 'BY_UNIT',
        },
      ],
      totalPrice: 35.2,
      deliveryFee: 29.9,
      orderInUpdateMode: '900123',
    }));

    const haziCatalog: CatalogProduct[] = [
      {
        code: 'HH_COTTAGE',
        storeId: 'hazi_hinam',
        barcode: cottageBarcode,
        name: "קוטג' תנובה 5%",
        brandName: 'תנובה',
        unitDescription: '250 גרם',
        sellingMethod: 'BY_UNIT',
        price: 5.9,
        formattedPrice: '₪5.90',
        pricePerUnitText: null,
        promotionMsg: null,
        inStock: true,
        purchasable: true,
        categoryName: 'גבינות',
        imageUrl: null,
      },
      {
        code: 'HH_MILK',
        storeId: 'hazi_hinam',
        barcode: milkBarcode,
        name: 'חלב תנובה 3%',
        brandName: 'תנובה',
        unitDescription: '1 ליטר',
        sellingMethod: 'BY_UNIT',
        price: 6.2,
        formattedPrice: '₪6.20',
        pricePerUnitText: null,
        promotionMsg: null,
        inStock: true,
        purchasable: true,
        categoryName: 'חלב',
        imageUrl: null,
      },
    ];

    const haziClient = makeMockStoreClient('hazi_hinam', haziCatalog, 29.9);
    const multi = new MultiStoreManager(
      [new StoreManager(shufersalClient, db), new StoreManager(haziClient, db)],
      db,
    );

    const mockAi = {
      selectBestProduct: vi.fn(
        async (params: {
          request: ParsedGroceryItem;
          candidates: CatalogProduct[];
          preferredBarcode?: string | null;
        }) => {
          const match =
            (params.preferredBarcode
              ? params.candidates.find((c) => c.barcode === params.preferredBarcode)
              : undefined) ?? params.candidates[0]!;
          return {
            selected: match,
            adjustedQuantity: params.request.quantity,
            alternatives: [],
          };
        },
      ),
    } as unknown as GroceryAiService;

    const mirrorRes = await multi.mirrorCartToOtherStores({
      chatId: -100777,
      sourceStoreId: 'shufersal',
      senderName: 'אלי',
      ai: mockAi,
      clearTargetFirst: true,
    });

    expect(mirrorRes.sourceOrderInUpdateMode).toBe('900123');
    expect(mirrorRes.totalSourceItems).toBe(2);
    expect(mirrorRes.storeSummaries).toHaveLength(1);
    expect(mirrorRes.storeSummaries[0]?.storeId).toBe('hazi_hinam');
    expect(mirrorRes.storeSummaries[0]?.matchedCount).toBe(2);
    expect(mirrorRes.comparison.cheapestStoreId).toBe('hazi_hinam');
  });

  it('builds cleaned Hebrew fallback queries from verbose Shufersal product names', () => {
    const queries = buildMirrorSearchQueries("קוטג' 5% שומן תנובה 250 גרם");
    expect(queries[0]).toBe("קוטג' 5% תנובה");
    expect(queries.length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to Hazi Hinam guest session when OAuth credentials fail so price comparison still works', async () => {
    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/connect/token')) {
        return jsonResponse({ error: 'invalid_grant', error_description: 'wrong user name' }, 400);
      }
      if (url.endsWith('/proxy/init')) {
        return jsonResponse({
          Results: {
            AnonymousToken: { access_token: 'anon-guest-token-999999', expires_in: 3600 },
          },
        });
      }
      if (url.includes('/proxy/api/item/getItemsBySearch')) {
        return jsonResponse({
          Results: {
            Items: [
              {
                Id: 444,
                Name: 'חלב תנובה 3%',
                Price_Regular: 6.9,
                IsInStock: true,
              },
            ],
          },
        });
      }
      return jsonResponse({ IsOK: true });
    }) as unknown as typeof fetch;

    const client = new HaziHinamClient({
      username: 'bad@example.com',
      password: 'wrong',
      sessionFilePath: path.join(tmpDir, 'hazi-fallback.json'),
      fetchFn: mockFetch,
    });

    const prods = await client.searchProducts('חלב');
    expect(prods).toHaveLength(1);
    expect(client.isAuthenticated()).toBe(false);
    expect(client.getAuthWarning()).toContain('wrong user name');
  });

  it('offers delivery slot selection for both Shufersal and Hazi Hinam in /slots', async () => {
    const haziSlot: DeliverySlot = {
      code: 'HH_SLOT_1',
      startIso: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      endIso: null,
      startHourText: '10:00',
      endHourText: '12:00',
      deliveryFee: 24.9,
      selectable: true,
      isToday: false,
      rawSlot: { Id: 'HH_SLOT_1' },
    };

    const shufersalClient = makeMockStoreClient('shufersal', [], 29.9, []);
    const haziClient = makeMockStoreClient('hazi_hinam', [], 29.9, [haziSlot]);
    const multi = new MultiStoreManager(
      [new StoreManager(shufersalClient, db), new StoreManager(haziClient, db)],
      db,
    );

    const config: AppConfig = {
      telegramBotToken: '123456:TEST_TOKEN',
      allowedChatIds: [-100888],
      adminUserIds: [42],
      enabledStores: ['shufersal', 'hazi_hinam'],
      shufersalUsername: 'u',
      shufersalPassword: 'p',
      geminiApiKey: 'dummy',
      geminiModel: 'gemini-3.8-flash',
      headless: true,
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, 'test.sqlite'),
      sessionFilePath: path.join(tmpDir, 's.json'),
      haziHinamSessionFilePath: path.join(tmpDir, 'h.json'),
      screenshotsDir: tmpDir,
      autoRemoveOutOfStock: true,
    };

    const bot = createTelegramBot({
      config,
      db,
      stores: multi,
      ai: new GroceryAiService('dummy-key'),
    });

    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: 'TestBot',
      username: 'test_grocery_bot',
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
    };

    const editedMessages: Array<{ text: string; reply_markup?: unknown }> = [];
    bot.api.config.use(async (_prev, method, payload) => {
      if (method === 'sendMessage') {
        return {
          ok: true,
          result: {
            message_id: 1,
            date: Math.floor(Date.now() / 1000),
            chat: { id: -100888, type: 'supergroup' },
            text: (payload as { text: string }).text,
          },
        } as never;
      }
      if (method === 'editMessageText') {
        const p = payload as { text: string; reply_markup?: unknown };
        editedMessages.push({ text: p.text, reply_markup: p.reply_markup });
        return { ok: true, result: true } as never;
      }
      return { ok: true, result: true } as never;
    });

    // 1. `/slots` displays chooser with BOTH Shufersal and Hazi Hinam
    await bot.handleUpdate({
      update_id: 101,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -100888, type: 'supergroup', title: 'Test' },
        from: { id: 42, is_bot: false, first_name: 'Eli' },
        text: '/slots',
        entities: [{ offset: 0, length: 6, type: 'bot_command' }],
      },
    });

    expect(editedMessages[0]?.text).toContain('שופרסל');
    expect(editedMessages[0]?.text).toContain('חצי חינם');

    // 2. `/slots hazi` opens Hazi Hinam's delivery days directly
    await bot.handleUpdate({
      update_id: 102,
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -100888, type: 'supergroup', title: 'Test' },
        from: { id: 42, is_bot: false, first_name: 'Eli' },
        text: '/slots hazi',
        entities: [{ offset: 0, length: 6, type: 'bot_command' }],
      },
    });

    expect(editedMessages[1]?.text).toContain('חצי חינם אונליין');
    expect(haziClient.getAvailableTimeSlots).toHaveBeenCalledTimes(1);
  });

  it('extracts recommended Gemini replacement model from 404 deprecation errors', () => {
    const errMsg =
      'ApiError: {"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features and improvements.","status":"NOT_FOUND"}}';
    expect(extractRecommendedGeminiModel(errMsg)).toBe('gemini-3.8-flash');
  });

  it('rejects irrelevant single/multiple candidates in strictMatch mode when Gemini returns NO_MATCH or fails', async () => {
    const ai = new GroceryAiService('fake-key', 'gemini-3.8-flash');
    const unrelatedCandidate: CatalogProduct = {
      code: '999',
      storeId: 'hazi_hinam',
      barcode: null,
      name: 'מרק עוף אינסטנט אוסם',
      brandName: 'אוסם',
      unitDescription: '400 גרם',
      sellingMethod: 'BY_UNIT',
      price: 15.9,
      formattedPrice: '₪15.90',
      pricePerUnitText: null,
      promotionMsg: null,
      inStock: true,
      purchasable: true,
      categoryName: 'מרקים',
      imageUrl: null,
    };

    const mockGenerate = vi.fn(async () => ({
      text: JSON.stringify({
        selectedCode: 'NO_MATCH',
        adjustedQuantity: 1,
        reason: 'מרק עוף אינו קישוא טרי',
      }),
    }));
    (ai as unknown as { ai: { models: { generateContent: typeof mockGenerate } } }).ai = {
      models: { generateContent: mockGenerate },
    };

    const res = await ai.selectBestProduct({
      request: {
        rawText: 'קישוא ארוז',
        searchQuery: 'קישוא ארוז',
        action: 'set',
        quantity: 1,
        unitPreference: 'UNIT',
      },
      candidates: [unrelatedCandidate],
      strictMatch: true,
    });
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(res.selected).toBeNull();

    mockGenerate.mockRejectedValueOnce(new Error('network error'));
    const fallbackRes = await ai.selectBestProduct({
      request: {
        rawText: 'קישוא ארוז',
        searchQuery: 'קישוא ארוז',
        action: 'set',
        quantity: 1,
        unitPreference: 'UNIT',
      },
      candidates: [unrelatedCandidate],
      strictMatch: true,
    });
    expect(fallbackRes.selected).toBeNull();
  });

  it('uses fast local Hebrew matching without burning Gemini quota and activates 429 quota cooldown', async () => {
    expect(extractRetryDelayMs('"retryDelay":"44540s"')).toBe(44_540_000);
    expect(extractRetryDelayMs('Please retry in 12h22m20s.')).toBe(
      (12 * 3600 + 22 * 60 + 20) * 1000,
    );

    const ai = new GroceryAiService('dummy-key', 'gemini-3.8-flash');
    const mockGenerate = vi.fn(async () => {
      throw new Error(
        '429 RESOURCE_EXHAUSTED quota exceeded. "retryDelay":"44540s"',
      );
    });
    (
      ai as unknown as {
        ai: { models: { generateContent: typeof mockGenerate } };
      }
    ).ai = {
      models: { generateContent: mockGenerate },
    };

    const localRes = await ai.selectBestProduct({
      request: {
        rawText: "קוטג' 5% תנובה",
        searchQuery: "קוטג' 5% תנובה",
        action: 'set',
        quantity: 2,
        unitPreference: 'UNIT',
      },
      candidates: [
        {
          code: '100',
          storeId: 'hazi_hinam',
          barcode: null,
          name: "קוטג' 5% תנובה 250 גרם",
          brandName: 'תנובה',
          unitDescription: '250 גרם',
          sellingMethod: 'BY_UNIT',
          price: 6.5,
          formattedPrice: '₪6.50',
          pricePerUnitText: null,
          promotionMsg: null,
          inStock: true,
          purchasable: true,
          categoryName: null,
          imageUrl: null,
        },
        {
          code: '101',
          storeId: 'hazi_hinam',
          barcode: null,
          name: 'גבינה לבנה 9% שטראוס',
          brandName: 'שטראוס',
          unitDescription: '250 גרם',
          sellingMethod: 'BY_UNIT',
          price: 7.2,
          formattedPrice: '₪7.20',
          pricePerUnitText: null,
          promotionMsg: null,
          inStock: true,
          purchasable: true,
          categoryName: null,
          imageUrl: null,
        },
      ],
      strictMatch: true,
    });
    expect(localRes.selected?.code).toBe('100');
    expect(mockGenerate).not.toHaveBeenCalled();

    const parsed1 = await ai.parseGroupMessage('תוסיפו 2 חלב תנובה, תורידו קוטג');
    expect(ai.isQuotaExhausted()).toBe(true);
    expect(parsed1.isGroceryRelated).toBe(true);
    expect(parsed1.items[0]?.quantity).toBe(2);
    expect(parsed1.items[0]?.searchQuery).toBe('חלב תנובה');
    expect(parsed1.items[1]?.action).toBe('remove');

    const callsAfterFirst429 = mockGenerate.mock.calls.length;
    const greeting = await ai.parseGroupMessage('בוקר טוב');
    expect(greeting.isGroceryRelated).toBe(false);
    expect(mockGenerate.mock.calls.length).toBe(callsAfterFirst429);
  });

  it('loads real Hazi Hinam getNextDeliveries Addresses/Stores ShipmentsByDate, cartSummary, and ChangeDraftOrderShipping', async () => {
    const sessionFilePath = path.join(tmpDir, 'hazi-real-api-session.json');
    let draftShippingCall: { url: string; body: Record<string, unknown> } | null = null;
    let clearCartDeleted = false;

    const mockFetch: typeof fetch = vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.includes('/connect/token')) {
        return new Response(
          JSON.stringify({ access_token: 'hazi-real-token', expires_in: 7200 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url.includes('/proxy/api/delivery/getNextDeliveries')) {
        return new Response(
          JSON.stringify({
            IsOK: true,
            Results: {
              Addresses: [
                {
                  Id: 101,
                  Name: 'חיפה, הרצל 1',
                  IsDefault: false,
                  ShipmentsByDate: [],
                },
                {
                  Id: 202,
                  Name: 'ירושלים, יפו 15',
                  IsDefault: true,
                  ShipmentsByDate: [
                    {
                      Date: '28/11/2026',
                      DOW: 'שבת',
                      Shipments: [
                        {
                          ShipmentId: 9001,
                          IsClosedShipment: true,
                          Time: { From: '08:00', To: '10:00' },
                        },
                      ],
                    },
                    {
                      Date: '29/11/2026',
                      DOW: 'ראשון',
                      Shipments: [
                        {
                          ShipmentId: 9002,
                          IsClosedShipment: false,
                          Time: { From: '10:00', To: '12:00' },
                          Price: 29.9,
                        },
                        {
                          ShipmentId: 9003,
                          IsClosedShipment: false,
                          Time: { From: '16:00', To: '18:00' },
                          Price: 24.9,
                        },
                      ],
                    },
                  ],
                },
              ],
              Stores: [],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url.includes('/proxy/api/item/getItemsInCart')) {
        return new Response(
          JSON.stringify({
            IsOK: true,
            Results: {
              CartItems: [
                {
                  ItemId: 777,
                  Name: 'לחם אחיד פרוס',
                  Quantity: 2,
                  Price_NET: 8.5,
                  IsInStock: true,
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url.includes('/proxy/api/order/cartSummary')) {
        return new Response(
          JSON.stringify({
            IsOK: true,
            Results: {
              CartSummary: {
                Price_Order_Total: 17.0,
                Price_Shipping: 29.9,
                Minimum_Cart_Price_NET: 200,
                Order_Draft_Id: 5544,
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url.includes('/proxy/api/order/ChangeDraftOrderShipping')) {
        draftShippingCall = {
          url,
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        };
        return new Response(JSON.stringify({ IsOK: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.includes('/proxy/api/item/removeItemsInCart') && method === 'DELETE') {
        clearCartDeleted = true;
        return new Response(JSON.stringify({ IsOK: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.includes('/proxy/api/order/history')) {
        return new Response(
          JSON.stringify({
            IsOK: true,
            Results: {
              Orders: [
                {
                  OrderId: 6601,
                  ShipmentDate: '30/11/2026',
                  Time: { From: '12:00', To: '14:00' },
                  Price_Order_Total: 312.5,
                  ItemsCount: 18,
                  StatusName: 'התקבלה',
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      return new Response(JSON.stringify({ IsOK: false }), { status: 404 });
    });

    const client = new HaziHinamClient({
      username: 'eli@example.com',
      password: 'secret',
      sessionFilePath,
      fetchFn: mockFetch,
    });

    const cart = await client.getCartState();
    expect(cart.items).toHaveLength(1);
    expect(cart.totalPrice).toBe(17);
    expect(cart.deliveryFee).toBe(29.9);

    const slots = await client.getAvailableTimeSlots();
    expect(slots).toHaveLength(2);
    expect(slots.map((s) => s.code)).toEqual(['9002', '9003']);
    expect(slots[0]?.startHourText).toBe('10:00');
    expect(slots[0]?.endHourText).toBe('12:00');
    expect(slots[0]?.rawSlot['AddressName']).toBe('ירושלים, יפו 15');
    expect(slots[0]?.rawSlot['AddressId']).toBe(202);

    const chosen = await client.selectTimeSlot('9003');
    expect(chosen.code).toBe('9003');
    expect(chosen.deliveryFee).toBe(24.9);
    expect(draftShippingCall).not.toBeNull();
    expect(draftShippingCall!.url).toContain('Id=5544');
    expect(draftShippingCall!.body).toEqual({
      Object: { AddressId: 202, StoreId: null, ShipmentId: 9003 },
    });

    const orders = await client.getActiveOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]?.code).toBe('6601');
    expect(orders[0]?.deliveryHoursText).toBe('12:00–14:00');

    await client.clearCart();
    expect(clearCartDeleted).toBe(true);

    // Pickup store fallback when Addresses has no open slots
    const pickupSlots = parseHaziHinamDeliverySlots(
      {
        IsOK: true,
        Results: {
          Addresses: [],
          Stores: [
            {
              Id: 7,
              Name: 'חצי חינם חולון',
              ShipmentsByDate: [
                {
                  Date: '01/12/2026',
                  DOW: 'שלישי',
                  Shipments: [
                    {
                      ShipmentId: 8801,
                      IsClosedShipment: false,
                      Time: { From: '14:00', To: '16:00' },
                      Price: 0,
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      29.9,
    );
    expect(pickupSlots).toHaveLength(1);
    expect(pickupSlots[0]?.code).toBe('8801');
    expect(pickupSlots[0]?.rawSlot['IsSelfPickUp']).toBe(true);
    expect(pickupSlots[0]?.rawSlot['StoreName']).toBe('חצי חינם חולון');
    expect(pickupSlots[0]?.deliveryFee).toBe(0);
  });

  it('supports full Telegram /slots and /compare delivery slot selection flow for Hazi Hinam', async () => {
    const shufersalSlot: DeliverySlot = {
      code: 'SHUF-1',
      startIso: '2026-12-01T08:00:00.000Z',
      endIso: '2026-12-01T10:00:00.000Z',
      startHourText: '10:00',
      endHourText: '12:00',
      deliveryFee: 29.9,
      selectable: true,
      isToday: false,
      rawSlot: {},
    };
    const haziSlot: DeliverySlot = {
      code: '9002',
      startIso: '2026-12-02T08:00:00.000Z',
      endIso: '2026-12-02T10:00:00.000Z',
      startHourText: '10:00',
      endHourText: '12:00',
      deliveryFee: 24.9,
      selectable: true,
      isToday: false,
      rawSlot: {
        AddressId: 202,
        AddressName: 'ירושלים, יפו 15',
        IsSelfPickUp: false,
      },
    };

    const shufersalClient = makeMockStoreClient('shufersal', [], 29.9, [shufersalSlot]);
    const haziClient = makeMockStoreClient('hazi_hinam', [], 29.9, [haziSlot]);
    const multi = new MultiStoreManager(
      [new StoreManager(shufersalClient, db), new StoreManager(haziClient, db)],
      db,
    );

    const apiCalls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const bot = createTelegramBot({
      config: {
        telegramBotToken: '123456:TEST_TOKEN',
        geminiApiKey: 'dummy',
        geminiModel: 'gemini-3.8-flash',
        enabledStores: ['shufersal', 'hazi_hinam'],
        shufersalUsername: 'u',
        shufersalPassword: 'p',
        allowedChatIds: [-100555],
        adminUserIds: [111],
        autoRemoveOutOfStock: true,
        headless: true,
        dataDir: tmpDir,
        dbPath: path.join(tmpDir, 'test.sqlite'),
        sessionFilePath: path.join(tmpDir, 'shuf.json'),
        haziHinamSessionFilePath: path.join(tmpDir, 'hazi.json'),
        screenshotsDir: tmpDir,
      } as AppConfig,
      db,
      stores: multi,
      ai: new GroceryAiService('dummy-key', 'gemini-3.8-flash'),
    });

    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: 'TestBot',
      username: 'test_bot',
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    };

    let nextMsgId = 100;
    bot.api.config.use(async (_prev, method, payload) => {
      apiCalls.push({ method, payload: payload as Record<string, unknown> });
      if (method === 'sendMessage') {
        return {
          ok: true,
          result: {
            message_id: ++nextMsgId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: -100555, type: 'supergroup', title: 'Family' },
            text: String((payload as Record<string, unknown>)['text'] ?? ''),
          },
        } as never;
      }
      return { ok: true, result: true } as never;
    });

    const extractButtons = (
      call: { payload: Record<string, unknown> } | undefined,
    ): Array<{ text: string; callback_data?: string }> => {
      const markup = call?.payload['reply_markup'] as
        | { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> }
        | undefined;
      return markup?.inline_keyboard?.flat() ?? [];
    };

    // 1. User sends /slots -> chooser shows both Shufersal and Hazi Hinam
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -100555, type: 'supergroup', title: 'Family' },
        from: { id: 111, is_bot: false, first_name: 'Eli' },
        text: '/slots',
        entities: [{ offset: 0, length: 6, type: 'bot_command' }],
      },
    });

    const chooserCall = [...apiCalls].reverse().find((c) => c.method === 'editMessageText');
    const chooserButtons = extractButtons(chooserCall);
    const haziSlotsBtn = chooserButtons.find((b) => b.text.includes('חצי חינם'));
    expect(haziSlotsBtn?.callback_data).toMatch(/^a:/);

    // 2. Click Hazi Hinam slots button -> shows delivery address + day picker
    await bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: 'cb-1',
        from: { id: 111, is_bot: false, first_name: 'Eli' },
        chat_instance: 'ci-1',
        data: haziSlotsBtn!.callback_data!,
        message: {
          message_id: 101,
          date: Math.floor(Date.now() / 1000),
          chat: { id: -100555, type: 'supergroup', title: 'Family' },
          text: '',
        },
      },
    });

    const dayPickerCall = [...apiCalls].reverse().find((c) => c.method === 'editMessageText');
    expect(String(dayPickerCall?.payload['text'])).toContain('ירושלים, יפו 15');
    const dayBtn = extractButtons(dayPickerCall).find((b) => b.text.includes('חלונות'));
    expect(dayBtn?.callback_data).toMatch(/^a:/);

    // 3. Click day button -> shows Hazi Hinam hour button
    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: 'cb-2',
        from: { id: 111, is_bot: false, first_name: 'Eli' },
        chat_instance: 'ci-1',
        data: dayBtn!.callback_data!,
        message: {
          message_id: 101,
          date: Math.floor(Date.now() / 1000),
          chat: { id: -100555, type: 'supergroup', title: 'Family' },
          text: '',
        },
      },
    });

    const hourPickerCall = [...apiCalls].reverse().find((c) => c.method === 'editMessageText');
    const hourBtn = extractButtons(hourPickerCall).find((b) => b.text.includes('10:00–12:00'));
    expect(hourBtn?.callback_data).toMatch(/^a:/);

    // 4. Click hour button -> reserves Hazi Hinam slot
    await bot.handleUpdate({
      update_id: 4,
      callback_query: {
        id: 'cb-3',
        from: { id: 111, is_bot: false, first_name: 'Eli' },
        chat_instance: 'ci-1',
        data: hourBtn!.callback_data!,
        message: {
          message_id: 101,
          date: Math.floor(Date.now() / 1000),
          chat: { id: -100555, type: 'supergroup', title: 'Family' },
          text: '',
        },
      },
    });

    const confirmCall = [...apiCalls].reverse().find((c) => c.method === 'editMessageText');
    expect(String(confirmCall?.payload['text'])).toContain('חצי חינם אונליין');
    expect((await haziClient.getSelectedTimeSlot())?.code).toBe('9002');

    // 5. /compare also exposes a direct one-click Hazi Hinam slot button
    await bot.handleUpdate({
      update_id: 5,
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -100555, type: 'supergroup', title: 'Family' },
        from: { id: 111, is_bot: false, first_name: 'Eli' },
        text: '/compare',
        entities: [{ offset: 0, length: 8, type: 'bot_command' }],
      },
    });

    const compareCall = [...apiCalls].reverse().find((c) => c.method === 'editMessageText');
    const compareButtons = extractButtons(compareCall);
    expect(compareButtons.some((b) => b.text.includes('משלוח חצי חינם'))).toBe(true);
    expect(compareButtons.some((b) => b.text.includes('משלוח שופרסל'))).toBe(true);
  });

  it('parses target store directives in /add commands and natural Hebrew without breaking brand names', () => {
    expect(extractTargetStoreFromCommand('שופרסל 2 חלב תנובה 3%')).toEqual({
      storeId: 'shufersal',
      remainder: '2 חלב תנובה 3%',
    });
    expect(extractTargetStoreFromCommand("חצי חינם קוטג' 5%")).toEqual({
      storeId: 'hazi_hinam',
      remainder: "קוטג' 5%",
    });
    expect(extractTargetStoreFromCommand('hazi חצי קילו עגבניות')).toEqual({
      storeId: 'hazi_hinam',
      remainder: 'חצי קילו עגבניות',
    });
    expect(extractTargetStoreFromCommand('2 חלב לחצי חינם')).toEqual({
      storeId: 'hazi_hinam',
      remainder: '2 חלב',
    });
    expect(extractTargetStoreFromCommand("קוטג' 5%")).toEqual({
      storeId: null,
      remainder: "קוטג' 5%",
    });

    // Natural text: explicit prepositions target the store; bare brand name stays untouched
    expect(extractTargetStoreFromNaturalText('תוסיפו 2 חלב רק בחצי חינם')).toEqual({
      storeId: 'hazi_hinam',
      cleanedText: 'תוסיפו 2 חלב',
    });
    expect(extractTargetStoreFromNaturalText('ביצים לשופרסל')).toEqual({
      storeId: 'shufersal',
      cleanedText: 'ביצים',
    });
    expect(extractTargetStoreFromNaturalText('חצי חינם: חלב, ביצים')).toEqual({
      storeId: 'hazi_hinam',
      cleanedText: 'חלב, ביצים',
    });
    expect(extractTargetStoreFromNaturalText('חלב שופרסל 3%')).toEqual({
      storeId: undefined,
      cleanedText: 'חלב שופרסל 3%',
    });
  });

  it('adds products to a specific store via /add <store>, interactive /add chooser, and natural text', async () => {
    const shufMilk: CatalogProduct = {
      code: 'SHUF-MILK',
      storeId: 'shufersal',
      barcode: '7290000001111',
      name: 'חלב תנובה 3%',
      brandName: 'תנובה',
      unitDescription: '1 ליטר',
      sellingMethod: 'BY_UNIT',
      price: 7.2,
      formattedPrice: '₪7.20',
      pricePerUnitText: null,
      promotionMsg: null,
      inStock: true,
      purchasable: true,
      categoryName: 'חלב',
      imageUrl: null,
    };
    const shufCottage: CatalogProduct = {
      ...shufMilk,
      code: 'SHUF-COT',
      barcode: '7290000002222',
      name: "קוטג' תנובה 5%",
      price: 6.9,
      formattedPrice: '₪6.90',
    };
    const haziMilk: CatalogProduct = {
      ...shufMilk,
      code: 'HAZI-MILK',
      storeId: 'hazi_hinam',
      price: 6.5,
      formattedPrice: '₪6.50',
    };
    const haziCottage: CatalogProduct = {
      ...shufCottage,
      code: 'HAZI-COT',
      storeId: 'hazi_hinam',
      price: 6.1,
      formattedPrice: '₪6.10',
    };

    const shufersalClient = makeMockStoreClient(
      'shufersal',
      [shufMilk, shufCottage],
      29.9,
    );
    const haziClient = makeMockStoreClient(
      'hazi_hinam',
      [haziMilk, haziCottage],
      29.9,
    );
    const multi = new MultiStoreManager(
      [new StoreManager(shufersalClient, db), new StoreManager(haziClient, db)],
      db,
    );

    const ai = new GroceryAiService('dummy-key', 'gemini-3.8-flash');
    // Force local fallback parser so test runs deterministically without hitting live Gemini
    (
      ai as unknown as {
        ai: { models: { generateContent: () => Promise<never> } };
      }
    ).ai = {
      models: {
        generateContent: vi.fn(async () => {
          throw new Error('503 UNAVAILABLE');
        }),
      },
    };

    const apiCalls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const bot = createTelegramBot({
      config: {
        telegramBotToken: '123456:TEST_TOKEN',
        geminiApiKey: 'dummy',
        geminiModel: 'gemini-3.8-flash',
        enabledStores: ['shufersal', 'hazi_hinam'],
        shufersalUsername: 'u',
        shufersalPassword: 'p',
        allowedChatIds: [-100555],
        adminUserIds: [111],
        autoRemoveOutOfStock: true,
        headless: true,
        dataDir: tmpDir,
        dbPath: path.join(tmpDir, 'test.sqlite'),
        sessionFilePath: path.join(tmpDir, 'shuf.json'),
        haziHinamSessionFilePath: path.join(tmpDir, 'hazi.json'),
        screenshotsDir: tmpDir,
      } as AppConfig,
      db,
      stores: multi,
      ai,
    });

    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: 'TestBot',
      username: 'test_bot',
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    };

    let nextMsgId = 200;
    bot.api.config.use(async (_prev, method, payload) => {
      apiCalls.push({ method, payload: payload as Record<string, unknown> });
      if (method === 'sendMessage') {
        return {
          ok: true,
          result: {
            message_id: ++nextMsgId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: -100555, type: 'supergroup', title: 'Family' },
            text: String((payload as Record<string, unknown>)['text'] ?? ''),
          },
        } as never;
      }
      return { ok: true, result: true } as never;
    });

    const extractButtons = (
      call: { payload: Record<string, unknown> } | undefined,
    ): Array<{ text: string; callback_data?: string }> => {
      const markup = call?.payload['reply_markup'] as
        | { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> }
        | undefined;
      return markup?.inline_keyboard?.flat() ?? [];
    };

    // 1. Direct command: /add חצי חינם 2 חלב תנובה 3% -> adds ONLY to Hazi Hinam
    await bot.handleUpdate({
      update_id: 10,
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -100555, type: 'supergroup', title: 'Family' },
        from: { id: 111, is_bot: false, first_name: 'Eli' },
        text: '/add חצי חינם 2 חלב תנובה 3%',
        entities: [{ offset: 0, length: 4, type: 'bot_command' }],
      },
    });

    expect((await haziClient.getCartState()).items).toHaveLength(1);
    expect((await haziClient.getCartState()).items[0]?.productCode).toBe('HAZI-MILK');
    expect((await haziClient.getCartState()).items[0]?.quantity).toBe(2);
    expect((await shufersalClient.getCartState()).items).toHaveLength(0);
    const directCard = [...apiCalls].reverse().find((c) => c.method === 'editMessageText');
    expect(String(directCard?.payload['text'])).toContain('חצי חינם אונליין');

    // 2. Interactive command: /add קוטג' תנובה 5% -> shows store chooser -> click Shufersal
    await bot.handleUpdate({
      update_id: 11,
      message: {
        message_id: 11,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -100555, type: 'supergroup', title: 'Family' },
        from: { id: 111, is_bot: false, first_name: 'Eli' },
        text: "/add קוטג' תנובה 5%",
        entities: [{ offset: 0, length: 4, type: 'bot_command' }],
      },
    });

    const chooserCall = [...apiCalls].reverse().find((c) => c.method === 'sendMessage');
    const chooserBtns = extractButtons(chooserCall);
    const shufBtn = chooserBtns.find((b) => b.text.includes('שופרסל'));
    expect(shufBtn?.callback_data).toMatch(/^a:/);
    expect(chooserBtns.some((b) => b.text.includes('חצי חינם'))).toBe(true);

    await bot.handleUpdate({
      update_id: 12,
      callback_query: {
        id: 'cb-add-shuf',
        from: { id: 111, is_bot: false, first_name: 'Eli' },
        chat_instance: 'ci-add',
        data: shufBtn!.callback_data!,
        message: {
          message_id: nextMsgId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: -100555, type: 'supergroup', title: 'Family' },
          text: '',
        },
      },
    });

    expect((await shufersalClient.getCartState()).items).toHaveLength(1);
    expect((await shufersalClient.getCartState()).items[0]?.productCode).toBe('SHUF-COT');
    // Hazi Hinam still only has the milk from step 1
    expect((await haziClient.getCartState()).items).toHaveLength(1);

    // 3. Natural language free-text: "תוסיפו קוטג' תנובה 5% רק בחצי חינם"
    await bot.handleUpdate({
      update_id: 13,
      message: {
        message_id: 13,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -100555, type: 'supergroup', title: 'Family' },
        from: { id: 111, is_bot: false, first_name: 'Eli' },
        text: "תוסיפו קוטג' תנובה 5% רק בחצי חינם",
      },
    });

    expect((await haziClient.getCartState()).items.map((i) => i.productCode)).toEqual([
      'HAZI-MILK',
      'HAZI-COT',
    ]);
    // Shufersal was NOT touched by the Hazi-only message
    expect((await shufersalClient.getCartState()).items).toHaveLength(1);
    expect((await shufersalClient.getCartState()).items[0]?.quantity).toBe(1);
  });
});
