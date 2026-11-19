import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkIsUserAdmin,
  type AdminCheckContext,
} from '../src/bot/telegramBot.js';
import { parseAdminUserIds, parseIdList } from '../src/config.js';
import {
  parseCartModifications,
  parseOrderCodeFromConfirmation,
  parseOrderInUpdateMode,
  rawCartPageToCartState,
} from '../src/shufersal/cartParser.js';
import type { ShufersalClient } from '../src/shufersal/client.js';
import { ShufersalManager } from '../src/shufersal/manager.js';
import type { CartState, CatalogProduct } from '../src/shufersal/types.js';
import { BotDatabase } from '../src/store/database.js';
import {
  escapeHtml,
  formatCurrency,
  formatQuantity,
  normalizeHebrewQuery,
} from '../src/utils/format.js';
import { AsyncMutex } from '../src/utils/mutex.js';

describe('AsyncMutex', () => {
  it('executes concurrent tasks strictly sequentially', async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    const p1 = mutex.runExclusive(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 30));
      order.push(2);
    });

    const p2 = mutex.runExclusive(async () => {
      order.push(3);
      await new Promise((r) => setTimeout(r, 10));
      order.push(4);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3, 4]);
    expect(mutex.pending).toBe(0);
  });
});

describe('cartParser', () => {
  it('parses order in update mode banner', () => {
    expect(parseOrderInUpdateMode('שלום, עדכון הזמנה מס׳ 98765432 פעיל')).toBe(
      '98765432',
    );
    expect(parseOrderInUpdateMode('עגלה רגילה ללא עדכון')).toBeNull();
  });

  it('parses confirmation order codes from URL and HTML', () => {
    expect(
      parseOrderCodeFromConfirmation(
        'https://www.shufersal.co.il/online/he/checkout/orderConfirmation/12345678',
        '',
      ),
    ).toBe('12345678');

    expect(
      parseOrderCodeFromConfirmation(
        'https://www.shufersal.co.il/online/he/checkout/thank-you',
        '<div>תודה! מספר ההזמנה: 87654321</div>',
      ),
    ).toBe('87654321');
  });

  it('parses cart modifications and computes in-stock totals', () => {
    const script = `
      miglog.cart.modifications = [
        { productCode: 'P_111', statusCode: 'success', entry: 0, quantity: 2 }
      ];
    `;
    const mods = parseCartModifications(script);
    expect(mods).toEqual([
      {
        productCode: 'P_111',
        statusCode: 'success',
        entryNumber: 0,
        quantity: 2,
      },
    ]);

    const cart = rawCartPageToCartState({
      articles: [
        {
          productCode: 'P_111',
          productName: 'חלב תנובה 3%',
          quantity: 2,
          entryNumber: 0,
          itemPrice: 14.2,
          isOutOfStock: false,
        },
        {
          productCode: 'P_222',
          productName: 'מוצר חסר',
          quantity: 1,
          entryNumber: 1,
          itemPrice: 9.9,
          isOutOfStock: true,
        },
      ],
      bodyText: 'עדכון הזמנה מס׳ 55443322',
      modificationsScript: script,
    });

    expect(cart.totalPrice).toBe(14.2);
    expect(cart.orderInUpdateMode).toBe('55443322');
    expect(cart.items).toHaveLength(2);
    expect(cart.items[0]?.inStock).toBe(true);
    expect(cart.items[1]?.inStock).toBe(false);
  });
});

