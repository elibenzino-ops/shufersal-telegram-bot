import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroceryAiService, ParsedGroceryItem } from '../src/ai/groceryAi.js';
import { renderComparisonHtml } from '../src/bot/telegramBot.js';
import { parseEnabledStores } from '../src/config.js';
import { BotDatabase } from '../src/store/database.js';
import {
  HaziHinamClient,
  parseHaziHinamCartResponse,
  parseHaziHinamProduct,
} from '../src/stores/haziHinamClient.js';
import {
  MultiStoreManager,
  rankStoreQuotes,
} from '../src/stores/multiStoreManager.js';
import { StoreManager } from '../src/stores/storeManager.js';
import {
  SuperHavivClient,
  parseSelfPointCart,
  parseSelfPointProduct,
} from '../src/stores/superHavivClient.js';
import {
  STORE_META,
  StoreManualVerificationRequiredError,
  type CartState,
  type CatalogProduct,
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
  it('enables all 3 stores by default when Shufersal credentials exist, and omits Shufersal when absent', () => {
    expect(parseEnabledStores(undefined, true)).toEqual([
      'shufersal',
      'hazi_hinam',
      'super_haviv',
    ]);
    expect(parseEnabledStores(undefined, false)).toEqual([
      'hazi_hinam',
      'super_haviv',
    ]);
  });

  it('supports English and Hebrew store aliases', () => {
    expect(parseEnabledStores('שופרסל, חצי חינם, חביב', true)).toEqual([
      'shufersal',
      'hazi_hinam',
      'super_haviv',
    ]);
    expect(parseEnabledStores('hazi,haviv', false)).toEqual([
      'hazi_hinam',
      'super_haviv',
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

  it('authenticates via OAuth2, searches, adds to cart, and returns checkout handoff link', async () => {
    const serverCartItems: Array<Record<string, unknown>> = [];

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

      return jsonResponse({ IsOK: true });
    }) as unknown as typeof fetch;

    const client = new HaziHinamClient({
      username: 'user@example.com',
      password: 'secret',
      sessionFilePath: path.join(tmpDir, 'hazi-session.json'),
      fetchFn: mockFetch,
    });

    const products = await client.searchProducts("קוטג' 5%");
    expect(products).toHaveLength(1);
    expect(products[0]?.code).toBe('1001');

    const cart = await client.setItemsInCart([
      { productCode: '1001', quantity: 2, sellingMethod: 'BY_UNIT' },
    ]);
    expect(cart.items).toHaveLength(1);
    expect(cart.totalPrice).toBe(12.4);
    expect(cart.isGuestSession).toBe(false);

    // Checkout raises manual checkout handoff with direct link to Hazi Hinam cart
    await expect(
      client.placeOrder({ removeMissingItems: true }),
    ).rejects.toBeInstanceOf(StoreManualVerificationRequiredError);
  });

  it('parses Hazi Hinam cart responses with nested items', () => {
    const parsed = parseHaziHinamCartResponse(
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
    expect(parsed?.totalPrice).toBe(20.4);
    expect(parsed?.deliveryFee).toBe(29.9);
  });
});

describe('SuperHavivClient (Self-Point / Prutah)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haviv-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses Self-Point products using row id (retailerProductId) and sale price', () => {
    const prod = parseSelfPointProduct({
      id: 20230801,
      branchProductId: 99999999,
      localName: "קוטג' 5% תנובה 250 גרם",
      gtin: '7290004127329',
      brand: { names: { '1': 'תנובה' } },
      weight: 250,
      unitOfMeasure: 'גרם',
      isWeighable: false,
      branch: {
        regularPrice: 6.5,
        salePrice: 5.9,
        isActive: true,
        isVisible: true,
        isOutOfStock: false,
      },
      family: { name: 'גבינות לבנות' },
    });

    expect(prod).not.toBeNull();
    expect(prod?.code).toBe('20230801'); // Must be row id, not branchProductId!
    expect(prod?.storeId).toBe('super_haviv');
    expect(prod?.barcode).toBe('7290004127329');
    expect(prod?.price).toBe(5.9);
    expect(prod?.brandName).toBe('תנובה');
    expect(prod?.unitDescription).toBe('250 גרם');
  });

  it('searches Super Haviv v2 API and builds a real Self-Point cart', async () => {
    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/v2/retailers/1579/branches/3507/products')) {
        return jsonResponse({
          products: [
            {
              id: 20230801,
              localName: "קוטג' 5%",
              gtin: '7290004127329',
              branch: {
                regularPrice: 6.5,
                salePrice: 0,
                isActive: true,
                isVisible: true,
                isOutOfStock: false,
              },
            },
          ],
        });
      }

      if (url.includes('/v2/retailers/1579/branches/3507/carts') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}')) as {
          lines: Array<{ retailerProductId: number; quantity: number }>;
        };
        const subtotal = body.lines.reduce((s, l) => s + l.quantity * 6.5, 0);
        return jsonResponse({
          id: 'haviv-cart-abc',
          lines: body.lines.map((l) => ({
            retailerProductId: l.retailerProductId,
            quantity: l.quantity,
            isActive: true,
            totalPrice: Number((l.quantity * 6.5).toFixed(2)),
            product: { id: l.retailerProductId, localName: "קוטג' 5%" },
          })),
          total: { priceForView: subtotal },
        });
      }

      if (url.includes('/areas')) {
        return jsonResponse([{ id: 1, name: 'פתח תקווה', deliveryAreaPrice: 34 }]);
      }

      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = new SuperHavivClient({
      headless: true,
      sessionFilePath: path.join(tmpDir, 'haviv-session.json'),
      screenshotsDir: tmpDir,
      fetchFn: mockFetch,
    });

    const found = await client.searchProducts("קוטג'");
    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe('20230801');

    const cart = await client.setItemsInCart([
      { productCode: '20230801', quantity: 3, sellingMethod: 'BY_UNIT' },
    ]);
    expect(cart.items).toHaveLength(1);
    expect(cart.totalPrice).toBe(19.5);
    expect(cart.deliveryFee).toBe(34);
  });

  it('parses Self-Point cart object map lines as returned by Angular Cart service', () => {
    const cart = parseSelfPointCart(
      {
        lines: {
          '20230801': {
            quantity: 2,
            product: {
              id: 20230801,
              localName: 'חלב 3%',
              branch: { regularPrice: 7.35, salePrice: 0 },
            },
          },
        },
        total: { priceForView: 14.7 },
      },
      34,
      false,
    );
    expect(cart.items).toHaveLength(1);
    expect(cart.totalPrice).toBe(14.7);
  });
});

