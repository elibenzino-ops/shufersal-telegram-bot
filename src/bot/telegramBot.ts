import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { GroceryAiService, ParsedGroceryItem } from '../ai/groceryAi.js';
import type { AppConfig } from '../config.js';
import { logger } from '../logger.js';
import type {
  BotDatabase,
  MultiItemStoreRef,
} from '../store/database.js';
import type {
  MultiStoreAddItemResult,
  MultiStoreManager,
} from '../stores/multiStoreManager.js';
import {
  STORE_META,
  StoreAuthError,
  StoreManualVerificationRequiredError,
  type CartComparisonResult,
  type CartState,
  type CatalogProduct,
  type DeliverySlot,
  type StoreId,
  type StoreMeta,
} from '../stores/types.js';
import {
  escapeHtml,
  formatCurrency,
  formatHebrewDateTime,
  formatHebrewDayHeader,
  formatQuantity,
  normalizeIsraeliPhone,
} from '../utils/format.js';

export interface CreateTelegramBotDeps {
  config: AppConfig;
  db: BotDatabase;
  stores: MultiStoreManager;
  ai: GroceryAiService;
}

function getSenderDisplayName(ctx: Context): string {
  const from = ctx.from;
  if (!from) return 'משתתף';
  const full = [from.first_name, from.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  return full || from.username || String(from.id);
}

function formatUserFacingError(err: unknown): string {
  if (err instanceof StoreManualVerificationRequiredError) {
    const storeLabel = STORE_META[err.storeId]?.displayName ?? 'החנות';
    return (
      `⚠️ <b>נדרשת השלמה ידנית קצרה ב-${escapeHtml(storeLabel)}</b>\n` +
      `${escapeHtml(err.message)}\n\n` +
      `🔗 <a href="${escapeHtml(err.actionUrl)}">מעבר ישיר לעגלה/קופה ב-${escapeHtml(storeLabel)}</a>`
    );
  }
  if (err instanceof StoreAuthError) {
    const storeLabel = STORE_META[err.storeId]?.displayName ?? 'החנות';
    return `🔐 <b>שגיאת התחברות ל-${escapeHtml(storeLabel)}:</b> ${escapeHtml(err.message)}`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `❌ <b>שגיאה:</b> ${escapeHtml(msg)}`;
}

function buildSingleItemControlMessage(params: {
  storeMeta: StoreMeta;
  product: CatalogProduct;
  addedQty: number;
  totalInCartQty: number;
  senderName: string;
  cartTotal: number;
  orderInUpdateMode: string | null;
  learnedNote?: boolean;
}): string {
  const unitInfo = params.product.unitDescription
    ? ` (${escapeHtml(params.product.unitDescription)})`
    : '';
  const promoInfo = params.product.promotionMsg
    ? `\n🏷 <i>מבצע: ${escapeHtml(params.product.promotionMsg)}</i>`
    : '';
  const totalQtyNote =
    params.totalInCartQty !== params.addedQty
      ? ` (סה"כ בעגלה כעת: <b>${escapeHtml(formatQuantity(params.totalInCartQty, params.product.sellingMethod))}</b>)`
      : '';
  const updateBanner = params.orderInUpdateMode
    ? `\n✏️ <i>משויך לעדכון הזמנה #${escapeHtml(params.orderInUpdateMode)}</i>`
    : '';
  const learnedBanner = params.learnedNote
    ? `\n💡 <i>נשמר כמוצר המועדף של הקבוצה ב-${escapeHtml(params.storeMeta.shortName)} לפעמים הבאות!</i>`
    : '';

  return (
    `✅ <b>נוסף לעגלת ${escapeHtml(params.storeMeta.emoji)} ${escapeHtml(params.storeMeta.displayName)}:</b>\n` +
    `🛒 <b>${escapeHtml(params.product.name)}</b>${unitInfo}\n` +
    `📦 כמות: <b>${escapeHtml(formatQuantity(params.addedQty, params.product.sellingMethod))}</b>${totalQtyNote} • מחיר: <b>${escapeHtml(params.product.formattedPrice)}</b>` +
    promoInfo +
    `\n👤 ביקש/ה: ${escapeHtml(params.senderName)} • סה"כ עגלה: <b>${formatCurrency(params.cartTotal)}</b>` +
    updateBanner +
    learnedBanner
  );
}

function buildMultiItemControlMessage(params: {
  query: string;
  senderName: string;
  result: MultiStoreAddItemResult;
  learnedStoreName?: string;
}): string {
  const lines: string[] = [
    `✅ <b>נוסף לעגלות (${escapeHtml(params.query)}):</b>`,
  ];

  for (const o of params.result.outcomes) {
    const tag = `${o.meta.emoji} <b>${escapeHtml(o.meta.shortName)}</b>`;
    if (o.status === 'added' && o.product && o.addedQty !== undefined) {
      const winner =
        params.result.cheapestItemStoreId === o.storeId &&
        params.result.outcomes.filter((x) => x.status === 'added').length > 1
          ? ' 🏆'
          : '';
      const unitInfo = o.product.unitDescription
        ? ` (${escapeHtml(o.product.unitDescription)})`
        : '';
      const qtyText = formatQuantity(o.finalQuantity ?? o.addedQty, o.product.sellingMethod);
      const cartTotalText = o.cart ? ` • עגלה: ${formatCurrency(o.cart.totalPrice)}` : '';
      lines.push(
        `${tag}: ${escapeHtml(o.product.name)}${unitInfo}\n` +
          `   📦 ${escapeHtml(qtyText)} • <b>${escapeHtml(o.product.formattedPrice)}</b>${winner}${cartTotalText}`,
      );
    } else if (o.status === 'not_found') {
      lines.push(`${tag}: <i>לא נמצא במלאי</i>`);
    } else {
      lines.push(
        `${tag}: ⚠️ <i>שגיאה (${escapeHtml((o.error ?? '').slice(0, 80))})</i>`,
      );
    }
  }

  lines.push(`\n👤 ביקש/ה: ${escapeHtml(params.senderName)}`);
  if (params.learnedStoreName) {
    lines.push(
      `💡 <i>נשמרה העדפת המוצר ב-${escapeHtml(params.learnedStoreName)} לפעמים הבאות!</i>`,
    );
  }
  return lines.join('\n');
}

function buildSingleItemControlKeyboard(
  ctrlToken: string,
  hasAlternatives: boolean,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (hasAlternatives) {
    kb.text('🔄 החלף מוצר', `c:${ctrlToken}:swap`);
  }
  kb.text('➕', `c:${ctrlToken}:inc`)
    .text('➖', `c:${ctrlToken}:dec`)
    .text('❌ הסר', `c:${ctrlToken}:rm`);
  return kb;
}

function buildMultiItemControlKeyboard(
  ctrlToken: string,
  stores: MultiItemStoreRef[],
): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('➕ עוד', `m:${ctrlToken}:inc`)
    .text('➖ פחות', `m:${ctrlToken}:dec`)
    .text('❌ הסר מכולם', `m:${ctrlToken}:rm`);

  const swappable = stores.filter((s) => s.alternatives.length > 0);
  if (swappable.length > 0) {
    kb.row();
    for (const s of swappable) {
      const meta = STORE_META[s.storeId];
      kb.text(`🔄 ${meta.emoji} ${meta.shortName}`, `m:${ctrlToken}:swap:${s.storeId}`);
    }
  }
  return kb;
}

export function renderComparisonHtml(
  comparison: CartComparisonResult,
  title = '⚖️ השוואת עגלות בין הרשתות',
): string {
  const lines: string[] = [`<b>${escapeHtml(title)}</b>\n`];
  const medals = ['🏆', '2️⃣', '3️⃣', '4️⃣'];

  const hasAnyItems = comparison.quotes.some((q) => !q.error && q.inStockCount > 0);
  if (!hasAnyItems) {
    const errStores = comparison.quotes.filter((q) => q.error);
    if (errStores.length === comparison.quotes.length) {
      lines.push('❌ לא ניתן היה להתחבר כרגע לאף אחת מהחנויות:');
      for (const q of errStores) {
        lines.push(`• ${q.meta.emoji} <b>${escapeHtml(q.meta.shortName)}</b>: ${escapeHtml(q.error ?? '')}`);
      }
      return lines.join('\n');
    }
    return (
      `<b>${escapeHtml(title)}</b>\n\n` +
      `העגלות ריקות כרגע בכל הרשתות. שלחו הודעה חופשית בקבוצה (למשל: <i>"צריך 2 חלב, קוטג' וחצי קילו עגבניות"</i>) כדי למלא ולהשוות מחירים!`
    );
  }

  comparison.quotes.forEach((q, idx) => {
    const badge = !q.error && q.inStockCount > 0 ? (medals[idx] ?? `${idx + 1}.`) : '⚪';
    const isCheapest = q.storeId === comparison.cheapestStoreId;
    const headerTag = isCheapest ? ' — <b>הזול ביותר!</b>' : '';

    if (q.error) {
      lines.push(
        `⚠️ ${q.meta.emoji} <b>${escapeHtml(q.meta.displayName)}</b>\n` +
          `   לא זמין כרגע: <i>${escapeHtml(q.error.slice(0, 110))}</i>`,
      );
      return;
    }

    if (q.inStockCount === 0) {
      lines.push(
        `⚪ ${q.meta.emoji} <b>${escapeHtml(q.meta.displayName)}</b> — העגלה ריקה`,
      );
      return;
    }

    const coverageText =
      q.missingItemsCount > 0
        ? ` (${q.inStockCount}/${q.expectedItemsCount} פריטים — ⚠️ חסרים ${q.missingItemsCount})`
        : ` (${q.inStockCount} פריטים במלאי)`;

    const deliveryText =
      q.deliveryFee > 0
        ? ` + משלוח ${formatCurrency(q.deliveryFee)}`
        : ' (משלוח חינם/ללא הערכה)';

    const flags: string[] = [];
    if (q.belowMinimum && q.minimumOrderAmount) {
      flags.push(`⚠️ מתחת למינימום הזמנה (${formatCurrency(q.minimumOrderAmount)})`);
    }
    if (q.outOfStockCount > 0) {
      flags.push(`⚠️ ${q.outOfStockCount} מוצרים חסרי מלאי`);
    }
    if (q.isGuestSession) {
      flags.push('👤 מצב אורח (מחירים חיים)');
    }
    if (q.selectedSlot) {
      flags.push(
        `🚚 ${formatHebrewDateTime(q.selectedSlot.startIso, q.selectedSlot.endHourText)}`,
      );
    }

    lines.push(
      `${badge} ${q.meta.emoji} <b>${escapeHtml(q.meta.displayName)}</b>${headerTag}\n` +
        `   💰 <b>סה"כ מוערך: ${formatCurrency(q.estimatedTotal)}</b>\n` +
        `   🛒 מוצרים: ${formatCurrency(q.subtotal)}${deliveryText}${coverageText}` +
        (flags.length > 0 ? `\n   ${flags.map(escapeHtml).join(' • ')}` : ''),
    );
  });

  if (comparison.cheapestStoreId && comparison.savingsVsMostExpensive > 0) {
    const winnerMeta = STORE_META[comparison.cheapestStoreId];
    const vsSecond =
      comparison.savingsVsSecondCheapest > 0 &&
      comparison.savingsVsSecondCheapest !== comparison.savingsVsMostExpensive
        ? ` (${formatCurrency(comparison.savingsVsSecondCheapest)} מול המקום השני)`
        : '';
    lines.push(
      `\n💡 <b>חיסכון משוער ב-${escapeHtml(winnerMeta.shortName)}: ${formatCurrency(comparison.savingsVsMostExpensive)}</b> מול הסל היקר ביותר${vsSecond}!`,
    );
  }

  return lines.join('\n\n');
}

function renderCartSummaryHtml(
  storeMeta: StoreMeta,
  cart: CartState,
  selectedSlot?: DeliverySlot | null,
): string {
  const header = cart.orderInUpdateMode
    ? `🛒 <b>עגלת ${escapeHtml(storeMeta.emoji)} ${escapeHtml(storeMeta.displayName)} – מצב עדכון הזמנה #${escapeHtml(cart.orderInUpdateMode)}</b>\n`
    : `🛒 <b>עגלת הקניות ב-${escapeHtml(storeMeta.emoji)} ${escapeHtml(storeMeta.displayName)}</b>\n`;

  if (cart.items.length === 0) {
    return `${header}\nהעגלה ריקה כרגע. שלחו הודעה חופשית בקבוצה (למשל: <i>"צריך 2 חלב וקוטג'"</i>) כדי להתחיל למלא אותה!`;
  }

  const lines: string[] = [header];
  const inStockItems = cart.items.filter((i) => i.inStock);
  const outOfStockItems = cart.items.filter((i) => !i.inStock);

  inStockItems.forEach((item, idx) => {
    const qtyText = formatQuantity(item.quantity, item.sellingMethod);
    const byText =
      item.requestedBy && item.requestedBy.length > 0
        ? ` <i>(${escapeHtml(item.requestedBy.join(', '))})</i>`
        : '';
    lines.push(
      `${idx + 1}. <b>${escapeHtml(item.productName ?? item.productCode)}</b> — ${escapeHtml(qtyText)} — ${formatCurrency(item.itemPrice)}${byText}`,
    );
  });

  if (outOfStockItems.length > 0) {
    lines.push(`\n⚠️ <b>מוצרים שאזלו כרגע מהמלאי:</b>`);
    outOfStockItems.forEach((item) => {
      lines.push(
        `• <s>${escapeHtml(item.productName ?? item.productCode)}</s> (${escapeHtml(formatQuantity(item.quantity, item.sellingMethod))})`,
      );
    });
  }

  const estDelivery =
    selectedSlot?.deliveryFee ??
    cart.deliveryFee ??
    storeMeta.defaultDeliveryFee ??
    0;
  lines.push(
    `\n💰 <b>סה"כ מוצרים במלאי: ${formatCurrency(cart.totalPrice)}</b> (${inStockItems.length} פריטים)` +
      (estDelivery > 0
        ? `\n🚚 <b>משלוח מוערך:</b> ${formatCurrency(estDelivery)} • <b>סה"כ כולל משלוח: ${formatCurrency(cart.totalPrice + estDelivery)}</b>`
        : ''),
  );

  if (storeMeta.minimumOrderAmount && cart.totalPrice < storeMeta.minimumOrderAmount) {
    lines.push(
      `⚠️ <i>מתחת למינימום הזמנה ב-${escapeHtml(storeMeta.shortName)} (${formatCurrency(storeMeta.minimumOrderAmount)})</i>`,
    );
  }

  if (selectedSlot) {
    const slotText = formatHebrewDateTime(
      selectedSlot.startIso,
      selectedSlot.endHourText,
    );
    const feeText =
      selectedSlot.deliveryFee !== null
        ? ` (דמי משלוח: ${formatCurrency(selectedSlot.deliveryFee)})`
        : '';
    lines.push(`🚚 <b>חלון משלוח שמור:</b> ${escapeHtml(slotText)}${feeText}`);
  } else if (!cart.orderInUpdateMode && storeMeta.id === 'shufersal') {
    lines.push(`🕒 <i>טרם נבחר חלון משלוח – לבחירה לחצו או הקלידו /slots</i>`);
  }

  lines.push(
    `🔗 <a href="${escapeHtml(storeMeta.cartUrl)}">פתיחת העגלה באתר ${escapeHtml(storeMeta.shortName)}</a>`,
  );

  return lines.join('\n');
}

export type AdminCheckContext = Pick<
  Context,
  'from' | 'chat' | 'msg' | 'getChatAdministrators' | 'getChatMember'
>;

export async function checkIsUserAdmin(
  ctx: AdminCheckContext,
  adminUserIds: number[],
): Promise<boolean> {
  if (ctx.chat?.type === 'private') {
    return true;
  }

  if (ctx.msg?.sender_chat && ctx.chat && ctx.msg.sender_chat.id === ctx.chat.id) {
    return true;
  }

  const userId = ctx.from?.id;
  if (!userId) return false;

  if (adminUserIds.includes(userId)) {
    return true;
  }

  try {
    const admins = await ctx.getChatAdministrators();
    if (
      admins.some(
        (m) =>
          m.user.id === userId &&
          (m.status === 'creator' || m.status === 'administrator'),
      )
    ) {
      return true;
    }
  } catch (err) {
    logger.warn(
      `getChatAdministrators failed for chat=${ctx.chat?.id} user=${userId}, falling back to getChatMember`,
      err,
    );
  }

  try {
    const member = await ctx.getChatMember(userId);
    if (member.status === 'creator' || member.status === 'administrator') {
      return true;
    }
  } catch (err) {
    logger.warn(
      `getChatMember failed for chat=${ctx.chat?.id} user=${userId}`,
      err,
    );
  }

  logger.info(
    `Admin check denied for user=${userId} in chat=${ctx.chat?.id} (type=${ctx.chat?.type}, configuredAdmins=${JSON.stringify(adminUserIds)})`,
  );
  return false;
}

export function createTelegramBot(deps: CreateTelegramBotDeps): Bot {
  const { config, db, stores, ai } = deps;
  const bot = new Bot(config.telegramBotToken);

  async function isUserAdmin(ctx: Context): Promise<boolean> {
    return checkIsUserAdmin(ctx, config.adminUserIds);
  }

  function buildComparisonKeyboard(
    comparison: CartComparisonResult,
    includeCheckoutChooser = true,
  ): InlineKeyboard {
    const kb = new InlineKeyboard();

    if (includeCheckoutChooser && comparison.cheapestStoreId) {
      const cheapestQuote = comparison.quotes.find(
        (q) => q.storeId === comparison.cheapestStoreId,
      );
      if (cheapestQuote && cheapestQuote.inStockCount > 0) {
        const tok = db.saveCallbackPayload({
          kind: 'checkout_store',
          storeId: cheapestQuote.storeId,
        });
        kb.text(
          `🏆 הזמן מהזול ביותר: ${cheapestQuote.meta.shortName} (${formatCurrency(cheapestQuote.estimatedTotal)})`,
          `a:${tok}`,
        ).row();
      }
    }

    // Per-store detailed cart inspection buttons
    const viewButtons = comparison.quotes.filter((q) => !q.error);
    if (viewButtons.length > 0) {
      for (const q of viewButtons) {
        const tok = db.saveCallbackPayload({
          kind: 'store_cart',
          storeId: q.storeId,
        });
        kb.text(`🛒 ${q.meta.emoji} ${q.meta.shortName}`, `a:${tok}`);
      }
      kb.row();
    }

    kb.text('🗑 הסר / ערוך פריטים', 'nav:edit_cart')
      .text('🔄 רענן השוואה', 'nav:compare');
    if (stores.getStore('shufersal')) {
      kb.row().text('🚚 חלונות משלוח', 'nav:slots');
    }
    return kb;
  }

  // Always allow /id so the owner can easily copy chat & user IDs during setup
  bot.command('id', async (ctx) => {
    const chatId = ctx.chat.id;
    const userId = ctx.from?.id ?? 0;
    await ctx.reply(
      `🆔 <b>מזהים להגדרת קובץ <code>.env</code>:</b>\n\n` +
        `• <b>מזהה הצ'אט/קבוצה (<code>ALLOWED_CHAT_IDS</code>):</b> <code>${chatId}</code>\n` +
        `• <b>מזהה המשתמש שלך (<code>ADMIN_USER_IDS</code>):</b> <code>${userId}</code>`,
      { parse_mode: 'HTML' },
    );
  });

  // Authorization middleware for allowed group chats
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    if (
      config.allowedChatIds.length > 0 &&
      !config.allowedChatIds.includes(chatId)
    ) {
      logger.warn(`Ignored update from unauthorized chat ID: ${chatId}`);
      return;
    }

    await next();
  });

  bot.command(['start', 'help'], async (ctx) => {
    const enabledList = stores
      .getEnabledStores()
      .map((s) => `${s.emoji} <b>${escapeHtml(s.displayName)}</b>`)
      .join(' • ');

    await ctx.reply(
      `👋 <b>שלום! אני בוט הקניות החכם להשוואת סלים והזמנה מהסופר הזול ביותר.</b>\n\n` +
        `🏪 <b>רשתות מחוברות:</b> ${enabledList}\n\n` +
        `<b>איך משתמשים?</b>\n` +
        `פשוט כותבים בקבוצה בשפה חופשית מה צריך הביתה, למשל:\n` +
        `• <i>"צריך 2 חלב תנובה 3%, קוטג' ולחם פרוס"</i>\n` +
        `• <i>"תוסיפו חצי קילו עגבניות שרי ובננות קצת ירוקות"</i>\n` +
        `• <i>"תורידו את הקוטג'"</i>\n\n` +
        `אני ממלא אוטומטית את העגלה בכל הרשתות במקביל, משווה מחירים כולל דמי משלוח, ובזמן ההזמנה בוחרים את <b>העגלה הזולה ביותר 🏆</b>!\n\n` +
        `<b>פקודות זמינות:</b>\n` +
        `• /compare – השוואת מחירים חיה בין כל הרשתות וזיהוי הסל הזול ביותר\n` +
        `• /mirror – העתקת כל הפריטים מהעגלה/הזמנה בשופרסל לשאר הרשתות והשוואה\n` +
        `• /cart – צפייה בעגלות ופירוט פריטים בכל חנות\n` +
        `• /remove <code>[מוצר]</code> – הסרה או עריכת כמות של פריטים בעגלות / בהזמנה שנטענה\n` +
        `• /stores – סטטוס החנויות המחוברות וקישורים ישירים\n` +
        `• /search <code>&lt;מוצר&gt;</code> – חיפוש והשוואת מחיר של מוצר בכל הרשתות\n` +
        `• /slots – בחירת יום ושעת משלוח\n` +
        `• /orders – צפייה בהזמנות פעילות וטעינה לעדכון\n` +
        `• /checkout – השוואת עגלות ואישור הזמנה מהסופר הזול ביותר\n` +
        `• /login_haviv <code>&lt;טלפון&gt;</code> – התחברות לסופר חביב באמצעות קוד SMS\n` +
        `• /login_victory <code>&lt;טלפון&gt;</code> – התחברות לויקטורי אונליין באמצעות קוד SMS\n` +
        `• /clear – <b>(מנהלים)</b> ריקון העגלות\n` +
        `• /id – הצגת מזהי הקבוצה והמשתמש`,
      { parse_mode: 'HTML' },
    );
  });

  bot.command('stores', async (ctx) => {
    const list = stores.getEnabledStores();
    const lines = [`🏪 <b>רשתות הסופרמרקט המחוברות לבוט (${list.length}):</b>\n`];
    for (const s of list) {
      const fee =
        s.defaultDeliveryFee !== null
          ? `משלוח מוערך ${formatCurrency(s.defaultDeliveryFee)}`
          : 'ללא משלוח ברירת מחדל';
      const min =
        s.minimumOrderAmount !== null
          ? ` • מינימום ${formatCurrency(s.minimumOrderAmount)}`
          : '';
      const mode = s.supportsAutoCheckout
        ? 'תשלום אוטומטי או קישור קופה'
        : 'מילוי עגלה אוטומטי + קישור ישיר לתשלום';
      const authWarn = stores.getStore(s.id)?.getAuthWarning();
      const warnLine = authWarn
        ? `\n   ⚠️ <i>מצב אורח: ${escapeHtml(authWarn.slice(0, 120))}</i>`
        : '';
      lines.push(
        `${s.emoji} <b>${escapeHtml(s.displayName)}</b>\n` +
          `   🚚 ${fee}${min}\n` +
          `   💳 ${mode}${warnLine}\n` +
          `   🔗 <a href="${escapeHtml(s.cartUrl)}">עגלת ${escapeHtml(s.shortName)}</a>`,
      );
    }
    await ctx.reply(lines.join('\n\n'), { parse_mode: 'HTML' });
  });

  async function renderCompareView(
    chatId: number,
    messageIdToEdit?: number,
  ): Promise<void> {
    const comparison = await stores.compareCarts(chatId);
    const html = renderComparisonHtml(comparison);
    const kb = buildComparisonKeyboard(comparison, true);
    if (messageIdToEdit) {
      await bot.api.editMessageText(chatId, messageIdToEdit, html, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    } else {
      await bot.api.sendMessage(chatId, html, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    }
  }

  bot.command(['compare', 'cheapest'], async (ctx) => {
    const loading = await ctx.reply(
      '⚖️ משווה עגלות ומחירים חיים בין כל הרשתות המחוברות...',
    );
    try {
      await renderCompareView(ctx.chat.id, loading.message_id);
    } catch (err) {
      logger.error('/compare command failed', err);
      await ctx.api.editMessageText(
        ctx.chat.id,
        loading.message_id,
        formatUserFacingError(err),
        { parse_mode: 'HTML' },
      );
    }
  });

  const activeMirrorChats = new Set<number>();

  async function runMirrorForChat(params: {
    chatId: number;
    sourceStoreId: StoreId;
    senderName: string;
  }): Promise<void> {
    const { chatId, sourceStoreId, senderName } = params;
    const sourceMeta = STORE_META[sourceStoreId];

    if (!stores.isMultiStore()) {
      await bot.api.sendMessage(
        chatId,
        'ℹ️ נדרשות לפחות שתי רשתות פעילות כדי להשוות סלים.',
        { parse_mode: 'HTML' },
      );
      return;
    }

    if (activeMirrorChats.has(chatId)) {
      await bot.api.sendMessage(
        chatId,
        '⏳ העתקה והשוואה כבר רצה כרגע בקבוצה – אנא המתינו לסיומה.',
        { parse_mode: 'HTML' },
      );
      return;
    }

    activeMirrorChats.add(chatId);
    const statusMsg = await bot.api.sendMessage(
      chatId,
      `⏳ <b>מעתיק את כל הפריטים מ-${escapeHtml(sourceMeta.displayName)} לשאר הרשתות ומשווה מחירים...</b>\n` +
        `<i>מרוקן עגלות קודמות בשאר הרשתות כדי שההשוואה תהיה מדויקת (1:1).</i>`,
      { parse_mode: 'HTML' },
    );

    try {
      let lastReported = 0;
      const result = await stores.mirrorCartToOtherStores({
        chatId,
        sourceStoreId,
        senderName,
        ai,
        clearTargetFirst: true,
        onProgress: async (done, total) => {
          if (done === total || done === 1 || done - lastReported >= 3) {
            lastReported = done;
            try {
              await bot.api.editMessageText(
                chatId,
                statusMsg.message_id,
                `⏳ <b>מעתיק ומשווה פריטים מ-${escapeHtml(sourceMeta.displayName)}...</b>\n` +
                  `📦 התקדמות: <b>${done}/${total}</b> פריטים` +
                  (done === total ? '\n🔄 מסנכרן עגלות ומחשב מחיר סופי...' : ''),
                { parse_mode: 'HTML' },
              );
            } catch {
              // Ignore transient Telegram rate-limit or unchanged-message edit errors
            }
          }
        },
      });

      if (result.totalSourceItems === 0) {
        await bot.api.editMessageText(
          chatId,
          statusMsg.message_id,
          `🛒 אין פריטים במלאי בעגלת ${escapeHtml(sourceMeta.displayName)} להעתקה והשוואה.\n` +
            `אם יש לכם הזמנה פתוחה בשופרסל, טענו אותה קודם דרך /orders.`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      const buildMirrorHtml = (includeMissingNames: boolean): string => {
        const summaryLines: string[] = [
          `📋 <b>הועתקו ${result.totalSourceItems} פריטים מ-${escapeHtml(sourceMeta.displayName)} לשאר הרשתות:</b>`,
        ];
        for (const s of result.storeSummaries) {
          const guestNote = s.authWarning
            ? ` <i>(מצב אורח – התחברות נכשלה)</i>`
            : '';
          if (s.error) {
            summaryLines.push(
              `${s.meta.emoji} <b>${escapeHtml(s.meta.shortName)}</b>: ⚠️ ${escapeHtml(s.error.slice(0, 140))}`,
            );
          } else {
            let missingNote = ' ✅';
            if (s.missingItems.length > 0) {
              if (includeMissingNames) {
                const sample = s.missingItems
                  .slice(0, 3)
                  .map((n) => escapeHtml(n.slice(0, 35)))
                  .join(', ');
                missingNote = ` (חסרים ${s.missingItems.length}: ${sample}${s.missingItems.length > 3 ? ` +${s.missingItems.length - 3}` : ''})`;
              } else {
                missingNote = ` (חסרים ${s.missingItems.length} פריטים)`;
              }
            }
            summaryLines.push(
              `${s.meta.emoji} <b>${escapeHtml(s.meta.shortName)}</b>: הותאמו <b>${s.matchedCount}/${result.totalSourceItems}</b>${missingNote}${guestNote}`,
            );
          }
        }

        const cancelReminder = result.sourceOrderInUpdateMode
          ? `\n\n💡 <i>שימו לב: אם תבחרו להזמין מרשת אחרת, זכרו לבטל את ההזמנה הפתוחה #${escapeHtml(result.sourceOrderInUpdateMode)} ב-${escapeHtml(sourceMeta.shortName)}.</i>`
          : '';

        return (
          `${summaryLines.join('\n')}\n\n` +
          renderComparisonHtml(result.comparison) +
          cancelReminder
        );
      };

      let fullHtml = buildMirrorHtml(true);
      if (fullHtml.length > 3950) {
        fullHtml = buildMirrorHtml(false);
      }
      if (fullHtml.length > 4000) {
        fullHtml = `${fullHtml.slice(0, 3980)}...`;
      }

      await bot.api.editMessageText(chatId, statusMsg.message_id, fullHtml, {
        parse_mode: 'HTML',
        reply_markup: buildComparisonKeyboard(result.comparison, true),
      });
    } catch (err) {
      logger.error(`Mirror from ${sourceStoreId} failed`, err);
      await bot.api
        .editMessageText(
          chatId,
          statusMsg.message_id,
          formatUserFacingError(err),
          { parse_mode: 'HTML' },
        )
        .catch(() => {});
    } finally {
      activeMirrorChats.delete(chatId);
    }
  }

  bot.command('mirror', async (ctx) => {
    const sourceStoreId = stores.getPrimaryStore().storeId;
    await runMirrorForChat({
      chatId: ctx.chat.id,
      sourceStoreId,
      senderName: getSenderDisplayName(ctx),
    });
  });

  const OTP_PENDING_TTL_MS = 5 * 60_000;
  const pendingOtpByChat = new Map<
    number,
    { storeId: StoreId; expiresAt: number }
  >();
  const activeOtpChats = new Set<number>();

  async function handleStartSmsOtpLogin(
    ctx: Context,
    storeId: StoreId,
    rawPhone: string,
  ): Promise<void> {
    if (!ctx.chat) return;
    const chatId = ctx.chat.id;
    const meta = STORE_META[storeId];
    const cmdName =
      storeId === 'super_haviv' ? '/login_haviv' : '/login_victory';

    if (!stores.getStore(storeId)) {
      await ctx.reply(
        `❌ ${meta.emoji} <b>${escapeHtml(meta.displayName)}</b> אינה מופעלת כרגע ב-<code>ENABLED_STORES</code>.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    const trimmedPhone = rawPhone.trim();
    if (!trimmedPhone) {
      await ctx.reply(
        `📱 <b>התחברות ל-${meta.emoji} ${escapeHtml(meta.displayName)} באמצעות SMS</b>\n\n` +
          `שלחו את הפקודה עם מספר הנייד שלכם:\n` +
          `<code>${cmdName} 0501234567</code>\n\n` +
          `לאחר קבלת ההודעה ב-SMS, פשוט כתבו את הקוד בצ'אט (או <code>/otp 123456</code>).`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    const normalizedPhone = normalizeIsraeliPhone(trimmedPhone);
    if (!normalizedPhone) {
      await ctx.reply(
        `❌ מספר הטלפון לא תקין. נא להזין מספר נייד ישראלי, למשל:\n<code>${cmdName} 0501234567</code>`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    if (activeOtpChats.has(chatId)) {
      await ctx.reply('⏳ כבר יש תהליך התחברות SMS פעיל בצ׳אט זה, רגע...');
      return;
    }

    activeOtpChats.add(chatId);
    const statusMsg = await ctx.reply(
      `⏳ שולח בקשת קוד SMS מ-${meta.emoji} <b>${escapeHtml(meta.displayName)}</b>...`,
      { parse_mode: 'HTML' },
    );

    try {
      const res = await stores.startSmsOtpLogin(storeId, normalizedPhone);
      pendingOtpByChat.set(chatId, {
        storeId,
        expiresAt: Date.now() + OTP_PENDING_TTL_MS,
      });
      await bot.api
        .editMessageText(
          chatId,
          statusMsg.message_id,
          `📲 <b>${escapeHtml(meta.displayName)}</b>\n${escapeHtml(res.message)}\n\n` +
            `<i>פשוט שלחו את הקוד כהודעה רגילה בצ׳אט (או <code>/otp 123456</code>) בתוך 5 דקות.</i>`,
          { parse_mode: 'HTML' },
        )
        .catch(() => {});
    } catch (err) {
      logger.warn(`SMS OTP login start failed for ${storeId}`, err);
      await bot.api
        .editMessageText(
          chatId,
          statusMsg.message_id,
          formatUserFacingError(err),
          { parse_mode: 'HTML' },
        )
        .catch(() => {});
    } finally {
      activeOtpChats.delete(chatId);
    }
  }

  async function handleCompleteSmsOtpLogin(
    ctx: Context,
    rawCode: string,
  ): Promise<void> {
    if (!ctx.chat) return;
    const chatId = ctx.chat.id;
    const pending = pendingOtpByChat.get(chatId);
    if (!pending || Date.now() > pending.expiresAt) {
      pendingOtpByChat.delete(chatId);
      await ctx.reply(
        `ℹ️ אין כרגע בקשת קוד SMS פעילה.\nלהתחברות שלחו <code>/login_haviv 05XXXXXXXX</code> או <code>/login_victory 05XXXXXXXX</code>.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    const code = rawCode.replace(/\D/g, '');
    if (code.length < 4 || code.length > 8) {
      await ctx.reply(
        `❌ קוד האימות צריך להכיל 4–8 ספרות. נסו שוב או שלחו <code>/otp 123456</code>.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    if (activeOtpChats.has(chatId)) {
      await ctx.reply('⏳ כבר מאמת קוד SMS, רגע...');
      return;
    }

    const meta = STORE_META[pending.storeId];
    activeOtpChats.add(chatId);
    const statusMsg = await ctx.reply(
      `⏳ מאמת קוד SMS מול ${meta.emoji} <b>${escapeHtml(meta.displayName)}</b>...`,
      { parse_mode: 'HTML' },
    );

    try {
      const res = await stores.completeSmsOtpLogin(pending.storeId, code);
      pendingOtpByChat.delete(chatId);
      await bot.api
        .editMessageText(
          chatId,
          statusMsg.message_id,
          `✅ <b>${escapeHtml(meta.displayName)}</b>\n${escapeHtml(res.message)}`,
          { parse_mode: 'HTML' },
        )
        .catch(() => {});
    } catch (err) {
      logger.warn(`SMS OTP login completion failed for ${pending.storeId}`, err);
      const errMsg = err instanceof Error ? err.message : String(err);
      if (
        err instanceof StoreManualVerificationRequiredError ||
        /פג תוקף|נסגר|אין חלון|אין תהליך/i.test(errMsg)
      ) {
        pendingOtpByChat.delete(chatId);
      }
      await bot.api
        .editMessageText(
          chatId,
          statusMsg.message_id,
          formatUserFacingError(err),
          { parse_mode: 'HTML' },
        )
        .catch(() => {});
    } finally {
      activeOtpChats.delete(chatId);
    }
  }

  bot.command('login_haviv', async (ctx) => {
    await handleStartSmsOtpLogin(ctx, 'super_haviv', ctx.match ?? '');
  });

  bot.command('login_victory', async (ctx) => {
    await handleStartSmsOtpLogin(ctx, 'victory', ctx.match ?? '');
  });

  bot.command('otp', async (ctx) => {
    await handleCompleteSmsOtpLogin(ctx, ctx.match ?? '');
  });

  function buildStoreCartActionKeyboard(
    storeId: StoreId,
    orderInUpdateMode: string | null,
    hasItems: boolean,
  ): InlineKeyboard {
    const meta = STORE_META[storeId];
    const kb = new InlineKeyboard();

    if (hasItems) {
      const editTok = db.saveCallbackPayload({
        kind: 'cart_edit_page',
        storeId,
        page: 0,
      });
      kb.text(
        orderInUpdateMode
          ? '🗑 הסר / ערוך פריטים בהזמנה'
          : `🗑 הסר / ערוך פריטים (${meta.shortName})`,
        `a:${editTok}`,
      ).row();
    }

    const refreshTok = db.saveCallbackPayload({
      kind: 'store_cart',
      storeId,
    });
    kb.text('🔄 רענן עגלה', `a:${refreshTok}`);
    if (storeId === 'shufersal' && !orderInUpdateMode) {
      kb.text('🚚 בחר חלון משלוח', 'nav:slots');
    }
    if (hasItems && stores.isMultiStore()) {
      const mirrorTok = db.saveCallbackPayload({
        kind: 'mirror_cart',
        sourceStoreId: storeId,
      });
      kb.row().text(
        orderInUpdateMode
          ? '📋 העתק והשווה את ההזמנה בשאר הרשתות'
          : `📋 העתק והשווה מ-${meta.shortName} בשאר הרשתות`,
        `a:${mirrorTok}`,
      );
    }
    if (stores.isMultiStore()) {
      kb.row().text('⚖️ השוואת כל הרשתות', 'nav:compare');
    }
    if (hasItems) {
      const checkoutTok = db.saveCallbackPayload({
        kind: 'checkout_store',
        storeId,
      });
      kb.row().text(
        orderInUpdateMode
          ? `💳 שמור עדכון הזמנה #${orderInUpdateMode}`
          : `💳 המשך להזמנה ב-${meta.shortName}`,
        `a:${checkoutTok}`,
      );
    }
    return kb;
  }

  async function renderCartEditView(
    chatId: number,
    storeId: StoreId,
    page: number,
    messageIdToEdit?: number,
    noticeText?: string,
  ): Promise<void> {
    const mgr = stores.getStore(storeId) ?? stores.getPrimaryStore();
    const cart = await mgr.getEnrichedCart(chatId);

    if (cart.items.length === 0) {
      const emptyMsg =
        (noticeText ? `${noticeText}\n\n` : '') +
        `🛒 עגלת ${mgr.meta.emoji} <b>${escapeHtml(mgr.meta.displayName)}</b> ריקה כרגע – אין פריטים נוספים להסרה.`;
      const kb = new InlineKeyboard();
      if (stores.isMultiStore()) {
        for (const other of stores.getEnabledStores()) {
          if (other.id === mgr.storeId) continue;
          const otherTok = db.saveCallbackPayload({
            kind: 'cart_edit_page',
            storeId: other.id,
            page: 0,
          });
          kb.text(`🗑 ערוך ${other.emoji} ${other.shortName}`, `a:${otherTok}`);
        }
        kb.row();
      }
      kb.text('⬅️ חזרה לעגלה', 'nav:cart');
      if (messageIdToEdit) {
        await bot.api.editMessageText(chatId, messageIdToEdit, emptyMsg, {
          parse_mode: 'HTML',
          reply_markup: kb,
        });
      } else {
        await bot.api.sendMessage(chatId, emptyMsg, {
          parse_mode: 'HTML',
          reply_markup: kb,
        });
      }
      return;
    }

    const ITEMS_PER_PAGE = 8;
    const totalPages = Math.max(1, Math.ceil(cart.items.length / ITEMS_PER_PAGE));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const startIdx = safePage * ITEMS_PER_PAGE;
    const pageItems = cart.items.slice(startIdx, startIdx + ITEMS_PER_PAGE);

    const header = cart.orderInUpdateMode
      ? `🗑 <b>הסרה ועריכת פריטים – הזמנה #${escapeHtml(cart.orderInUpdateMode)} (${escapeHtml(mgr.meta.shortName)})</b>`
      : `🗑 <b>הסרה ועריכת פריטים ב-${mgr.meta.emoji} ${escapeHtml(mgr.meta.displayName)}</b>`;

    const lines: string[] = [header];
    if (noticeText) {
      lines.push(noticeText);
    }
    lines.push(
      `לחצו <b>❌</b> להסרה מלאה של מוצר, או <b>➖</b> להפחתת כמות (סה"כ כעת: <b>${formatCurrency(cart.totalPrice)}</b> • ${cart.items.length} פריטים` +
        (totalPages > 1 ? ` • עמוד ${safePage + 1}/${totalPages}` : '') +
        `):`,
    );

    const kb = new InlineKeyboard();
    for (const item of pageItems) {
      const displayName = item.productName ?? item.productCode;
      const sellingMethod = item.sellingMethod ?? 'BY_UNIT';
      const qtyShort = formatQuantity(item.quantity, sellingMethod);
      const oosPrefix = item.inStock ? '' : '⚠️ ';
      const rmTok = db.saveCallbackPayload({
        kind: 'cart_item_op',
        storeId: mgr.storeId,
        productCode: item.productCode,
        sellingMethod,
        op: 'rm',
        page: safePage,
      });
      const decTok = db.saveCallbackPayload({
        kind: 'cart_item_op',
        storeId: mgr.storeId,
        productCode: item.productCode,
        sellingMethod,
        op: 'dec',
        page: safePage,
      });

      const truncatedName =
        displayName.length > 24 ? `${displayName.slice(0, 23)}…` : displayName;
      kb.text(`❌ ${oosPrefix}${truncatedName} (${qtyShort})`, `a:${rmTok}`)
        .text('➖', `a:${decTok}`)
        .row();
    }

    if (totalPages > 1) {
      if (safePage > 0) {
        const prevTok = db.saveCallbackPayload({
          kind: 'cart_edit_page',
          storeId: mgr.storeId,
          page: safePage - 1,
        });
        kb.text('⬅️ הקודם', `a:${prevTok}`);
      }
      if (safePage < totalPages - 1) {
        const nextTok = db.saveCallbackPayload({
          kind: 'cart_edit_page',
          storeId: mgr.storeId,
          page: safePage + 1,
        });
        kb.text('הבא ➡️', `a:${nextTok}`);
      }
      kb.row();
    }

    if (stores.isMultiStore()) {
      for (const s of stores.getEnabledStores()) {
        if (s.id === mgr.storeId) continue;
        const switchTok = db.saveCallbackPayload({
          kind: 'cart_edit_page',
          storeId: s.id,
          page: 0,
        });
        kb.text(`${s.emoji} ${s.shortName}`, `a:${switchTok}`);
      }
      kb.row();
    }

    const backCartTok = db.saveCallbackPayload({
      kind: 'store_cart',
      storeId: mgr.storeId,
    });
    const checkoutTok = db.saveCallbackPayload({
      kind: 'checkout_store',
      storeId: mgr.storeId,
    });
    kb.text('⬅️ חזרה לעגלה', `a:${backCartTok}`).text(
      cart.orderInUpdateMode ? '💳 שמור עדכון' : '💳 להזמנה',
      `a:${checkoutTok}`,
    );

    const text = lines.join('\n\n');
    if (messageIdToEdit) {
      await bot.api.editMessageText(chatId, messageIdToEdit, text, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    } else {
      await bot.api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    }
  }

  async function renderSingleStoreCartView(
    chatId: number,
    storeId: StoreId,
    messageIdToEdit?: number,
  ): Promise<void> {
    const mgr = stores.getStore(storeId) ?? stores.getPrimaryStore();
    const [cart, slot] = await Promise.all([
      mgr.getEnrichedCart(chatId),
      mgr.getSelectedSlot().catch(() => null),
    ]);

    const kb = buildStoreCartActionKeyboard(
      mgr.storeId,
      cart.orderInUpdateMode,
      cart.items.length > 0,
    );

    const html = renderCartSummaryHtml(mgr.meta, cart, slot);
    if (messageIdToEdit) {
      await bot.api.editMessageText(chatId, messageIdToEdit, html, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    } else {
      await bot.api.sendMessage(chatId, html, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    }
  }

  bot.command(['cart', 'agala'], async (ctx) => {
    const loading = await ctx.reply(
      stores.isMultiStore()
        ? '🔄 טוען ומשווה את העגלות מכל הרשתות...'
        : '🔄 טוען את מצב העגלה...',
    );
    try {
      if (stores.isMultiStore()) {
        await renderCompareView(ctx.chat.id, loading.message_id);
      } else {
        await renderSingleStoreCartView(
          ctx.chat.id,
          stores.getPrimaryStore().storeId,
          loading.message_id,
        );
      }
    } catch (err) {
      logger.error('/cart command failed', err);
      await ctx.api.editMessageText(
        ctx.chat.id,
        loading.message_id,
        formatUserFacingError(err),
        { parse_mode: 'HTML' },
      );
    }
  });

  bot.command(['remove', 'edit'], async (ctx) => {
    const query = ctx.match.trim();
    if (!query) {
      const loading = await ctx.reply(
        '🗑 טוען את רשימת הפריטים בעגלה להסרה/עריכה...',
      );
      try {
        await renderCartEditView(
          ctx.chat.id,
          stores.getPrimaryStore().storeId,
          0,
          loading.message_id,
        );
      } catch (err) {
        logger.error('/remove command failed', err);
        await ctx.api.editMessageText(
          ctx.chat.id,
          loading.message_id,
          formatUserFacingError(err),
          { parse_mode: 'HTML' },
        );
      }
      return;
    }

    const loading = await ctx.reply(
      `🗑 מחפש ומסיר את <b>${escapeHtml(query)}</b> מהעגלות...`,
      { parse_mode: 'HTML' },
    );
    try {
      const results = await stores.removeAcrossStores({
        chatId: ctx.chat.id,
        query,
      });
      const removedAny = results.filter((r) => r.removedItem);

      if (removedAny.length === 0) {
        const kb = new InlineKeyboard().text(
          '🗑 פתח רשימת פריטים להסרה',
          'nav:edit_cart',
        );
        await ctx.api.editMessageText(
          ctx.chat.id,
          loading.message_id,
          `ℹ️ לא נמצא באף עגלה מוצר תואם ל-"<b>${escapeHtml(query)}</b>".\nלחצו על הכפתור כדי לבחור מתוך רשימת הפריטים בעגלה:`,
          { parse_mode: 'HTML', reply_markup: kb },
        );
        return;
      }

      const kb = new InlineKeyboard()
        .text('🗑 הסר פריטים נוספים', 'nav:edit_cart')
        .text('🛒 הצג עגלות', 'nav:cart');
      await ctx.api.editMessageText(
        ctx.chat.id,
        loading.message_id,
        `🗑 <b>הוסר מהעגלות:</b> ${escapeHtml(query)}\n` +
          removedAny
            .map(
              (r) =>
                `${r.meta.emoji} ${escapeHtml(r.meta.shortName)}: ${escapeHtml(r.removedItem!.productName ?? r.removedItem!.productCode)}` +
                (r.cart ? ` (עגלה: ${formatCurrency(r.cart.totalPrice)})` : ''),
            )
            .join('\n'),
        { parse_mode: 'HTML', reply_markup: kb },
      );
    } catch (err) {
      logger.error('/remove <query> command failed', err);
      await ctx.api.editMessageText(
        ctx.chat.id,
        loading.message_id,
        formatUserFacingError(err),
        { parse_mode: 'HTML' },
      );
    }
  });

  bot.command('search', async (ctx) => {
    const query = ctx.match.trim();
    if (!query) {
      await ctx.reply(
        '🔎 שימוש: <code>/search שם מוצר</code> (למשל: <code>/search חלב תנובה 3%</code>)',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const loading = await ctx.reply(
      `🔎 מחפש <b>${escapeHtml(query)}</b> בכל הרשתות המחוברות...`,
      { parse_mode: 'HTML' },
    );

    try {
      const storeResults = await stores.searchAcrossStores(query, 4);
      const kb = new InlineKeyboard();
      const lines = [
        `🔎 <b>השוואת תוצאות חיפוש עבור "${escapeHtml(query)}":</b>\nלחצו על מוצר להוספה מיידית לעגלה של אותה רשת:\n`,
      ];

      let totalFound = 0;
      for (const sr of storeResults) {
        const inStock = sr.products
          .filter((p) => p.inStock && p.purchasable)
          .slice(0, 3);
        lines.push(`${sr.meta.emoji} <b>${escapeHtml(sr.meta.displayName)}:</b>`);
        if (sr.error) {
          lines.push(`   ⚠️ <i>${escapeHtml(sr.error.slice(0, 90))}</i>`);
          continue;
        }
        if (inStock.length === 0) {
          lines.push(`   <i>לא נמצאו מוצרים במלאי</i>`);
          continue;
        }

        inStock.forEach((prod, i) => {
          totalFound++;
          const unit = prod.unitDescription
            ? ` (${escapeHtml(prod.unitDescription)})`
            : '';
          lines.push(
            `   ${i + 1}. <b>${escapeHtml(prod.name)}</b>${unit} — <b>${escapeHtml(prod.formattedPrice)}</b>`,
          );
          const tok = db.saveCallbackPayload({
            kind: 'search_add',
            storeId: sr.storeId,
            chatId: ctx.chat.id,
            query,
            product: prod,
          });
          kb.text(
            `➕ ${sr.meta.emoji} ${prod.name.slice(0, 22)} (${prod.formattedPrice})`,
            `a:${tok}`,
          ).row();
        });
      }

      if (totalFound === 0) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          loading.message_id,
          `😕 לא נמצאו מוצרים במלאי עבור <b>${escapeHtml(query)}</b>.`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      await ctx.api.editMessageText(
        ctx.chat.id,
        loading.message_id,
        lines.join('\n'),
        { parse_mode: 'HTML', reply_markup: kb },
      );
    } catch (err) {
      logger.error('/search command failed', err);
      await ctx.api.editMessageText(
        ctx.chat.id,
        loading.message_id,
        formatUserFacingError(err),
        { parse_mode: 'HTML' },
      );
    }
  });

  async function renderSlotsPicker(
    chatId: number,
    storeId: StoreId,
    messageIdToEdit?: number,
    selectedDayKey?: string,
  ): Promise<void> {
    const mgr = stores.getStore(storeId) ?? stores.getPrimaryStore();
    const slots = await mgr.getAvailableSlots();
    if (slots.length === 0) {
      const msg =
        `😕 לא נמצאו חלונות משלוח זמינים דרך ה-API ב-${mgr.meta.displayName}.\n` +
        `ניתן לבחור חלון משלוח ישירות בקישור: ${mgr.meta.cartUrl}`;
      if (messageIdToEdit) {
        await bot.api.editMessageText(chatId, messageIdToEdit, msg);
      } else {
        await bot.api.sendMessage(chatId, msg);
      }
      return;
    }

    const byDay = new Map<string, { label: string; slots: DeliverySlot[] }>();
    for (const s of slots) {
      const { dateKey, label } = formatHebrewDayHeader(s.startIso);
      const group = byDay.get(dateKey) ?? { label, slots: [] };
      group.slots.push(s);
      byDay.set(dateKey, group);
    }

    const kb = new InlineKeyboard();
    let text: string;

    if (!selectedDayKey || !byDay.has(selectedDayKey)) {
      text =
        `🚚 <b>בחירת יום משלוח ב-${escapeHtml(mgr.meta.displayName)}:</b>\n` +
        `בחרו את היום המבוקש מתוך החלונות הפנויים:`;
      for (const [dateKey, group] of byDay.entries()) {
        const tok = db.saveCallbackPayload({
          kind: 'slot_day',
          storeId: mgr.storeId,
          dateKey,
        });
        kb.text(
          `📅 ${group.label} (${group.slots.length} חלונות)`,
          `a:${tok}`,
        ).row();
      }
    } else {
      const group = byDay.get(selectedDayKey)!;
      text =
        `🕒 <b>בחירת שעת משלוח עבור ${escapeHtml(group.label)} (${escapeHtml(mgr.meta.shortName)}):</b>\n` +
        `לחצו על השעה הרצויה לשריון המשלוח בעגלה:`;

      for (const s of group.slots) {
        const hours = s.endHourText
          ? `${s.startHourText}–${s.endHourText}`
          : s.startHourText;
        const fee =
          s.deliveryFee !== null ? ` (${formatCurrency(s.deliveryFee)})` : '';
        const fullLabel = `${group.label} ${hours}`;
        const tok = db.saveCallbackPayload({
          kind: 'slot_pick',
          storeId: mgr.storeId,
          slotCode: s.code,
          label: fullLabel,
        });
        kb.text(`🕒 ${hours}${fee}`, `a:${tok}`).row();
      }
      kb.text('⬅️ חזרה לבחירת יום', 'nav:slots');
    }

    if (messageIdToEdit) {
      await bot.api.editMessageText(chatId, messageIdToEdit, text, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    } else {
      await bot.api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    }
  }

  bot.command('slots', async (ctx) => {
    const targetStore = stores.getStore('shufersal') ?? stores.getPrimaryStore();
    const loading = await ctx.reply(
      `🚚 בודק חלונות משלוח פנויים ב-${targetStore.meta.displayName}...`,
    );
    try {
      await renderSlotsPicker(
        ctx.chat.id,
        targetStore.storeId,
        loading.message_id,
      );
    } catch (err) {
      logger.error('/slots command failed', err);
      await ctx.api.editMessageText(
        ctx.chat.id,
        loading.message_id,
        formatUserFacingError(err),
        { parse_mode: 'HTML' },
      );
    }
  });

  bot.command('orders', async (ctx) => {
    const shufersal = stores.getStore('shufersal');
    if (!shufersal) {
      await ctx.reply(
        'ℹ️ מעקב ועדכון הזמנות פתוחות נתמך כרגע בחשבון שופרסל אונליין.',
      );
      return;
    }

    const loading = await ctx.reply('📦 בודק הזמנות פעילות בחשבון שופרסל...');
    try {
      const orders = await shufersal.getActiveOrders();
      if (orders.length === 0) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          loading.message_id,
          '📭 אין כרגע הזמנות פעילות ממתינות בחשבון שופרסל.',
        );
        return;
      }

      const kb = new InlineKeyboard();
      const lines = [`📦 <b>הזמנות פעילות בשופרסל אונליין:</b>\n`];

      orders.forEach((order, i) => {
        const dtText = formatHebrewDateTime(
          order.deliveryIso,
          order.deliveryHoursText?.split('–')[1] ?? null,
        );
        const updateDeadline = order.updatableUntilText
          ? `\n   ⏳ ניתן לעדכון עד: ${escapeHtml(order.updatableUntilText)}`
          : '';
        const activeTag = order.isBeingUpdated
          ? ' ✅ <b>(נטענה כעת לעגלה לעדכון!)</b>'
          : '';

        lines.push(
          `${i + 1}. <b>הזמנה #${escapeHtml(order.code)}</b>${activeTag}\n` +
            `   🚚 משלוח: ${escapeHtml(dtText)}\n` +
            `   💰 סה"כ: ${formatCurrency(order.totalPrice)} (${order.totalItems} פריטים)` +
            updateDeadline,
        );

        if (order.isUpdatable && !order.isBeingUpdated) {
          const tok = db.saveCallbackPayload({
            kind: 'order_edit',
            storeId: 'shufersal',
            orderCode: order.code,
          });
          kb.text(`✏️ טען הזמנה #${order.code} לעדכון מוצרים`, `a:${tok}`).row();
        }
      });

      await ctx.api.editMessageText(
        ctx.chat.id,
        loading.message_id,
        lines.join('\n\n'),
        { parse_mode: 'HTML', reply_markup: kb },
      );
    } catch (err) {
      logger.error('/orders command failed', err);
      await ctx.api.editMessageText(
        ctx.chat.id,
        loading.message_id,
        formatUserFacingError(err),
        { parse_mode: 'HTML' },
      );
    }
  });

  async function renderMultiStoreCheckoutChooser(
    chatId: number,
    messageIdToEdit?: number,
  ): Promise<void> {
    const comparison = await stores.compareCarts(chatId);
    const validQuotes = comparison.quotes.filter(
      (q) => !q.error && q.inStockCount > 0,
    );

    if (validQuotes.length === 0) {
      const msg =
        '🛒 כל העגלות ריקות ממוצרים במלאי – לא ניתן לבצע הזמנה כרגע.';
      if (messageIdToEdit) {
        await bot.api.editMessageText(chatId, messageIdToEdit, msg);
      } else {
        await bot.api.sendMessage(chatId, msg);
      }
      return;
    }

    if (validQuotes.length === 1) {
      await renderCheckoutConfirmationForStore(
        chatId,
        validQuotes[0]!.storeId,
        messageIdToEdit,
      );
      return;
    }

    const html =
      renderComparisonHtml(
        comparison,
        '💳 בחירת הסופר הזול ביותר לסגירת הזמנה',
      ) +
      `\n\n🔐 <i>בחרו את הרשת שתרצו להזמין ממנה (מומלץ: הסל הזול ביותר 🏆).</i>`;

    const kb = new InlineKeyboard();
    validQuotes.forEach((q, idx) => {
      const tok = db.saveCallbackPayload({
        kind: 'checkout_store',
        storeId: q.storeId,
      });
      const prefix = idx === 0 ? '🏆 הזמן מהזול ביותר:' : '💳 הזמן מ-';
      kb.text(
        `${prefix} ${q.meta.emoji} ${q.meta.shortName} (${formatCurrency(q.estimatedTotal)})`,
        `a:${tok}`,
      ).row();
    });
    kb.text('❌ ביטול', 'nav:cancel');

    if (messageIdToEdit) {
      await bot.api.editMessageText(chatId, messageIdToEdit, html, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    } else {
      await bot.api.sendMessage(chatId, html, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    }
  }

  async function renderCheckoutConfirmationForStore(
    chatId: number,
    storeId: StoreId,
    messageIdToEdit?: number,
  ): Promise<void> {
    const mgr = stores.getStore(storeId) ?? stores.getPrimaryStore();
    const snapshot = await mgr.getPreCheckoutSnapshot(chatId);
    const { cart, selectedSlot, activeOrders } = snapshot;

    const inStockCount = cart.items.filter((i) => i.inStock).length;
    if (inStockCount === 0) {
      const msg = `🛒 עגלת ${mgr.meta.displayName} ריקה ממוצרים במלאי – לא ניתן לבצע הזמנה כרגע.`;
      if (messageIdToEdit) {
        await bot.api.editMessageText(chatId, messageIdToEdit, msg);
      } else {
        await bot.api.sendMessage(chatId, msg);
      }
      return;
    }

    if (
      mgr.storeId === 'shufersal' &&
      !selectedSlot &&
      !cart.orderInUpdateMode
    ) {
      const updatableOrder = activeOrders.find((o) => o.isUpdatable);
      const kb = new InlineKeyboard().text('🚚 בחר חלון משלוח חדש', 'nav:slots');
      if (updatableOrder) {
        const editTok = db.saveCallbackPayload({
          kind: 'order_edit',
          storeId: 'shufersal',
          orderCode: updatableOrder.code,
        });
        kb.row().text(
          `✏️ או טען הזמנה פעילה #${updatableOrder.code} לעדכון`,
          `a:${editTok}`,
        );
      }
      if (stores.isMultiStore()) {
        kb.row().text('⬅️ חזרה לבחירת חנות', 'nav:checkout');
      }

      const msg =
        `⚠️ <b>לפני השלמת ההזמנה בשופרסל יש לבחור חלון משלוח</b>\n\n` +
        `בעגלה יש כרגע <b>${inStockCount} פריטים</b> בסך <b>${formatCurrency(cart.totalPrice)}</b>, אך טרם שוריין מועד משלוח.`;
      if (messageIdToEdit) {
        await bot.api.editMessageText(chatId, messageIdToEdit, msg, {
          parse_mode: 'HTML',
          reply_markup: kb,
        });
      } else {
        await bot.api.sendMessage(chatId, msg, {
          parse_mode: 'HTML',
          reply_markup: kb,
        });
      }
      return;
    }

    const updatingOrder = cart.orderInUpdateMode
      ? activeOrders.find((o) => o.code === cart.orderInUpdateMode)
      : undefined;

    const summaryHtml = renderCartSummaryHtml(mgr.meta, cart, selectedSlot);
    const isGuestNoSync = Boolean(cart.isGuestSession && !mgr.meta.supportsAutoCheckout);
    const modeNote = cart.orderInUpdateMode
      ? `\n\n📌 <b>פעולה:</b> שמירת עדכון להזמנה קיימת <b>#${escapeHtml(cart.orderInUpdateMode)}</b>` +
        (updatingOrder
          ? ` (${escapeHtml(formatHebrewDateTime(updatingOrder.deliveryIso))})`
          : '')
      : mgr.meta.supportsAutoCheckout
        ? `\n\n📌 <b>פעולה:</b> יצירת הזמנה חדשה וחיוב כרטיס האשראי השמור ב-${escapeHtml(mgr.meta.displayName)}`
        : isGuestNoSync
          ? `\n\n⚠️ <b>שים לב (מצב אורח):</b> הבוט אינו מחובר לחשבון שלכם ב-${escapeHtml(mgr.meta.shortName)}, ולכן הקישור לאתר יפתח עגלה ריקה (ההשוואה היא למחיר בלבד). כדי שהבוט ימלא אוטומטית את העגלה בחשבון שלכם, הוסיפו פרטי התחברות ל-<code>.env</code>.`
          : `\n\n📌 <b>פעולה:</b> סנכרון העגלה לחשבון שלכם ב-${escapeHtml(mgr.meta.displayName)} וקבלת קישור ישיר להשלמת התשלום`;

    const confirmTok = db.saveCallbackPayload({
      kind: 'checkout_exec',
      storeId: mgr.storeId,
      removeMissingItems: config.autoRemoveOutOfStock,
    });

    const kb = new InlineKeyboard()
      .text(
        cart.orderInUpdateMode
          ? `✅ אשר ושמור עדכון הזמנה #${cart.orderInUpdateMode}`
          : isGuestNoSync
            ? `📋 הצג רשימת קניות וקישור ל-${mgr.meta.shortName}`
            : `✅ אשר ובצע הזמנה ב-${mgr.meta.shortName}`,
        `a:${confirmTok}`,
      )
      .row();

    if (mgr.storeId === 'shufersal') {
      kb.text('🕒 החלף חלון משלוח', 'nav:slots');
    }
    if (stores.isMultiStore()) {
      kb.text('⚖️ החלף חנות', 'nav:checkout');
    }
    kb.text('❌ ביטול', 'nav:cancel');

    const fullText = `${summaryHtml}${modeNote}`;

    if (messageIdToEdit) {
      await bot.api.editMessageText(chatId, messageIdToEdit, fullText, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    } else {
      await bot.api.sendMessage(chatId, fullText, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    }
  }

  bot.command('checkout', async (ctx) => {
    const loading = await ctx.reply(
      stores.isMultiStore()
        ? '💳 משווה את כל העגלות ומאתר את הסופר הזול ביותר להזמנה...'
        : '💳 מכין סיכום הזמנה ובודק חלון משלוח...',
    );
    try {
      if (stores.isMultiStore()) {
        await renderMultiStoreCheckoutChooser(ctx.chat.id, loading.message_id);
      } else {
        await renderCheckoutConfirmationForStore(
          ctx.chat.id,
          stores.getPrimaryStore().storeId,
          loading.message_id,
        );
      }
    } catch (err) {
      logger.error('/checkout command failed', err);
      await ctx.api.editMessageText(
        ctx.chat.id,
        loading.message_id,
        formatUserFacingError(err),
        { parse_mode: 'HTML' },
      );
    }
  });

  bot.command('clear', async (ctx) => {
    if (!(await isUserAdmin(ctx))) {
      await ctx.reply(
        `⛔ רק מנהל/ת הקבוצה רשאי/ת לרוקן את העגלה.\n<i>(מזהה המשתמש שלך: <code>${ctx.from?.id ?? ''}</code>)</i>`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    const allTok = db.saveCallbackPayload({
      kind: 'clear_store',
      storeId: 'all',
    });
    const kb = new InlineKeyboard().text(
      stores.isMultiStore()
        ? '🗑 כן, רוקן את כל העגלות בכל החנויות'
        : '🗑 כן, רוקן את כל העגלה',
      `a:${allTok}`,
    );

    if (stores.isMultiStore()) {
      kb.row();
      for (const meta of stores.getEnabledStores()) {
        const sTok = db.saveCallbackPayload({
          kind: 'clear_store',
          storeId: meta.id,
        });
        kb.text(`🗑 ${meta.emoji} ${meta.shortName}`, `a:${sTok}`);
      }
    }
    kb.row().text('ביטול', 'nav:cancel');

    await ctx.reply(
      stores.isMultiStore()
        ? '⚠️ איזו עגלה לרוקן?'
        : '⚠️ האם לרוקן לחלוטין את כל המוצרים מהעגלה?',
      { reply_markup: kb },
    );
  });

  // Callback queries handler (inline buttons)
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) {
      await ctx.answerCallbackQuery();
      return;
    }

    try {
      if (data === 'nav:cancel') {
        await ctx.answerCallbackQuery('בוטל');
        await ctx.editMessageText('הפעולה בוטלה.');
        return;
      }

      if (data === 'nav:compare' || data === 'nav:cart') {
        await ctx.answerCallbackQuery('מרענן השוואת עגלות...');
        if (stores.isMultiStore()) {
          await renderCompareView(chatId, messageId);
        } else {
          await renderSingleStoreCartView(
            chatId,
            stores.getPrimaryStore().storeId,
            messageId,
          );
        }
        return;
      }

      if (data === 'nav:edit_cart') {
        await ctx.answerCallbackQuery('פותח רשימת פריטים להסרה ועריכה...');
        await renderCartEditView(
          chatId,
          stores.getPrimaryStore().storeId,
          0,
          messageId,
        );
        return;
      }

      if (data === 'nav:slots') {
        await ctx.answerCallbackQuery('טוען חלונות משלוח...');
        const target = stores.getStore('shufersal') ?? stores.getPrimaryStore();
        await renderSlotsPicker(chatId, target.storeId, messageId);
        return;
      }

      if (data === 'nav:checkout') {
        await ctx.answerCallbackQuery('משווה עגלות ומכין סיכום...');
        if (stores.isMultiStore()) {
          await renderMultiStoreCheckoutChooser(chatId, messageId);
        } else {
          await renderCheckoutConfirmationForStore(
            chatId,
            stores.getPrimaryStore().storeId,
            messageId,
          );
        }
        return;
      }

      if (data === 'admin:clear_confirm') {
        if (!(await isUserAdmin(ctx))) {
          await ctx.answerCallbackQuery({
            text: '⛔ למנהלים בלבד',
            show_alert: true,
          });
          return;
        }
        await ctx.answerCallbackQuery('מרוקן עגלות...');
        await stores.clearCart(chatId);
        await ctx.editMessageText('🗑 כל העגלות רוקנו בהצלחה.');
        return;
      }

      // Multi-store item card controls: m:<token>:<op>[:<storeId>]
      if (data.startsWith('m:')) {
        const parts = data.split(':');
        const token = parts[1];
        const op = parts[2];
        const targetStoreId = parts[3] as StoreId | undefined;
        if (!token || !op) {
          await ctx.answerCallbackQuery();
          return;
        }

        const payload = db.getCallbackPayload(token);
        if (!payload || payload.kind !== 'multi_item_ctrl') {
          await ctx.answerCallbackQuery({ text: 'פג תוקף הכפתור' });
          return;
        }

        if (op === 'swap' && targetStoreId) {
          const ref = payload.stores.find((s) => s.storeId === targetStoreId);
          if (!ref || ref.alternatives.length === 0) {
            await ctx.answerCallbackQuery({ text: 'אין חלופות זמינות' });
            return;
          }
          await ctx.answerCallbackQuery(
            `בחר מוצר חלופי ב-${STORE_META[targetStoreId].shortName}`,
          );
          const kb = new InlineKeyboard();
          for (const alt of ref.alternatives) {
            const pickTok = db.saveCallbackPayload({
              kind: 'pick_alt',
              parentToken: token,
              storeId: targetStoreId,
              altProductCode: alt.code,
            });
            const unit = alt.unitDescription ? ` (${alt.unitDescription})` : '';
            kb.text(
              `${alt.name.slice(0, 26)}${unit} - ${alt.formattedPrice}`,
              `a:${pickTok}`,
            ).row();
          }
          kb.text('⬅️ חזרה', `m:${token}:back`);
          await ctx.editMessageReplyMarkup({ reply_markup: kb });
          return;
        }

        if (op === 'back') {
          await ctx.answerCallbackQuery();
          await ctx.editMessageReplyMarkup({
            reply_markup: buildMultiItemControlKeyboard(token, payload.stores),
          });
          return;
        }

        if (op === 'inc' || op === 'dec' || op === 'rm') {
          await ctx.answerCallbackQuery('מעדכן את כל העגלות...');
          const isRemove = op === 'rm';

          const adjustResults = await Promise.all(
            payload.stores.map(async (s) => {
              const step = s.sellingMethod === 'BY_WEIGHT' ? 0.5 : 1;
              const delta = isRemove ? -9999 : op === 'inc' ? step : -step;
              const res = await stores.adjustQuantityAcrossStores({
                chatId,
                targets: [
                  {
                    storeId: s.storeId,
                    productCode: s.productCode,
                    sellingMethod: s.sellingMethod,
                  },
                ],
                delta,
              });
              return res[0]!;
            }),
          );

          const remaining = adjustResults.filter((r) => r.newQuantity > 0);
          if (remaining.length === 0) {
            db.removeShoppingListItem(chatId, payload.query);
            const summary = adjustResults
              .filter((r) => r.cart)
              .map(
                (r) =>
                  `${r.meta.emoji} ${r.meta.shortName}: ${formatCurrency(r.cart!.totalPrice)}`,
              )
              .join(' • ');
            await ctx.editMessageText(
              `🗑 <b>הוסר מכל העגלות:</b> ${escapeHtml(payload.query)}` +
                (summary ? `\n(${summary})` : ''),
              { parse_mode: 'HTML' },
            );
            return;
          }

          // Update stored quantities and re-render multi-store card
          for (const adj of adjustResults) {
            const ref = payload.stores.find((s) => s.storeId === adj.storeId);
            if (ref && adj.newQuantity > 0) {
              ref.quantity = adj.newQuantity;
            }
          }
          db.updateCallbackPayload(token, payload);

          const syntheticResult: MultiStoreAddItemResult = {
            request: {
              rawText: payload.query,
              searchQuery: payload.query,
              action: 'set',
              quantity: remaining[0]!.newQuantity,
              unitPreference: 'UNIT',
            },
            outcomes: adjustResults.map((adj) => {
              const prod = db.getCachedProduct(adj.productCode, adj.storeId);
              return {
                storeId: adj.storeId,
                meta: adj.meta,
                status: adj.error ? 'error' : adj.newQuantity > 0 ? 'added' : 'not_found',
                product: prod ?? undefined,
                addedQty: adj.newQuantity,
                finalQuantity: adj.newQuantity,
                cart: adj.cart,
                error: adj.error,
              };
            }),
            cheapestItemStoreId: null,
          };
          const addedValid = syntheticResult.outcomes.filter(
            (o) => o.status === 'added' && o.product && o.product.price > 0,
          );
          addedValid.sort(
            (a, b) =>
              a.product!.price * (a.addedQty ?? 1) -
              b.product!.price * (b.addedQty ?? 1),
          );
          syntheticResult.cheapestItemStoreId = addedValid[0]?.storeId ?? null;

          await ctx.editMessageText(
            buildMultiItemControlMessage({
              query: payload.query,
              senderName: payload.senderName,
              result: syntheticResult,
            }),
            {
              parse_mode: 'HTML',
              reply_markup: buildMultiItemControlKeyboard(token, payload.stores),
            },
          );
          return;
        }
      }

      // Single-store item card controls: c:<token>:<op>
      if (data.startsWith('c:')) {
        const [, token, op] = data.split(':');
        if (!token || !op) {
          await ctx.answerCallbackQuery();
          return;
        }

        const payload = db.getCallbackPayload(token);
        if (!payload || payload.kind !== 'item_ctrl') {
          await ctx.answerCallbackQuery({ text: 'פג תוקף הכפתור' });
          return;
        }

        const storeId: StoreId = payload.storeId ?? 'shufersal';
        const mgr = stores.getStore(storeId) ?? stores.getPrimaryStore();

        const currentProduct =
          db.getCachedProduct(payload.productCode, storeId) ??
          payload.alternatives.find((a) => a.code === payload.productCode);

        if (op === 'swap') {
          await ctx.answerCallbackQuery('בחר מוצר חלופי');
          const kb = new InlineKeyboard();
          for (const alt of payload.alternatives) {
            const pickTok = db.saveCallbackPayload({
              kind: 'pick_alt',
              parentToken: token,
              storeId,
              altProductCode: alt.code,
            });
            const unit = alt.unitDescription ? ` (${alt.unitDescription})` : '';
            kb.text(
              `${alt.name.slice(0, 26)}${unit} - ${alt.formattedPrice}`,
              `a:${pickTok}`,
            ).row();
          }
          kb.text('⬅️ חזרה', `c:${token}:back`);
          await ctx.editMessageReplyMarkup({ reply_markup: kb });
          return;
        }

        if (op === 'back') {
          await ctx.answerCallbackQuery();
          await ctx.editMessageReplyMarkup({
            reply_markup: buildSingleItemControlKeyboard(
              token,
              payload.alternatives.length > 0,
            ),
          });
          return;
        }

        const step = payload.sellingMethod === 'BY_WEIGHT' ? 0.5 : 1;
        if (op === 'inc' || op === 'dec' || op === 'rm') {
          const delta = op === 'inc' ? step : op === 'dec' ? -step : -9999;
          await ctx.answerCallbackQuery(`מעדכן עגלה ב-${mgr.meta.shortName}...`);

          const { cart, newQuantity } = await mgr.adjustQuantityByDelta({
            chatId,
            productCode: payload.productCode,
            sellingMethod: payload.sellingMethod,
            delta,
          });

          if (newQuantity <= 0) {
            await ctx.editMessageText(
              `🗑 <b>הוסר מהעגלה (${escapeHtml(mgr.meta.shortName)}):</b> ${escapeHtml(currentProduct?.name ?? payload.productCode)} (סה"כ עגלה כעת: ${formatCurrency(cart.totalPrice)})`,
              { parse_mode: 'HTML' },
            );
            return;
          }

          payload.quantity = newQuantity;
          db.updateCallbackPayload(token, payload);

          if (currentProduct) {
            await ctx.editMessageText(
              buildSingleItemControlMessage({
                storeMeta: mgr.meta,
                product: currentProduct,
                addedQty: newQuantity,
                totalInCartQty: newQuantity,
                senderName: payload.senderName,
                cartTotal: cart.totalPrice,
                orderInUpdateMode: cart.orderInUpdateMode,
              }),
              {
                parse_mode: 'HTML',
                reply_markup: buildSingleItemControlKeyboard(
                  token,
                  payload.alternatives.length > 0,
                ),
              },
            );
          }
          return;
        }
      }

      // Action tokens: a:<token>
      if (data.startsWith('a:')) {
        const token = data.slice(2);
        const payload = db.getCallbackPayload(token);
        if (!payload) {
          await ctx.answerCallbackQuery({ text: 'פג תוקף הפעולה' });
          return;
        }

        if (payload.kind === 'store_cart') {
          await ctx.answerCallbackQuery(
            `טוען עגלת ${STORE_META[payload.storeId].shortName}...`,
          );
          await renderSingleStoreCartView(chatId, payload.storeId, messageId);
          return;
        }

        if (payload.kind === 'pick_alt') {
          const parent = db.getCallbackPayload(payload.parentToken);
          if (!parent) {
            await ctx.answerCallbackQuery({ text: 'פג תוקף הבחירה' });
            return;
          }

          const storeId: StoreId = payload.storeId ?? 'shufersal';
          const mgr = stores.getStore(storeId) ?? stores.getPrimaryStore();

          if (parent.kind === 'multi_item_ctrl') {
            const storeRef = parent.stores.find((s) => s.storeId === storeId);
            if (!storeRef) {
              await ctx.answerCallbackQuery({ text: 'החנות לא נמצאה' });
              return;
            }
            const newProd =
              storeRef.alternatives.find((p) => p.code === payload.altProductCode) ??
              db.getCachedProduct(payload.altProductCode, storeId);
            if (!newProd) {
              await ctx.answerCallbackQuery({ text: 'המוצר לא נמצא' });
              return;
            }

            await ctx.answerCallbackQuery(
              `מחליף מוצר ב-${mgr.meta.shortName} ושומר העדפה...`,
            );
            const oldProd = db.getCachedProduct(storeRef.productCode, storeId);
            const { cart, finalNewQuantity } = await mgr.replaceProduct({
              chatId: parent.chatId,
              senderName: getSenderDisplayName(ctx),
              rawQuery: parent.query,
              oldProductCode: storeRef.productCode,
              newProduct: newProd,
              quantity: storeRef.quantity,
            });

            storeRef.alternatives = [
              ...(oldProd ? [oldProd] : []),
              ...storeRef.alternatives.filter((a) => a.code !== newProd.code),
            ].slice(0, 4);
            storeRef.productCode = newProd.code;
            storeRef.sellingMethod = newProd.sellingMethod;
            db.updateCallbackPayload(payload.parentToken, parent);

            const outcomes = parent.stores.map((s) => {
              const p =
                s.storeId === storeId
                  ? newProd
                  : db.getCachedProduct(s.productCode, s.storeId);
              return {
                storeId: s.storeId,
                meta: STORE_META[s.storeId],
                status: 'added' as const,
                product: p ?? undefined,
                addedQty: s.quantity,
                finalQuantity: s.storeId === storeId ? finalNewQuantity : s.quantity,
                cart: s.storeId === storeId ? cart : undefined,
              };
            });
            const cheapestSorted = outcomes
              .filter((o) => o.product && o.product.price > 0)
              .sort(
                (a, b) =>
                  a.product!.price * (a.addedQty ?? 1) -
                  b.product!.price * (b.addedQty ?? 1),
              );

            await ctx.editMessageText(
              buildMultiItemControlMessage({
                query: parent.query,
                senderName: parent.senderName,
                result: {
                  request: {
                    rawText: parent.query,
                    searchQuery: parent.query,
                    action: 'add',
                    quantity: storeRef.quantity,
                    unitPreference: 'UNIT',
                  },
                  outcomes,
                  cheapestItemStoreId: cheapestSorted[0]?.storeId ?? null,
                },
                learnedStoreName: mgr.meta.shortName,
              }),
              {
                parse_mode: 'HTML',
                reply_markup: buildMultiItemControlKeyboard(
                  payload.parentToken,
                  parent.stores,
                ),
              },
            );
            return;
          }

          if (parent.kind === 'item_ctrl') {
            const newProd =
              parent.alternatives.find((p) => p.code === payload.altProductCode) ??
              db.getCachedProduct(payload.altProductCode, storeId);
            if (!newProd) {
              await ctx.answerCallbackQuery({ text: 'המוצר לא נמצא' });
              return;
            }

            await ctx.answerCallbackQuery('מחליף מוצר ושומר העדפה...');
            const oldProd = db.getCachedProduct(parent.productCode, storeId);

            const { cart, finalNewQuantity } = await mgr.replaceProduct({
              chatId: parent.chatId,
              senderName: getSenderDisplayName(ctx),
              rawQuery: parent.query,
              oldProductCode: parent.productCode,
              newProduct: newProd,
              quantity: parent.quantity,
            });

            const updatedAlts = [
              ...(oldProd ? [oldProd] : []),
              ...parent.alternatives.filter((a) => a.code !== newProd.code),
            ].slice(0, 4);

            parent.productCode = newProd.code;
            parent.sellingMethod = newProd.sellingMethod;
            parent.alternatives = updatedAlts;
            db.updateCallbackPayload(payload.parentToken, parent);

            await ctx.editMessageText(
              buildSingleItemControlMessage({
                storeMeta: mgr.meta,
                product: newProd,
                addedQty: parent.quantity,
                totalInCartQty: finalNewQuantity,
                senderName: parent.senderName,
                cartTotal: cart.totalPrice,
                orderInUpdateMode: cart.orderInUpdateMode,
                learnedNote: true,
              }),
              {
                parse_mode: 'HTML',
                reply_markup: buildSingleItemControlKeyboard(
                  payload.parentToken,
                  updatedAlts.length > 0,
                ),
              },
            );
            return;
          }
        }

        if (payload.kind === 'search_add') {
          const storeId: StoreId = payload.storeId ?? payload.product.storeId ?? 'shufersal';
          const mgr = stores.getStore(storeId) ?? stores.getPrimaryStore();
          await ctx.answerCallbackQuery(`מוסיף לעגלת ${mgr.meta.shortName}...`);

          const senderName = getSenderDisplayName(ctx);
          const defaultQty =
            payload.product.sellingMethod === 'BY_WEIGHT' ? 0.5 : 1;

          const { cart, finalQuantity } = await mgr.addOrIncrementProduct({
            chatId: payload.chatId,
            senderName,
            product: payload.product,
            quantity: defaultQty,
            mode: 'increment',
          });
          db.recordPreference(
            payload.query,
            payload.product.code,
            payload.product.name,
            mgr.storeId,
          );

          const ctrlToken = db.saveCallbackPayload({
            kind: 'item_ctrl',
            storeId: mgr.storeId,
            chatId: payload.chatId,
            query: payload.query,
            productCode: payload.product.code,
            sellingMethod: payload.product.sellingMethod,
            quantity: defaultQty,
            senderName,
            alternatives: [],
          });

          await bot.api.sendMessage(
            chatId,
            buildSingleItemControlMessage({
              storeMeta: mgr.meta,
              product: payload.product,
              addedQty: defaultQty,
              totalInCartQty: finalQuantity,
              senderName,
              cartTotal: cart.totalPrice,
              orderInUpdateMode: cart.orderInUpdateMode,
            }),
            {
              parse_mode: 'HTML',
              reply_markup: buildSingleItemControlKeyboard(ctrlToken, false),
            },
          );
          return;
        }

        if (payload.kind === 'slot_day') {
          await ctx.answerCallbackQuery();
          await renderSlotsPicker(
            chatId,
            payload.storeId ?? 'shufersal',
            messageId,
            payload.dateKey,
          );
          return;
        }

        if (payload.kind === 'slot_pick') {
          const storeId: StoreId = payload.storeId ?? 'shufersal';
          const mgr = stores.getStore(storeId) ?? stores.getPrimaryStore();
          await ctx.answerCallbackQuery(
            `משריין חלון משלוח ב-${mgr.meta.shortName}...`,
          );
          const chosen = await mgr.selectSlot(payload.slotCode);
          const feeText =
            chosen.deliveryFee !== null
              ? ` • דמי משלוח: <b>${formatCurrency(chosen.deliveryFee)}</b>`
              : '';
          const checkoutTok = db.saveCallbackPayload({
            kind: 'checkout_store',
            storeId: mgr.storeId,
          });
          const kb = new InlineKeyboard().text(
            `💳 המשך לאישור הזמנה ב-${mgr.meta.shortName}`,
            `a:${checkoutTok}`,
          );

          await ctx.editMessageText(
            `✅ <b>חלון המשלוח שוריין בהצלחה ב-${escapeHtml(mgr.meta.displayName)}!</b>\n` +
              `🚚 מועד: <b>${escapeHtml(payload.label)}</b>${feeText}\n\n` +
              `ניתן להמשיך להוסיף מצרכים בקבוצה או לסגור את ההזמנה באמצעות /checkout.`,
            { parse_mode: 'HTML', reply_markup: kb },
          );
          return;
        }

        if (payload.kind === 'order_edit') {
          const storeId: StoreId = payload.storeId ?? 'shufersal';
          const mgr = stores.getStore(storeId) ?? stores.getPrimaryStore();
          await ctx.answerCallbackQuery('טוען את ההזמנה לעגלה...');
          const cart = await mgr.loadOrderForUpdate(chatId, payload.orderCode);
          const kb = buildStoreCartActionKeyboard(
            mgr.storeId,
            cart.orderInUpdateMode ?? payload.orderCode,
            cart.items.length > 0,
          );
          await ctx.editMessageText(
            `✏️ <b>הזמנה #${escapeHtml(payload.orderCode)} נטענה לעגלה במצב עדכון!</b>\n\n` +
              `• להוספת מוצרים – כתבו כרגיל בקבוצה.\n` +
              `• להסרת מוצרים – לחצו <b>🗑 הסר / ערוך פריטים בהזמנה</b> למטה, הקלידו <code>/remove</code>, או כתבו <i>"תורידו את..."</i>.\n` +
              (stores.isMultiStore()
                ? `• להשוואת כל ההזמנה מול שאר הרשתות – לחצו <b>📋 העתק והשווה את ההזמנה בשאר הרשתות</b> למטה.\n`
                : '') +
              `⚠️ <b>חשוב:</b> בסיום העריכה, יש להריץ /checkout (או ללחוץ שמור עדכון) כדי לשמור את השינויים!\n\n` +
              renderCartSummaryHtml(mgr.meta, cart),
            {
              parse_mode: 'HTML',
              reply_markup: cart.items.length > 0 ? kb : undefined,
            },
          );
          return;
        }

        if (payload.kind === 'cart_edit_page') {
          await ctx.answerCallbackQuery();
          await renderCartEditView(
            chatId,
            payload.storeId ?? stores.getPrimaryStore().storeId,
            payload.page,
            messageId,
          );
          return;
        }

        if (payload.kind === 'cart_item_op') {
          const storeId: StoreId =
            payload.storeId ?? stores.getPrimaryStore().storeId;
          const mgr = stores.getStore(storeId) ?? stores.getPrimaryStore();

          if (payload.op === 'rm') {
            await ctx.answerCallbackQuery(
              `מסיר מוצר מ-${mgr.meta.shortName}...`,
            );
            const { removedItem } = await mgr.removeProductByCode({
              chatId,
              productCode: payload.productCode,
            });
            const notice = removedItem
              ? `✅ <b>הוסר מהעגלה (${escapeHtml(mgr.meta.shortName)}):</b> ${escapeHtml(removedItem.productName ?? removedItem.productCode)}`
              : `ℹ️ המוצר כבר אינו בעגלה.`;
            await renderCartEditView(
              chatId,
              mgr.storeId,
              payload.page,
              messageId,
              notice,
            );
            return;
          }

          if (payload.op === 'dec') {
            const step = payload.sellingMethod === 'BY_WEIGHT' ? 0.5 : 1;
            await ctx.answerCallbackQuery(
              `מפחית כמות ב-${mgr.meta.shortName}...`,
            );
            const cached = db.getCachedProduct(payload.productCode, mgr.storeId);
            const { newQuantity } = await mgr.adjustQuantityByDelta({
              chatId,
              productCode: payload.productCode,
              sellingMethod: payload.sellingMethod,
              delta: -step,
            });
            const label = escapeHtml(cached?.name ?? payload.productCode);
            const notice =
              newQuantity <= 0
                ? `✅ <b>הוסר מהעגלה (${escapeHtml(mgr.meta.shortName)}):</b> ${label}`
                : `✅ <b>עודכנה כמות (${escapeHtml(mgr.meta.shortName)}):</b> ${label} → <b>${escapeHtml(formatQuantity(newQuantity, payload.sellingMethod))}</b>`;
            await renderCartEditView(
              chatId,
              mgr.storeId,
              payload.page,
              messageId,
              notice,
            );
            return;
          }
        }

        if (payload.kind === 'mirror_cart') {
          const sourceMeta = STORE_META[payload.sourceStoreId];
          await ctx.answerCallbackQuery(
            `מעתיק פריטים מ-${sourceMeta.shortName} ומשווה...`,
          );
          await runMirrorForChat({
            chatId,
            sourceStoreId: payload.sourceStoreId,
            senderName: getSenderDisplayName(ctx),
          });
          return;
        }

        if (payload.kind === 'checkout_store') {
          await ctx.answerCallbackQuery(
            `מכין סיכום הזמנה ב-${STORE_META[payload.storeId].shortName}...`,
          );
          await renderCheckoutConfirmationForStore(
            chatId,
            payload.storeId,
            messageId,
          );
          return;
        }

        if (payload.kind === 'checkout_exec') {
          const storeId: StoreId = payload.storeId ?? stores.getPrimaryStore().storeId;
          const meta = STORE_META[storeId];

          await ctx.answerCallbackQuery(`מבצע הזמנה ב-${meta.shortName}...`);
          await ctx.editMessageText(
            `⏳ <b>מבצע הזמנה מול ${escapeHtml(meta.displayName)}...</b> אנא המתן (אל תלחץ שוב).`,
            { parse_mode: 'HTML' },
          );

          const result = await stores.checkoutStore(chatId, storeId, {
            removeMissingItems: payload.removeMissingItems,
          });

          const removedNote =
            result.removedOutOfStockCodes.length > 0
              ? `\nℹ️ הוסרו אוטומטית ${result.removedOutOfStockCodes.length} פריטים שאזלו מהמלאי.`
              : '';

          const title = result.wasOrderUpdate
            ? `🎉 <b>עדכון ההזמנה ב-${escapeHtml(meta.displayName)} נשמר בהצלחה!</b>`
            : `🎉 <b>ההזמנה ב-${escapeHtml(meta.displayName)} בוצעה בהצלחה!</b>`;

          const postKb = new InlineKeyboard();
          if (stores.isMultiStore()) {
            const clearOthersTok = db.saveCallbackPayload({
              kind: 'clear_others',
              keepStoreId: storeId,
            });
            postKb.text('🗑 רוקן עגלות בשאר החנויות', `a:${clearOthersTok}`);
          }

          await ctx.editMessageText(
            `${title}\n\n` +
              `🧾 מספר הזמנה: <b>#${escapeHtml(result.orderCode)}</b>\n` +
              `🚚 מועד משלוח: <b>${escapeHtml(formatHebrewDateTime(result.deliveryIso))}</b>\n` +
              `💰 סה"כ הזמנה: <b>${formatCurrency(result.totalPrice)}</b>` +
              removedNote,
            {
              parse_mode: 'HTML',
              reply_markup: stores.isMultiStore() ? postKb : undefined,
            },
          );
          return;
        }

        if (payload.kind === 'clear_store') {
          if (!(await isUserAdmin(ctx))) {
            await ctx.answerCallbackQuery({
              text: '⛔ למנהלים בלבד',
              show_alert: true,
            });
            return;
          }
          await ctx.answerCallbackQuery('מרוקן עגלה...');
          if (payload.storeId === 'all') {
            const results = await stores.clearCart(chatId);
            const okCount = results.filter((r) => r.ok).length;
            await ctx.editMessageText(
              `🗑 רוקנו ${okCount}/${results.length} עגלות בהצלחה.`,
            );
          } else {
            await stores.clearCart(chatId, payload.storeId);
            await ctx.editMessageText(
              `🗑 עגלת ${STORE_META[payload.storeId].displayName} רוקנה בהצלחה.`,
            );
          }
          return;
        }

        if (payload.kind === 'clear_others') {
          if (!(await isUserAdmin(ctx))) {
            await ctx.answerCallbackQuery({
              text: '⛔ למנהלים בלבד',
              show_alert: true,
            });
            return;
          }
          await ctx.answerCallbackQuery('מרוקן עגלות בשאר החנויות...');
          const results = await stores.clearOtherStores(
            chatId,
            payload.keepStoreId,
          );
          const clearedNames = results
            .filter((r) => r.ok)
            .map((r) => r.meta.shortName)
            .join(', ');
          await bot.api.sendMessage(
            chatId,
            clearedNames
              ? `🗑 רוקנו העגלות בשאר החנויות: <b>${escapeHtml(clearedNames)}</b>.`
              : 'ℹ️ לא נמצאו עגלות נוספות לריקון.',
            { parse_mode: 'HTML' },
          );
          return;
        }
      }
    } catch (err) {
      if (err instanceof StoreManualVerificationRequiredError) {
        logger.info(
          `Manual checkout/verification handoff for ${err.storeId} (${err.reason}) on callback "${data}"`,
        );
      } else {
        logger.error(`Error handling callback query "${data}"`, err);
      }
      await ctx.answerCallbackQuery().catch(() => {});
      await bot.api.sendMessage(chatId, formatUserFacingError(err), {
        parse_mode: 'HTML',
      });
    }
  });

  // Free-text group grocery listener
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith('/')) return;

    const pendingOtp = pendingOtpByChat.get(ctx.chat.id);
    if (pendingOtp) {
      if (Date.now() > pendingOtp.expiresAt) {
        pendingOtpByChat.delete(ctx.chat.id);
      } else if (/^\d{4,8}$/.test(text.replace(/[\s\-]/g, ''))) {
        await handleCompleteSmsOtpLogin(ctx, text);
        return;
      }
    }

    const senderName = getSenderDisplayName(ctx);
    const parsed = await ai.parseGroupMessage(text);
    if (!parsed.isGroceryRelated || parsed.items.length === 0) {
      return;
    }

    const storeCountText = stores.isMultiStore()
      ? `ב-${stores.getEnabledStores().length} רשתות`
      : `ב-${stores.getPrimaryStore().meta.shortName}`;

    const statusMsg = await ctx.reply(
      `⏳ מזהה ${parsed.items.length > 1 ? `${parsed.items.length} מצרכים` : 'מצרך'} ומעדכן עגלות ${storeCountText}...`,
      { reply_parameters: { message_id: ctx.message.message_id } },
    );

    try {
      await processParsedItems({
        chatId: ctx.chat.id,
        replyToMessageId: ctx.message.message_id,
        statusMessageId: statusMsg.message_id,
        senderName,
        items: parsed.items,
      });
    } catch (err) {
      logger.error('Failed processing group grocery message', err);
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        formatUserFacingError(err),
        { parse_mode: 'HTML' },
      );
    }
  });

  async function processParsedItems(params: {
    chatId: number;
    replyToMessageId: number;
    statusMessageId: number;
    senderName: string;
    items: ParsedGroceryItem[];
  }): Promise<void> {
    let statusDeleted = false;
    const deleteStatusIfNeeded = async () => {
      if (!statusDeleted) {
        statusDeleted = true;
        await bot.api
          .deleteMessage(params.chatId, params.statusMessageId)
          .catch(() => {});
      }
    };

    for (let i = 0; i < params.items.length; i++) {
      const req = params.items[i]!;

      if (req.action === 'remove') {
        const results = await stores.removeAcrossStores({
          chatId: params.chatId,
          query: req.searchQuery,
        });
        const removedAny = results.filter((r) => r.removedItem);
        const msg =
          removedAny.length > 0
            ? `🗑 <b>הוסר מהעגלות:</b> ${escapeHtml(req.searchQuery)}\n` +
              removedAny
                .map(
                  (r) =>
                    `${r.meta.emoji} ${escapeHtml(r.meta.shortName)}: ${escapeHtml(r.removedItem!.productName ?? r.removedItem!.productCode)}` +
                    (r.cart ? ` (עגלה: ${formatCurrency(r.cart.totalPrice)})` : ''),
                )
                .join('\n')
            : `ℹ️ לא נמצא באף עגלה מוצר תואם ל-"<b>${escapeHtml(req.searchQuery)}</b>" להסרה.`;

        if (params.items.length === 1 && !statusDeleted) {
          statusDeleted = true;
          await bot.api.editMessageText(
            params.chatId,
            params.statusMessageId,
            msg,
            { parse_mode: 'HTML' },
          );
        } else {
          await deleteStatusIfNeeded();
          await bot.api.sendMessage(params.chatId, msg, { parse_mode: 'HTML' });
        }
        continue;
      }

      // Add across all enabled stores in parallel
      const multiResult = await stores.addItemAcrossStores({
        chatId: params.chatId,
        senderName: params.senderName,
        request: req,
        ai,
      });

      const addedOutcomes = multiResult.outcomes.filter(
        (o) => o.status === 'added' && o.product,
      );

      if (addedOutcomes.length === 0) {
        const notFoundMsg =
          `😕 לא נמצא מוצר זמין במלאי עבור "<b>${escapeHtml(req.searchQuery)}</b>" באף אחת מהרשתות.\n` +
          `נסו לחפש ידנית עם <code>/search ${escapeHtml(req.searchQuery)}</code>.`;
        if (params.items.length === 1 && !statusDeleted) {
          statusDeleted = true;
          await bot.api.editMessageText(
            params.chatId,
            params.statusMessageId,
            notFoundMsg,
            { parse_mode: 'HTML' },
          );
        } else {
          await deleteStatusIfNeeded();
          await bot.api.sendMessage(params.chatId, notFoundMsg, {
            parse_mode: 'HTML',
          });
        }
        continue;
      }

      let cardText: string;
      let keyboard: InlineKeyboard;

      if (!stores.isMultiStore() && addedOutcomes.length === 1) {
        const only = addedOutcomes[0]!;
        const ctrlToken = db.saveCallbackPayload({
          kind: 'item_ctrl',
          storeId: only.storeId,
          chatId: params.chatId,
          query: req.searchQuery,
          productCode: only.product!.code,
          sellingMethod: only.product!.sellingMethod,
          quantity: only.addedQty ?? 1,
          senderName: params.senderName,
          alternatives: only.alternatives ?? [],
        });
        cardText = buildSingleItemControlMessage({
          storeMeta: only.meta,
          product: only.product!,
          addedQty: only.addedQty ?? 1,
          totalInCartQty: only.finalQuantity ?? only.addedQty ?? 1,
          senderName: params.senderName,
          cartTotal: only.cart?.totalPrice ?? 0,
          orderInUpdateMode: only.cart?.orderInUpdateMode ?? null,
        });
        keyboard = buildSingleItemControlKeyboard(
          ctrlToken,
          (only.alternatives?.length ?? 0) > 0,
        );
      } else {
        const storeRefs: MultiItemStoreRef[] = addedOutcomes.map((o) => ({
          storeId: o.storeId,
          productCode: o.product!.code,
          sellingMethod: o.product!.sellingMethod,
          quantity: o.addedQty ?? 1,
          alternatives: o.alternatives ?? [],
        }));
        const ctrlToken = db.saveCallbackPayload({
          kind: 'multi_item_ctrl',
          chatId: params.chatId,
          query: req.searchQuery,
          senderName: params.senderName,
          stores: storeRefs,
        });
        cardText = buildMultiItemControlMessage({
          query: req.searchQuery,
          senderName: params.senderName,
          result: multiResult,
        });
        keyboard = buildMultiItemControlKeyboard(ctrlToken, storeRefs);
      }

      if (params.items.length === 1 && !statusDeleted) {
        statusDeleted = true;
        await bot.api.editMessageText(
          params.chatId,
          params.statusMessageId,
          cardText,
          { parse_mode: 'HTML', reply_markup: keyboard },
        );
      } else {
        await deleteStatusIfNeeded();
        await bot.api.sendMessage(params.chatId, cardText, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
          reply_parameters:
            i === 0 ? { message_id: params.replyToMessageId } : undefined,
        });
      }
    }
  }

  bot.catch((err) => {
    logger.error('Unhandled Grammy bot error', err.error);
  });

  return bot;
}

export async function registerBotCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([
    { command: 'compare', description: 'השוואת מחירים בין שופרסל, חצי חינם, סופר חביב וויקטורי' },
    { command: 'mirror', description: 'העתקת כל הפריטים מהעגלה/הזמנה בשופרסל לשאר הרשתות' },
    { command: 'cart', description: 'הצגת העגלות ופירוט פריטים בכל חנות' },
    { command: 'remove', description: 'הסרה או עריכת כמות של פריטים בעגלות / בהזמנה' },
    { command: 'checkout', description: 'בחירת הסל הזול ביותר ואישור הזמנה' },
    { command: 'stores', description: 'רשימת החנויות המחוברות וקישורים לעגלות' },
    { command: 'slots', description: 'בחירת יום ושעת משלוח' },
    { command: 'orders', description: 'צפייה בהזמנות פעילות וטעינה לעדכון' },
    { command: 'search', description: 'חיפוש והשוואת מחיר של מוצר בכל החנויות' },
    { command: 'login_haviv', description: 'התחברות לסופר חביב באמצעות קוד SMS' },
    { command: 'login_victory', description: 'התחברות לויקטורי אונליין באמצעות קוד SMS' },
    { command: 'otp', description: 'שליחת קוד אימות SMS להתחברות לחנות' },
    { command: 'clear', description: '(מנהל) ריקון העגלות' },
    { command: 'id', description: 'הצגת מזהה הקבוצה והמשתמש' },
    { command: 'help', description: 'מדריך שימוש בבוט הקניות' },
  ]);
}