describe('BotDatabase & ShufersalManager', () => {
  let tmpDir: string;
  let db: BotDatabase;

  const milkTnuva: CatalogProduct = {
    code: 'P_4127329',
    name: 'חלב מפוסטר 3% תנובה בקרטון',
    brandName: 'תנובה',
    unitDescription: '1 ליטר',
    sellingMethod: 'BY_UNIT',
    price: 7.1,
    formattedPrice: '₪7.10',
    pricePerUnitText: '₪7.10 ל-1 ליטר',
    promotionMsg: null,
    inStock: true,
    purchasable: true,
    categoryName: 'חלב',
    imageUrl: null,
  };

  const milkYotvata: CatalogProduct = {
    code: 'P_7290000',
    name: 'חלב מועשר 3% יטבתה',
    brandName: 'יטבתה',
    unitDescription: '1 ליטר',
    sellingMethod: 'BY_UNIT',
    price: 8.5,
    formattedPrice: '₪8.50',
    pricePerUnitText: null,
    promotionMsg: '2 ב-15 ₪',
    inStock: true,
    purchasable: true,
    categoryName: 'חלב',
    imageUrl: null,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shufersal-bot-test-'));
    db = new BotDatabase(path.join(tmpDir, 'test.sqlite'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores callback payloads under compact tokens well under Telegram 64-byte limit', () => {
    const tok = db.saveCallbackPayload({
      kind: 'item_ctrl',
      chatId: -100123456,
      query: 'חלב תנובה 3%',
      productCode: milkTnuva.code,
      sellingMethod: 'BY_UNIT',
      quantity: 2,
      senderName: 'דניאל',
      alternatives: [milkYotvata],
    });

    const callbackData = `c:${tok}:swap`;
    expect(Buffer.byteLength(callbackData, 'utf8')).toBeLessThan(32);

    const restored = db.getCallbackPayload(tok);
    expect(restored?.kind).toBe('item_ctrl');
    if (restored?.kind === 'item_ctrl') {
      expect(restored.productCode).toBe('P_4127329');
      expect(restored.alternatives[0]?.code).toBe('P_7290000');
    }
  });

  it('increments cart items, tracks group contributors, and learns preferences on swap', async () => {
    let mockItems: CartState['items'] = [];

    const mockClient = {
      getCartState: vi.fn(async (): Promise<CartState> => ({
        items: [...mockItems],
        totalPrice: mockItems.reduce((s, i) => s + i.itemPrice, 0),
        orderInUpdateMode: null,
      })),
      setItemsInCart: vi.fn(async (inputs): Promise<CartState> => {
        for (const inp of inputs) {
          const idx = mockItems.findIndex(
            (m) => m.productCode === inp.productCode,
          );
          const unitPrice =
            inp.productCode === milkTnuva.code
              ? milkTnuva.price
              : milkYotvata.price;
          const entry = {
            entryNumber: idx >= 0 ? mockItems[idx]!.entryNumber : mockItems.length,
            productCode: inp.productCode,
            quantity: inp.quantity,
            itemPrice: Number((inp.quantity * unitPrice).toFixed(2)),
            inStock: true,
          };
          if (idx >= 0) mockItems[idx] = entry;
          else mockItems.push(entry);
        }
        return {
          items: [...mockItems],
          totalPrice: mockItems.reduce((s, i) => s + i.itemPrice, 0),
          orderInUpdateMode: null,
        };
      }),
      removeFromCart: vi.fn(async (code: string): Promise<CartState> => {
        mockItems = mockItems.filter((i) => i.productCode !== code);
        return {
          items: [...mockItems],
          totalPrice: mockItems.reduce((s, i) => s + i.itemPrice, 0),
          orderInUpdateMode: null,
        };
      }),
      updateCartItemQuantity: vi.fn(),
    } as unknown as ShufersalClient;

    const manager = new ShufersalManager(mockClient, db);
    const chatId = -100999888;

    // Member 1 adds 2 milk
    const res1 = await manager.addOrIncrementProduct({
      chatId,
      senderName: 'נועה',
      product: milkTnuva,
      quantity: 2,
      mode: 'increment',
    });
    expect(res1.finalQuantity).toBe(2);

    // Member 2 adds 1 more milk
    const res2 = await manager.addOrIncrementProduct({
      chatId,
      senderName: 'יוסי',
      product: milkTnuva,
      quantity: 1,
      mode: 'increment',
    });
    expect(res2.finalQuantity).toBe(3);
    expect(res2.cart.items[0]?.requestedBy).toEqual(['נועה', 'יוסי']);

    // Member 2 swaps their 1 unit to Yotvata -> Tnuva drops or updates, Yotvata added & learned!
    mockClient.updateCartItemQuantity = vi.fn(async (code, qty) => {
      mockItems = mockItems.map((i) =>
        i.productCode === code
          ? { ...i, quantity: qty, itemPrice: Number((qty * milkTnuva.price).toFixed(2)) }
          : i,
      );
      return {
        items: [...mockItems],
        totalPrice: mockItems.reduce((s, i) => s + i.itemPrice, 0),
        orderInUpdateMode: null,
      };
    });

    const swapRes = await manager.replaceProduct({
      chatId,
      senderName: 'יוסי',
      rawQuery: 'חלב 3%',
      oldProductCode: milkTnuva.code,
      newProduct: milkYotvata,
      quantity: 1,
    });

    expect(swapRes.finalNewQuantity).toBe(1);
    expect(swapRes.cart.items.find((i) => i.productCode === milkTnuva.code)?.quantity).toBe(2);
    expect(swapRes.cart.items.find((i) => i.productCode === milkYotvata.code)?.quantity).toBe(1);

    // Check learned preference was saved in SQLite
    const pref = db.getPreference('חלב 3%"');
    expect(pref?.productCode).toBe(milkYotvata.code);
  });
});

describe('format helpers', () => {
  it('formats quantities and escapes HTML safely', () => {
    expect(formatQuantity(2, 'BY_UNIT')).toBe("2 יח'");
    expect(formatQuantity(0.5, 'BY_WEIGHT')).toBe('0.5 ק"ג');
    expect(formatCurrency(123.4)).toBe('₪123.40');
    expect(escapeHtml('חלב <3%> & "טרי"')).toBe('חלב &lt;3%&gt; &amp; &quot;טרי&quot;');
    expect(normalizeHebrewQuery('  קוטג\' "תנובה" ')).toBe('קוטג תנובה');
  });
});

describe('Admin permissions & ID parsing', () => {
  it('ignores accidental negative chat IDs in ADMIN_USER_IDS while keeping them in ALLOWED_CHAT_IDS', () => {
    expect(parseIdList('-1001234567890, 555666777')).toEqual([
      -1001234567890,
      555666777,
    ]);
    expect(parseAdminUserIds('-1001234567890, -4998877, 555666777')).toEqual([
      555666777,
    ]);
    expect(parseAdminUserIds('-1001234567890')).toEqual([]);
  });

  it('allows Telegram group owner (creator) even when bot is not a group admin and ADMIN_USER_IDS has another ID', async () => {
    const ownerId = 777888999;
    const ctx = {
      from: { id: ownerId, is_bot: false, first_name: 'Eli' },
      chat: { id: -412345678, type: 'group', title: 'משפחה' },
      msg: undefined,
      getChatAdministrators: vi.fn(async () => [
        {
          status: 'creator',
          is_anonymous: false,
          user: { id: ownerId, is_bot: false, first_name: 'Eli' },
        },
      ]),
      getChatMember: vi.fn(async () => {
        throw new Error('Bad Request: method is available only for chat administrators');
      }),
    } as unknown as AdminCheckContext;

    // Even if ADMIN_USER_IDS was configured with someone else's ID (111222333), group owner is STILL allowed!
    await expect(checkIsUserAdmin(ctx, [111222333])).resolves.toBe(true);
    await expect(checkIsUserAdmin(ctx, [])).resolves.toBe(true);
  });

  it('allows anonymous group owner sending on behalf of the group (sender_chat)', async () => {
    const chatId = -10099887766;
    const ctx = {
      from: { id: 1087968824, is_bot: true, first_name: 'Group' },
      chat: { id: chatId, type: 'supergroup', title: 'קניות הבית' },
      msg: { sender_chat: { id: chatId, type: 'supergroup', title: 'קניות הבית' } },
      getChatAdministrators: vi.fn(async () => []),
      getChatMember: vi.fn(async () => ({ status: 'left' })),
    } as unknown as AdminCheckContext;

    await expect(checkIsUserAdmin(ctx, [])).resolves.toBe(true);
  });

  it('allows non-admin group member explicitly listed in ADMIN_USER_IDS, and rejects unlisted regular members', async () => {
    const spouseId = 222333444;
    const kidId = 999000111;
    const ownerId = 777888999;

    const makeCtx = (userId: number) =>
      ({
        from: { id: userId, is_bot: false, first_name: 'Member' },
        chat: { id: -412345678, type: 'group', title: 'משפחה' },
        msg: undefined,
        getChatAdministrators: vi.fn(async () => [
          {
            status: 'creator',
            is_anonymous: false,
            user: { id: ownerId, is_bot: false, first_name: 'Eli' },
          },
        ]),
        getChatMember: vi.fn(async () => ({
          status: 'member',
          user: { id: userId, is_bot: false, first_name: 'Member' },
        })),
      }) as unknown as AdminCheckContext;

    await expect(checkIsUserAdmin(makeCtx(spouseId), [spouseId])).resolves.toBe(true);
    await expect(checkIsUserAdmin(makeCtx(kidId), [spouseId])).resolves.toBe(false);
    await expect(checkIsUserAdmin(makeCtx(kidId), [])).resolves.toBe(false);
  });
});