describe('rankStoreQuotes & MultiStoreManager', () => {
  let tmpDir: string;
  let db: BotDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-store-test-'));
    db = new BotDatabase(path.join(tmpDir, 'bot.sqlite'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeMockStoreClient(
    storeId: StoreId,
    catalog: CatalogProduct[],
    deliveryFee: number,
  ): StoreClient {
    let items: CartState['items'] = [];
    const meta = { ...STORE_META[storeId], defaultDeliveryFee: deliveryFee };

    return {
      storeId,
      meta,
      searchProducts: vi.fn(async () => catalog),
      getCartState: vi.fn(async (): Promise<CartState> => ({
        storeId,
        items: [...items],
        totalPrice: Number(items.reduce((s, i) => s + i.itemPrice, 0).toFixed(2)),
        deliveryFee,
        orderInUpdateMode: null,
      })),
      setItemsInCart: vi.fn(async (inputs): Promise<CartState> => {
        for (const inp of inputs) {
          const prod = catalog.find((c) => c.code === inp.productCode);
          const price = prod?.price ?? 10;
          const idx = items.findIndex((i) => i.productCode === inp.productCode);
          const entry = {
            entryNumber: idx >= 0 ? items[idx]!.entryNumber : items.length,
            productCode: inp.productCode,
            productName: prod?.name,
            quantity: inp.quantity,
            itemPrice: Number((price * inp.quantity).toFixed(2)),
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
          deliveryFee,
          orderInUpdateMode: null,
        };
      }),
      updateCartItemQuantity: vi.fn(async (code, qty) => {
        const prod = catalog.find((c) => c.code === code);
        const price = prod?.price ?? 10;
        items = items.map((i) =>
          i.productCode === code
            ? { ...i, quantity: qty, itemPrice: Number((price * qty).toFixed(2)) }
            : i,
        );
        return {
          storeId,
          items: [...items],
          totalPrice: Number(items.reduce((s, i) => s + i.itemPrice, 0).toFixed(2)),
          deliveryFee,
          orderInUpdateMode: null,
        };
      }),
      removeFromCart: vi.fn(async (code) => {
        items = items.filter((i) => i.productCode !== code);
        return {
          storeId,
          items: [...items],
          totalPrice: Number(items.reduce((s, i) => s + i.itemPrice, 0).toFixed(2)),
          deliveryFee,
          orderInUpdateMode: null,
        };
      }),
      clearCart: vi.fn(async () => {
        items = [];
      }),
      getAvailableTimeSlots: vi.fn(async () => []),
      getSelectedTimeSlot: vi.fn(async () => null),
      selectTimeSlot: vi.fn(async () => {
        throw new Error('no slots');
      }),
      getActiveOrders: vi.fn(async () => []),
      putOrderInUpdateMode: vi.fn(async () => {
        throw new Error('unsupported');
      }),
      placeOrder: vi.fn(async () => ({
        storeId,
        orderCode: `ORD-${storeId}`,
        deliveryIso: new Date().toISOString(),
        totalPrice: Number(items.reduce((s, i) => s + i.itemPrice, 0).toFixed(2)),
        wasOrderUpdate: false,
        removedOutOfStockCodes: [],
      })),
      shutdown: vi.fn(async () => {}),
    };
  }

  it('builds carts across Shufersal, Hazi Hinam, and Super Haviv, matches barcodes, and picks the cheapest cart', async () => {
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

    const havivClient = makeMockStoreClient(
      'super_haviv',
      [
        {
          code: '20230801',
          storeId: 'super_haviv',
          barcode,
          name: "קוטג' תנובה 5%",
          brandName: 'תנובה',
          unitDescription: '250 גרם',
          sellingMethod: 'BY_UNIT',
          price: 6.5,
          formattedPrice: '₪6.50',
          pricePerUnitText: null,
          promotionMsg: null,
          inStock: true,
          purchasable: true,
          categoryName: 'גבינות',
          imageUrl: null,
        },
      ],
      34.0,
    );

    const multi = new MultiStoreManager(
      [
        new StoreManager(shufersalClient, db),
        new StoreManager(haziClient, db),
        new StoreManager(havivClient, db),
      ],
      db,
    );

    // Mock AI that honors preferredBarcode when passed
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

    // All 3 stores added the exact same barcode SKU!
    expect(addRes.outcomes.every((o) => o.status === 'added')).toBe(true);
    expect(
      addRes.outcomes.find((o) => o.storeId === 'hazi_hinam')?.product?.code,
    ).toBe('278017');
    expect(addRes.cheapestItemStoreId).toBe('hazi_hinam');

    // Compare carts (Hazi Hinam: 23.60 + 29.90 = 53.50; Shufersal: 28.80 + 29.90 = 58.70; Haviv: 26.00 + 34.00 = 60.00)
    const comparison = await multi.compareCarts(chatId);
    expect(comparison.cheapestStoreId).toBe('hazi_hinam');
    expect(comparison.quotes.map((q) => q.storeId)).toEqual([
      'hazi_hinam',
      'shufersal',
      'super_haviv',
    ]);
    expect(comparison.savingsVsSecondCheapest).toBe(5.2);
    expect(comparison.savingsVsMostExpensive).toBe(6.5);

    const html = renderComparisonHtml(comparison);
    expect(html).toContain('חצי חינם');
    expect(html).toContain('הזול ביותר');
    expect(html).toContain('₪6.50');

    // Checkout cheapest store and clear losing stores
    const order = await multi.checkoutStore(chatId, comparison.cheapestStoreId!, {
      removeMissingItems: true,
    });
    expect(order.orderCode).toBe('ORD-hazi_hinam');

    const cleared = await multi.clearOtherStores(chatId, 'hazi_hinam');
    expect(cleared.map((c) => c.storeId).sort()).toEqual([
      'shufersal',
      'super_haviv',
    ]);
    expect(cleared.every((c) => c.ok)).toBe(true);
  });

  it('prefers full-coverage carts over cheaper partial carts missing items', () => {
    const quotes: StoreCartQuote[] = [
      {
        storeId: 'super_haviv',
        meta: STORE_META.super_haviv,
        cart: null,
        selectedSlot: null,
        inStockCount: 2,
        outOfStockCount: 0,
        expectedItemsCount: 5,
        missingItemsCount: 3,
        subtotal: 20,
        deliveryFee: 34,
        estimatedTotal: 54, // Cheaper only because 3 items are missing!
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
      {
        storeId: 'hazi_hinam',
        meta: STORE_META.hazi_hinam,
        cart: null,
        selectedSlot: null,
        inStockCount: 5,
        outOfStockCount: 0,
        expectedItemsCount: 5,
        missingItemsCount: 0,
        subtotal: 105,
        deliveryFee: 29.9,
        estimatedTotal: 134.9,
        belowMinimum: true,
        minimumOrderAmount: 200,
        isGuestSession: false,
        error: null,
      },
    ];

    const ranked = rankStoreQuotes(quotes);
    expect(ranked.cheapestStoreId).toBe('hazi_hinam');
    expect(ranked.quotes.map((q) => q.storeId)).toEqual([
      'hazi_hinam',
      'shufersal',
      'super_haviv',
    ]);
    expect(ranked.savingsVsMostExpensive).toBe(15);
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
});
