import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GroceryAiService,
  extractRecommendedGeminiModel,
  type ParsedGroceryItem,
} from '../src/ai/groceryAi.js';
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
  buildMirrorSearchQueries,
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
import {
  VictoryClient,
  extractVictoryBarcodeFromUrl,
  parseVictoryDomCards,
  parseVictoryJsonProducts,
} from '../src/stores/victoryClient.js';
import {
  maskIsraeliPhone,
  normalizeIsraeliPhone,
} from '../src/utils/format.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('parseEnabledStores', () => {
  it('enables all 4 stores by default when Shufersal credentials exist, and omits Shufersal when absent', () => {
    expect(parseEnabledStores(undefined, true)).toEqual([
      'shufersal',
      'hazi_hinam',
      'super_haviv',
      'victory',
    ]);
    expect(parseEnabledStores(undefined, false)).toEqual([
      'hazi_hinam',
      'super_haviv',
      'victory',
    ]);
  });

  it('supports English and Hebrew store aliases', () => {
    expect(parseEnabledStores('שופרסל, חצי חינם, חביב, ויקטורי', true)).toEqual([
      'shufersal',
      'hazi_hinam',
      'super_haviv',
      'victory',
    ]);
    expect(parseEnabledStores('hazi,haviv,victoryonline', false)).toEqual([
      'hazi_hinam',
      'super_haviv',
      'victory',
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

describe('VictoryClient (Next.js storefront)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'victory-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts GS1 barcodes from _next/image CloudFront URLs and parses Victory Next.js DOM product cards', () => {
    const encodedImg =
      'https://www.victoryonline.co.il/_next/image?url=https%3A%2F%2Fdlv1nnscfbvda.cloudfront.net%2Fgs1%2F7290019014751%2F729001901475103-20-2022_13-03-24.jpg&w=3840&q=100';
    expect(extractVictoryBarcodeFromUrl(encodedImg)).toBe('7290019014751');

    const parsed = parseVictoryDomCards([
      {
        href: '/product/%D7%97%D7%9C%D7%91-1-%D7%A7%D7%A8%D7%98%D7%95%D7%9F-1-%D7%9C%D7%99%D7%98%D7%A8',
        title: 'חלב 1% קרטון 1 ליטר',
        imgSrc: encodedImg,
        text: 'חלב 1% קרטון 1 ליטר 1 ליטר ₪6.92 ₪0.69 ל100 מ״ל הוספה לסל',
      },
      {
        href: '/product/trix-480',
        title: 'דגני בוקר טריקס 480 גרם',
        imgSrc: 'https://dlv1nnscfbvda.cloudfront.net/gs1/7290004127329/img.jpg',
        text: 'מבצע 2 ב-₪36.9 נסטלה טריקס 480 גרם ₪11.90₪25.90 ₪5.4 ל100 גרם',
      },
      {
        href: '/product/avocado',
        title: 'אבוקדו',
        imgSrc: null,
        text: '₪4.9 לק"ג 500גרם500גרם אבוקדו ₪4.90₪8.90 ₪4.45 ל500 גרם',
      },
    ]);

    expect(parsed).toHaveLength(3);
    expect(parsed[0]?.barcode).toBe('7290019014751');
    expect(parsed[0]?.price).toBe(6.92);
    expect(parsed[0]?.sellingMethod).toBe('BY_UNIT');

    expect(parsed[1]?.barcode).toBe('7290004127329');
    expect(parsed[1]?.price).toBe(11.9);
    expect(parsed[1]?.promotionMsg).toContain('2 ב-₪36.9');

    expect(parsed[2]?.price).toBe(4.9);
    expect(parsed[2]?.sellingMethod).toBe('BY_WEIGHT');
  });

  it('parses Victory JSON search responses, tracks cart totals, and returns checkout handoff link', async () => {
    const jsonProducts = parseVictoryJsonProducts({
      data: {
        products: [
          {
            id: 30112233,
            name: "קוטג' 5% תנובה",
            imageUrl:
              'https://dlv1nnscfbvda.cloudfront.net/gs1/7290004127329/pic.jpg',
            brand: { name: 'תנובה' },
            regularPrice: 6.4,
            salePrice: 5.5,
            inStock: true,
          },
        ],
      },
    });
    expect(jsonProducts).toHaveLength(1);
    expect(jsonProducts[0]?.barcode).toBe('7290004127329');
    expect(jsonProducts[0]?.price).toBe(5.5);

    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/search?q=')) {
        return jsonResponse({
          products: [
            {
              id: '30112233',
              name: "קוטג' 5% תנובה",
              barcode: '7290004127329',
              regularPrice: 6.4,
              salePrice: 5.5,
              inStock: true,
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const client = new VictoryClient({
      headless: true,
      sessionFilePath: path.join(tmpDir, 'victory-session.json'),
      screenshotsDir: tmpDir,
      fetchFn: mockFetch,
    });

    expect(client.storeId).toBe('victory');
    expect(client.meta.minimumOrderAmount).toBe(250);

    const found = await client.searchProducts("קוטג'");
    expect(found).toHaveLength(1);
    expect(found[0]?.storeId).toBe('victory');
    expect(found[0]?.code).toBe('30112233');
    expect(found[0]?.barcode).toBe('7290004127329');
    expect(found[0]?.price).toBe(5.5);

    const cart = await client.setItemsInCart([
      { productCode: '30112233', quantity: 2, sellingMethod: 'BY_UNIT' },
    ]);
    expect(cart.storeId).toBe('victory');
    expect(cart.totalPrice).toBe(11);
    expect(cart.deliveryFee).toBe(35.9);

    await expect(
      client.placeOrder({ removeMissingItems: true }),
    ).rejects.toBeInstanceOf(StoreManualVerificationRequiredError);
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

  it('mirrors a loaded Shufersal order to all other stores via barcode-first search and compares totals', async () => {
    const cottageBarcode = '7290004127329';
    const milkBarcode = '7290000000111';

    const shufersalClient = makeMockStoreClient('shufersal', [], 29.9);
    // Simulate an existing Shufersal order already loaded into update mode
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
    // Pre-populate stale item that must be cleared before mirroring
    await haziClient.setItemsInCart([
      { productCode: 'HH_COTTAGE', quantity: 9, sellingMethod: 'BY_UNIT' },
    ]);
    vi.mocked(haziClient.searchProducts).mockImplementation(async (q) =>
      haziCatalog.filter((p) => p.barcode === q || p.name.includes(q)),
    );

    const victoryCatalog: CatalogProduct[] = [
      {
        code: 'VIC_COTTAGE',
        storeId: 'victory',
        barcode: cottageBarcode,
        name: "קוטג' תנובה 5%",
        brandName: 'תנובה',
        unitDescription: '250 גרם',
        sellingMethod: 'BY_UNIT',
        price: 5.5,
        formattedPrice: '₪5.50',
        pricePerUnitText: null,
        promotionMsg: null,
        inStock: true,
        purchasable: true,
        categoryName: 'גבינות',
        imageUrl: null,
      },
      // Milk intentionally absent in Victory to verify missingItems tracking
    ];
    const victoryClient = makeMockStoreClient('victory', victoryCatalog, 35.9);
    vi.mocked(victoryClient.searchProducts).mockImplementation(async (q) =>
      victoryCatalog.filter((p) => p.barcode === q || p.name.includes(q)),
    );

    const multi = new MultiStoreManager(
      [
        new StoreManager(shufersalClient, db),
        new StoreManager(haziClient, db),
        new StoreManager(victoryClient, db),
      ],
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

    const progressSteps: Array<[number, number]> = [];
    const res = await multi.mirrorCartToOtherStores({
      chatId: -100777,
      sourceStoreId: 'shufersal',
      senderName: 'אלי',
      ai: mockAi,
      onProgress: (done, total) => {
        progressSteps.push([done, total]);
      },
    });

    expect(res.sourceOrderInUpdateMode).toBe('900123');
    expect(res.totalSourceItems).toBe(2);
    expect(progressSteps).toEqual([
      [1, 2],
      [2, 2],
    ]);

    // Target carts were cleared before mirroring (source store was NOT cleared)
    expect(shufersalClient.clearCart).not.toHaveBeenCalled();
    expect(haziClient.clearCart).toHaveBeenCalledTimes(1);
    expect(victoryClient.clearCart).toHaveBeenCalledTimes(1);

    // Barcode extracted from P_<barcode> was searched first
    expect(haziClient.searchProducts).toHaveBeenCalledWith(
      cottageBarcode,
      expect.any(Number),
    );
    expect(haziClient.searchProducts).toHaveBeenCalledWith(
      milkBarcode,
      expect.any(Number),
    );

    const haziSummary = res.storeSummaries.find((s) => s.storeId === 'hazi_hinam');
    expect(haziSummary?.matchedCount).toBe(2);
    expect(haziSummary?.missingItems).toEqual([]);

    const victorySummary = res.storeSummaries.find((s) => s.storeId === 'victory');
    expect(victorySummary?.matchedCount).toBe(1);
    expect(victorySummary?.missingItems).toEqual(['חלב תנובה 3%']);

    // Hazi Hinam matched both items cheaply (3*5.90 + 2*6.20 = 30.10 + 29.90 = 60.00 vs Shufersal 35.20 + 29.90 = 65.10)
    expect(res.comparison.cheapestStoreId).toBe('hazi_hinam');
    expect(res.comparison.savingsVsSecondCheapest).toBe(5.1);
    // Batch sync called once per target store after mirror matching
    expect(haziClient.setItemsInCart).toHaveBeenCalledTimes(2); // 1 pre-populated stale item + 1 batch sync
    expect(victoryClient.setItemsInCart).toHaveBeenCalledTimes(1);
  });

  it('builds cleaned Hebrew fallback queries from verbose Shufersal product names', () => {
    expect(buildMirrorSearchQueries('עגבניות שרי תמר שופרסל 500 גרם')).toEqual([
      'עגבניות שרי תמר',
      'עגבניות שרי',
    ]);
    expect(
      buildMirrorSearchQueries("גבינת קוטג' 5% שומן תנובה 250 גרם"),
    ).toEqual([
      "גבינת קוטג' 5% תנובה",
      "גבינת קוטג' 5%",
      "גבינת קוטג'",
    ]);
    expect(
      buildMirrorSearchQueries('חלב טרי 3% בקרטון תנובה 1 ליטר'),
    ).toEqual(['חלב 3% תנובה', 'חלב תנובה 3%', 'חלב תנובה']);
  });

  it('falls back to Hazi Hinam guest session when OAuth credentials fail so price comparison still works', async () => {
    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/connect/token')) {
        return jsonResponse(
          { error: 'invalid_grant', error_description: 'wrong user name' },
          400,
        );
      }
      if (url.endsWith('/proxy/init')) {
        return jsonResponse({
          Results: {
            AnonymousToken: {
              access_token: 'hazi-guest-token-999999',
              expires_in: 86400,
            },
          },
        });
      }
      if (url.includes('/proxy/api/item/getItemsBySearch')) {
        return jsonResponse({
          IsOK: true,
          Results: {
            Items: [
              {
                Id: 4040,
                BarKod: '7290004127329',
                Name: "קוטג' 5% תנובה",
                Price_Regular: 5.9,
                IsInStock: true,
              },
            ],
          },
        });
      }
      return jsonResponse({ IsOK: true });
    }) as unknown as typeof fetch;

    const client = new HaziHinamClient({
      username: 'wrong@example.com',
      password: 'bad',
      sessionFilePath: path.join(tmpDir, 'hazi-fallback.json'),
      fetchFn: mockFetch,
    });

    const found = await client.searchProducts("קוטג' 5%");
    expect(found).toHaveLength(1);
    expect(found[0]?.price).toBe(5.9);
    expect(client.getAuthWarning()).toContain('wrong user name');
  });

  it('auto-discovers active Self-Point branch when default branch returns empty and preserves tracked guest cart on 404 ST10', async () => {
    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      // Default branch 3507 returns empty products
      if (url.includes('/branches/3507/products')) {
        return jsonResponse({ products: [] });
      }
      // Branch discovery endpoint returns active branch 3999
      if (url.includes('/v2/retailers/1579/branches?')) {
        return jsonResponse({
          branches: [{ id: 3999, isActive: true, isDelivery: true }],
        });
      }
      // Discovered branch 3999 returns products!
      if (url.includes('/branches/3999/products')) {
        return jsonResponse({
          products: [
            {
              id: 50001,
              localName: "קוטג' 5% תנובה",
              gtin: '7290004127329',
              branch: {
                regularPrice: 5.7,
                salePrice: 0,
                isActive: true,
                isVisible: true,
                isOutOfStock: false,
              },
            },
            {
              id: 50002,
              localName: 'חלב 3% תנובה',
              gtin: '7290000000111',
              branch: {
                regularPrice: 6.1,
                salePrice: 0,
                isActive: true,
                isVisible: true,
                isOutOfStock: false,
              },
            },
          ],
        });
      }
      // Guest cart POST returns 404 ST10 Object not found on Self-Point
      if (url.includes('/carts') && init?.method === 'POST') {
        return jsonResponse({ error: 'Object not found', errorCode: 'ST10' }, 404);
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = new SuperHavivClient({
      headless: true,
      sessionFilePath: path.join(tmpDir, 'haviv-discover.json'),
      screenshotsDir: tmpDir,
      fetchFn: mockFetch,
    });

    const found = await client.searchProducts("קוטג' 5%");
    expect(found).toHaveLength(2);
    expect(found[0]?.code).toBe('50001');

    // Batch-add both items even when guest POST /carts returns 404 ST10
    const cart = await client.setItemsInCart([
      { productCode: '50001', quantity: 2, sellingMethod: 'BY_UNIT' },
      { productCode: '50002', quantity: 1, sellingMethod: 'BY_UNIT' },
    ]);
    expect(cart.items).toHaveLength(2);
    expect(cart.totalPrice).toBe(17.5);

    // Subsequent getCartState() preserves all locally tracked items (never wiped!)
    const reloaded = await client.getCartState();
    expect(reloaded.items).toHaveLength(2);
    expect(reloaded.totalPrice).toBe(17.5);
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
      storeId: 'super_haviv',
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

    // Mock Gemini returning NO_MATCH even when only 1 candidate exists
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

    // Even if Gemini throws an API error, strict fallback rejects unrelated candidate with 0 keyword overlap
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

  it('returns an itemized shopping checklist on guest Super Haviv checkout instead of linking to an empty /cart', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({}, 404)) as unknown as typeof fetch;
    const client = new SuperHavivClient({
      headless: true,
      sessionFilePath: path.join(tmpDir, 'haviv-guest.json'),
      screenshotsDir: tmpDir,
      fetchFn: mockFetch,
    });

    await client.setItemsInCart([
      { productCode: '20230801', quantity: 2, sellingMethod: 'BY_UNIT' },
    ]);

    try {
      await client.placeOrder({ removeMissingItems: true });
      expect.unreachable('Expected StoreManualVerificationRequiredError');
    } catch (err) {
      expect(err).toBeInstanceOf(StoreManualVerificationRequiredError);
      const handoff = err as StoreManualVerificationRequiredError;
      expect(handoff.message).toContain('מצב אורח');
      expect(handoff.message).toContain('רשימת הפריטים להזמנה');
      expect(handoff.actionUrl).toBe('https://www.superhaviv.co.il');
    }
  });
});

describe('SMS OTP login flow (Super Haviv & Victory)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otp-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('normalizes Israeli mobile phone numbers and rejects invalid formats', () => {
    expect(normalizeIsraeliPhone('0501234567')).toBe('0501234567');
    expect(normalizeIsraeliPhone('052-123-4567')).toBe('0521234567');
    expect(normalizeIsraeliPhone('054 123 4567')).toBe('0541234567');
    expect(normalizeIsraeliPhone('+972501234567')).toBe('0501234567');
    expect(normalizeIsraeliPhone('+972-58-765-4321')).toBe('0587654321');
    expect(normalizeIsraeliPhone('972531112222')).toBe('0531112222');
    expect(normalizeIsraeliPhone('00972501234567')).toBe('0501234567');

    expect(normalizeIsraeliPhone('03-1234567')).toBeNull();
    expect(normalizeIsraeliPhone('05012345')).toBeNull();
    expect(normalizeIsraeliPhone('abc')).toBeNull();
    expect(normalizeIsraeliPhone('')).toBeNull();
  });

  it('validates phone numbers and pending state on SuperHavivClient and VictoryClient before browser launch', async () => {
    const haviv = new SuperHavivClient({
      headless: true,
      sessionFilePath: path.join(tmpDir, 'haviv-session.json'),
      screenshotsDir: tmpDir,
    });
    const victory = new VictoryClient({
      headless: true,
      sessionFilePath: path.join(tmpDir, 'victory-session.json'),
      screenshotsDir: tmpDir,
    });

    await expect(haviv.startSmsOtpLogin('1234')).rejects.toThrow(
      /מספר הטלפון אינו תקין/,
    );
    await expect(victory.startSmsOtpLogin('03-9999999')).rejects.toThrow(
      /מספר הטלפון אינו תקין/,
    );

    await expect(haviv.completeSmsOtpLogin('123456')).rejects.toThrow(
      /\/login_haviv/,
    );
    await expect(victory.completeSmsOtpLogin('123456')).rejects.toThrow(
      /\/login_victory/,
    );
  });

  it('delegates startSmsOtpLogin and completeSmsOtpLogin through MultiStoreManager and StoreManager', async () => {
    const dbPath = path.join(tmpDir, 'bot.sqlite');
    const db = new BotDatabase(dbPath);
    try {
      const startMock = vi.fn(async (phone: string) => ({
        message: `נשלח קוד ל-${phone}`,
      }));
      const completeMock = vi.fn(async (code: string) => ({
        message: `התחברת בהצלחה עם קוד באורך ${code.length}`,
        isAuthenticated: true,
      }));

      const makeStubClient = (
        storeId: StoreId,
        withOtp: boolean,
      ): StoreClient => ({
        storeId,
        meta: STORE_META[storeId],
        ensureLoggedIn: async () => {},
        searchProducts: async () => [],
        getCartState: async (): Promise<CartState> => ({
          items: [],
          totalPrice: 0,
          deliveryFee: STORE_META[storeId].defaultDeliveryFee,
          totalItemsCount: 0,
          orderInUpdateMode: null,
          isGuestSession: false,
        }),
        setItemInCart: async () => ({
          items: [],
          totalPrice: 0,
          deliveryFee: null,
          totalItemsCount: 0,
          orderInUpdateMode: null,
        }),
        clearCart: async () => {},
        getDeliverySlots: async () => [],
        selectDeliverySlot: async () => {},
        getActiveOrders: async () => [],
        loadOrderForUpdate: async () => {},
        placeOrder: async () => ({ message: 'ok' }),
        close: async () => {},
        ...(withOtp
          ? {
              startSmsOtpLogin: startMock,
              completeSmsOtpLogin: completeMock,
            }
          : {}),
      });

      const havivMgr = new StoreManager(makeStubClient('super_haviv', true), db);
      const shufersalMgr = new StoreManager(
        makeStubClient('shufersal', false),
        db,
      );
      const multi = new MultiStoreManager([shufersalMgr, havivMgr], db);

      const startRes = await multi.startSmsOtpLogin('super_haviv', '0501234567');
      expect(startMock).toHaveBeenCalledWith('0501234567');
      expect(startRes.message).toContain('0501234567');

      const completeRes = await multi.completeSmsOtpLogin('super_haviv', '654321');
      expect(completeMock).toHaveBeenCalledWith('654321');
      expect(completeRes.isAuthenticated).toBe(true);

      await expect(
        multi.startSmsOtpLogin('shufersal', '0501234567'),
      ).rejects.toThrow(/אינה נתמכת/);
      await expect(
        multi.startSmsOtpLogin('victory', '0501234567'),
      ).rejects.toThrow(/אינה מופעלת/);
    } finally {
      db.close();
    }
  });

  it('masks Israeli phone numbers, persists settings in BotDatabase, and detects unauthenticated SMS OTP stores', () => {
    expect(maskIsraeliPhone('0501234567')).toBe('050-***-4567');
    expect(maskIsraeliPhone('+972-54-987-6543')).toBe('054-***-6543');
    expect(maskIsraeliPhone('invalid')).toBe('***');

    const dbPath = path.join(tmpDir, 'settings.sqlite');
    const db = new BotDatabase(dbPath);
    try {
      expect(db.getSetting('sms_phone:default')).toBeNull();
      db.setSetting('sms_phone:default', '0501234567');
      expect(db.getSetting('sms_phone:default')).toBe('0501234567');
      db.setSetting('sms_phone:default', '0527654321');
      expect(db.getSetting('sms_phone:default')).toBe('0527654321');

      const havivSessionPath = path.join(tmpDir, 'haviv-auth.json');
      const victorySessionPath = path.join(tmpDir, 'victory-auth.json');

      const guestHaviv = new SuperHavivClient({
        headless: true,
        sessionFilePath: havivSessionPath,
        screenshotsDir: tmpDir,
      });
      const guestVictory = new VictoryClient({
        headless: true,
        sessionFilePath: victorySessionPath,
        screenshotsDir: tmpDir,
      });

      expect(guestHaviv.isAuthenticated()).toBe(false);
      expect(guestVictory.isAuthenticated()).toBe(false);

      const multiGuest = new MultiStoreManager(
        [new StoreManager(guestHaviv, db), new StoreManager(guestVictory, db)],
        db,
      );
      expect(multiGuest.getUnauthenticatedSmsOtpStores()).toEqual([
        'super_haviv',
        'victory',
      ]);

      // Once session files are persisted on disk, both clients load authenticated state eagerly
      fs.writeFileSync(
        havivSessionPath,
        JSON.stringify({ savedAt: new Date().toISOString(), token: 'tok-123' }),
      );
      fs.writeFileSync(
        victorySessionPath,
        JSON.stringify({
          savedAt: new Date().toISOString(),
          localStorage: { auth: 'ok' },
        }),
      );

      const authedHaviv = new SuperHavivClient({
        headless: true,
        sessionFilePath: havivSessionPath,
        screenshotsDir: tmpDir,
      });
      const authedVictory = new VictoryClient({
        headless: true,
        sessionFilePath: victorySessionPath,
        screenshotsDir: tmpDir,
      });
      expect(authedHaviv.isAuthenticated()).toBe(true);
      expect(authedVictory.isAuthenticated()).toBe(true);

      const multiAuthed = new MultiStoreManager(
        [
          new StoreManager(authedHaviv, db),
          new StoreManager(authedVictory, db),
        ],
        db,
      );
      expect(multiAuthed.getUnauthenticatedSmsOtpStores()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

