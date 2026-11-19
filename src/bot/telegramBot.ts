import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { GroceryAiService, ParsedGroceryItem } from '../ai/groceryAi.js';
import type { AppConfig } from '../config.js';
import { logger } from '../logger.js';
import type { ShufersalManager } from '../shufersal/manager.js';
import {
  ShufersalAuthError,
  ShufersalManualVerificationRequiredError,
  type CartState,
  type CatalogProduct,
  type DeliverySlot,
} from '../shufersal/types.js';
import type { BotDatabase } from '../store/database.js';
import {
  escapeHtml,
  formatCurrency,
  formatHebrewDateTime,
  formatHebrewDayHeader,
  formatQuantity,
} from '../utils/format.js';

export interface CreateTelegramBotDeps {
  config: AppConfig;
  db: BotDatabase;
  shufersal: ShufersalManager;
  ai: GroceryAiService;
}

function getSenderDisplayName(ctx: Context): string {
  const from = ctx.from;
  if (!from) return 'משתתף';
  const full = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return full || from.username || String(from.id);
}

function formatUserFacingError(err: unknown): string {
  if (err instanceof ShufersalManualVerificationRequiredError) {
    return (
      `⚠️ <b>נדרשת השלמה ידנית קצרה באתר שופרסל</b>\n` +
      `${escapeHtml(err.message)}\n\n` +
      `🔗 <a href="${escapeHtml(err.actionUrl)}">מעבר ישיר לעגלה/קופה בשופרסל אונליין</a>`
    );
  }
  if (err instanceof ShufersalAuthError) {
    return `🔐 <b>שגיאת התחברות לשופרסל:</b> ${escapeHtml(err.message)}`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `❌ <b>שגיאה:</b> ${escapeHtml(msg)}`;
}

function buildItemControlMessage(params: {
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
    ? `\n💡 <i>נשמר כמוצר המועדף של הקבוצה לפעמים הבאות!</i>`
    : '';

  return (
    `✅ <b>נוסף לעגלת שופרסל:</b>\n` +
    `🛒 <b>${escapeHtml(params.product.name)}</b>${unitInfo}\n` +
    `📦 כמות: <b>${escapeHtml(formatQuantity(params.addedQty, params.product.sellingMethod))}</b>${totalQtyNote} • מחיר: <b>${escapeHtml(params.product.formattedPrice)}</b>` +
    promoInfo +
    `\n👤 ביקש/ה: ${escapeHtml(params.senderName)} • סה"כ עגלה: <b>${formatCurrency(params.cartTotal)}</b>` +
    updateBanner +
    learnedBanner
  );
}

function buildItemControlKeyboard(
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

function renderCartSummaryHtml(
  cart: CartState,
  selectedSlot?: DeliverySlot | null,
): string {
  const header = cart.orderInUpdateMode
    ? `🛒 <b>עגלת שופרסל – מצב עדכון הזמנה #${escapeHtml(cart.orderInUpdateMode)}</b>\n`
    : `🛒 <b>עגלת הקניות הנוכחית בשופרסל אונליין</b>\n`;

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

  lines.push(`\n💰 <b>סה"כ מוצרים במלאי: ${formatCurrency(cart.totalPrice)}</b> (${inStockItems.length} פריטים)`);

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
  } else if (!cart.orderInUpdateMode) {
    lines.push(`🕒 <i>טרם נבחר חלון משלוח – לבחירה לחצו או הקלידו /slots</i>`);
  }

  return lines.join('\n');
}

export function createTelegramBot(deps: CreateTelegramBotDeps): Bot {
  const { config, db, shufersal, ai } = deps;
  const bot = new Bot(config.telegramBotToken);

  async function isUserAdmin(ctx: Context): Promise<boolean> {
    const userId = ctx.from?.id;
    if (!userId) return false;

    if (config.adminUserIds.length > 0) {
      return config.adminUserIds.includes(userId);
    }

    if (ctx.chat?.type === 'private') {
      return true;
    }

    try {
      const member = await ctx.getChatMember(userId);
      return member.status === 'creator' || member.status === 'administrator';
    } catch {
      return false;
    }
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
    await ctx.reply(
      `👋 <b>שלום! אני בוט הקניות החכם של הקבוצה לשופרסל אונליין.</b>\n\n` +
        `<b>איך משתמשים?</b>\n` +
        `פשוט כותבים בקבוצה בשפה חופשית מה צריך הביתה, למשל:\n` +
        `• <i>"צריך 2 חלב תנובה 3%, קוטג' ולחם פרוס"</i>\n` +
        `• <i>"תוסיפו חצי קילו עגבניות שרי ובננות קצת ירוקות"</i>\n` +
        `• <i>"תורידו את הקוטג'"</i>\n\n` +
        `אני אזהה אוטומטית את המוצרים לפי היסטוריית הרכישות שלכם, אוסיף אותם לעגלה בשופרסל, ואציג כפתורים להחלפת מוצר או שינוי כמות (ואלמד את ההעדפות שלכם!).\n\n` +
        `<b>פקודות זמינות:</b>\n` +
        `• /cart – צפייה בעגלת שופרסל הנוכחית וסה"כ לתשלום\n` +
        `• /search <code>&lt;מוצר&gt;</code> – חיפוש ידני ובחירה מתוך תוצאות\n` +
        `• /slots – בחירת יום ושעת משלוח בשופרסל\n` +
        `• /orders – צפייה בהזמנות פעילות וטעינת הזמנה קיימת לעדכון\n` +
        `• /checkout – <b>(מנהלים)</b> סיכום ואישור ביצוע/עדכון ההזמנה בשופרסל\n` +
        `• /clear – <b>(מנהלים)</b> ריקון העגלה\n` +
        `• /id – הצגת מזהי הקבוצה והמשתמש`,
      { parse_mode: 'HTML' },
    );
  });

  bot.command(['cart', 'agala'], async (ctx) => {
    const loading = await ctx.reply('🔄 טוען את מצב העגלה משופרסל אונליין...');
    try {
      const [cart, slot] = await Promise.all([
        shufersal.getEnrichedCart(ctx.chat.id),
        shufersal.getSelectedSlot().catch(() => null),
      ]);

      const kb = new InlineKeyboard()
        .text('🔄 רענן עגלה', 'nav:cart')
        .text('🚚 בחר חלון משלוח', 'nav:slots')
        .row()
        .text('💳 סיכום ואישור הזמנה (מנהל)', 'nav:checkout');

      await ctx.api.editMessageText(
        ctx.chat.id,
        loading.message_id,
        renderCartSummaryHtml(cart, slot),
        {
          parse_mode: 'HTML',
          reply_markup: cart.items.length > 0 ? kb : undefined,
        },
      );
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

  bot.command('search', async (ctx) => {
    const query = ctx.match.trim();
    if (!query) {
      await ctx.reply('🔎 שימוש: <code>/search שם מוצר</code> (למשל: <code>/search חלב שיבולת שועל</code>)', {
        parse_mode: 'HTML',
      });
      return;
    }

    const loading = await ctx.reply(`🔎 מחפש <b>${escapeHtml(query)}</b> בשופרסל...`, {
      parse_mode: 'HTML',
    });

    try {
      const products = await shufersal.search(query, 8);
      const inStock = products.filter((p) => p.inStock && p.purchasable).slice(0, 6);

      if (inStock.length === 0) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          loading.message_id,
          `😕 לא נמצאו מוצרים במלאי עבור <b>${escapeHtml(query)}</b>.`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      const kb = new InlineKeyboard();
      const lines = [`🔎 <b>תוצאות חיפוש עבור "${escapeHtml(query)}":</b>\nלחצו על מוצר להוספה מיידית לעגלה:\n`];

      inStock.forEach((prod, i) => {
        const unit = prod.unitDescription ? ` (${escapeHtml(prod.unitDescription)})` : '';
        lines.push(`${i + 1}. <b>${escapeHtml(prod.name)}</b>${unit} — ${escapeHtml(prod.formattedPrice)}`);
        const tok = db.saveCallbackPayload({
          kind: 'search_add',
          chatId: ctx.chat.id,
          query,
          product: prod,
        });
        const btnLabel = `➕ ${prod.name.slice(0, 28)} (${prod.formattedPrice})`;
        kb.text(btnLabel, `a:${tok}`).row();
      });

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
    messageIdToEdit?: number,
    selectedDayKey?: string,
  ): Promise<void> {
    const slots = await shufersal.getAvailableSlots();
    if (slots.length === 0) {
      const msg = '😕 לא נמצאו חלונות משלוח פנויים כרגע בכתובת המשלוח שלך בשופרסל.';
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
        `🚚 <b>בחירת יום משלוח בשופרסל אונליין:</b>\n` +
        `בחרו את היום המבוקש מתוך החלונות הפנויים:`;
      for (const [dateKey, group] of byDay.entries()) {
        const tok = db.saveCallbackPayload({ kind: 'slot_day', dateKey });
        kb.text(
          `📅 ${group.label} (${group.slots.length} חלונות)`,
          `a:${tok}`,
        ).row();
      }
    } else {
      const group = byDay.get(selectedDayKey)!;
      text =
        `🕒 <b>בחירת שעת משלוח עבור ${escapeHtml(group.label)}:</b>\n` +
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
    const loading = await ctx.reply('🚚 בודק חלונות משלוח פנויים בשופרסל...');
    try {
      await renderSlotsPicker(ctx.chat.id, loading.message_id);
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

  async function renderCheckoutConfirmation(
    chatId: number,
    messageIdToEdit?: number,
  ): Promise<void> {
    const snapshot = await shufersal.getPreCheckoutSnapshot(chatId);
    const { cart, selectedSlot, activeOrders } = snapshot;

    const inStockCount = cart.items.filter((i) => i.inStock).length;
    if (inStockCount === 0) {
      const msg = '🛒 העגלה ריקה ממוצרים במלאי – לא ניתן לבצע הזמנה כרגע.';
      if (messageIdToEdit) {
        await bot.api.editMessageText(chatId, messageIdToEdit, msg);
      } else {
        await bot.api.sendMessage(chatId, msg);
      }
      return;
    }

    const updatingOrder = cart.orderInUpdateMode
      ? activeOrders.find((o) => o.code === cart.orderInUpdateMode)
      : undefined;

    if (!selectedSlot && !cart.orderInUpdateMode) {
      const updatableOrder = activeOrders.find((o) => o.isUpdatable);
      const kb = new InlineKeyboard().text('🚚 בחר חלון משלוח חדש', 'nav:slots');
      if (updatableOrder) {
        const editTok = db.saveCallbackPayload({
          kind: 'order_edit',
          orderCode: updatableOrder.code,
        });
        kb.row().text(
          `✏️ או טען הזמנה פעילה #${updatableOrder.code} לעדכון`,
          `a:${editTok}`,
        );
      }

      const msg =
        `⚠️ <b>לפני השלמת ההזמנה יש לבחור חלון משלוח</b>\n\n` +
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

    const summaryHtml = renderCartSummaryHtml(cart, selectedSlot);
    const modeNote = cart.orderInUpdateMode
      ? `\n\n📌 <b>פעולה:</b> שמירת עדכון להזמנה קיימת <b>#${escapeHtml(cart.orderInUpdateMode)}</b>` +
        (updatingOrder
          ? ` (${escapeHtml(formatHebrewDateTime(updatingOrder.deliveryIso))})`
          : '')
      : `\n\n📌 <b>פעולה:</b> יצירת הזמנה חדשה וחיוב כרטיס האשראי השמור בחשבון שופרסל`;

    const confirmTok = db.saveCallbackPayload({
      kind: 'checkout_exec',
      removeMissingItems: config.autoRemoveOutOfStock,
    });

    const kb = new InlineKeyboard()
      .text(
        cart.orderInUpdateMode
          ? `✅ אשר ושמור עדכון הזמנה #${cart.orderInUpdateMode}`
          : '✅ אשר ובצע הזמנה בשופרסל',
        `a:${confirmTok}`,
      )
      .row()
      .text('🕒 החלף חלון משלוח', 'nav:slots')
      .text('❌ ביטול', 'nav:cancel');

    const fullText =
      `${summaryHtml}${modeNote}\n\n` +
      `🔐 <i>אישור סופי זמין למנהלי הקבוצה בלבד.</i>`;

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
    if (!(await isUserAdmin(ctx))) {
      await ctx.reply('⛔ רק מנהל/ת הקבוצה רשאי/ת ליזום סגירה ואישור הזמנה.');
      return;
    }

    const loading = await ctx.reply('💳 מכין סיכום הזמנה ובודק חלון משלוח בשופרסל...');
    try {
      await renderCheckoutConfirmation(ctx.chat.id, loading.message_id);
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
      await ctx.reply('⛔ רק מנהל/ת הקבוצה רשאי/ת לרוקן את כל העגלה.');
      return;
    }

    const kb = new InlineKeyboard()
      .text('🗑 כן, רוקן את כל העגלה', 'admin:clear_confirm')
      .text('ביטול', 'nav:cancel');

    await ctx.reply('⚠️ האם לרוקן לחלוטין את כל המוצרים מעגלת שופרסל?', {
      reply_markup: kb,
    });
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
      // Navigation shortcuts
      if (data === 'nav:cancel') {
        await ctx.answerCallbackQuery('בוטל');
        await ctx.editMessageText('הפעולה בוטלה.');
        return;
      }

      if (data === 'nav:cart') {
        await ctx.answerCallbackQuery('מרענן עגלה...');
        const [cart, slot] = await Promise.all([
          shufersal.getEnrichedCart(chatId),
          shufersal.getSelectedSlot().catch(() => null),
        ]);
        const kb = new InlineKeyboard()
          .text('🔄 רענן עגלה', 'nav:cart')
          .text('🚚 בחר חלון משלוח', 'nav:slots')
          .row()
          .text('💳 סיכום ואישור הזמנה (מנהל)', 'nav:checkout');
        await ctx.editMessageText(renderCartSummaryHtml(cart, slot), {
          parse_mode: 'HTML',
          reply_markup: cart.items.length > 0 ? kb : undefined,
        });
        return;
      }

      if (data === 'nav:slots') {
        await ctx.answerCallbackQuery('טוען חלונות משלוח...');
        await renderSlotsPicker(chatId, messageId);
        return;
      }

      if (data === 'nav:checkout') {
        if (!(await isUserAdmin(ctx))) {
          await ctx.answerCallbackQuery({
            text: '⛔ פעולה זו מיועדת למנהלי הקבוצה בלבד',
            show_alert: true,
          });
          return;
        }
        await ctx.answerCallbackQuery('מכין סיכום לאישור...');
        await renderCheckoutConfirmation(chatId, messageId);
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
        await ctx.answerCallbackQuery('מרוקן עגלה...');
        await shufersal.clearCart(chatId);
        await ctx.editMessageText('🗑 עגלת שופרסל רוקנה בהצלחה.');
        return;
      }

      // Item card controls: c:<token>:<op>
      if (data.startsWith('c:')) {
        const [, token, op] = data.split(':');
        if (!token || !op) {
          await ctx.answerCallbackQuery();
          return;
        }

        const payload = db.getCallbackPayload(token);
        if (!payload || payload.kind !== 'item_ctrl') {
          await ctx.answerCallbackQuery({
            text: 'פג תוקף הכפתור',
            show_alert: false,
          });
          return;
        }

        const currentProduct =
          db.getCachedProduct(payload.productCode) ??
          payload.alternatives.find((a) => a.code === payload.productCode);

        if (op === 'swap') {
          await ctx.answerCallbackQuery('בחר מוצר חלופי');
          const kb = new InlineKeyboard();
          for (const alt of payload.alternatives) {
            const pickTok = db.saveCallbackPayload({
              kind: 'pick_alt',
              parentToken: token,
              altProductCode: alt.code,
            });
            const unit = alt.unitDescription ? ` (${alt.unitDescription})` : '';
            const label = `${alt.name.slice(0, 26)}${unit} - ${alt.formattedPrice}`;
            kb.text(label, `a:${pickTok}`).row();
          }
          kb.text('⬅️ חזרה', `c:${token}:back`);

          await ctx.editMessageReplyMarkup({ reply_markup: kb });
          return;
        }

        if (op === 'back') {
          await ctx.answerCallbackQuery();
          await ctx.editMessageReplyMarkup({
            reply_markup: buildItemControlKeyboard(
              token,
              payload.alternatives.length > 0,
            ),
          });
          return;
        }

        const step = payload.sellingMethod === 'BY_WEIGHT' ? 0.5 : 1;

        if (op === 'inc' || op === 'dec' || op === 'rm') {
          const delta =
            op === 'inc' ? step : op === 'dec' ? -step : -9999;
          await ctx.answerCallbackQuery('מעדכן עגלה בשופרסל...');

          const { cart, newQuantity } = await shufersal.adjustQuantityByDelta({
            chatId,
            productCode: payload.productCode,
            sellingMethod: payload.sellingMethod,
            delta,
          });

          if (newQuantity <= 0) {
            await ctx.editMessageText(
              `🗑 <b>הוסר מהעגלה:</b> ${escapeHtml(currentProduct?.name ?? payload.productCode)} (סה"כ עגלה כעת: ${formatCurrency(cart.totalPrice)})`,
              { parse_mode: 'HTML' },
            );
            return;
          }

          payload.quantity = newQuantity;
          db.updateCallbackPayload(token, payload);

          if (currentProduct) {
            await ctx.editMessageText(
              buildItemControlMessage({
                product: currentProduct,
                addedQty: newQuantity,
                totalInCartQty: newQuantity,
                senderName: payload.senderName,
                cartTotal: cart.totalPrice,
                orderInUpdateMode: cart.orderInUpdateMode,
              }),
              {
                parse_mode: 'HTML',
                reply_markup: buildItemControlKeyboard(
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

        if (payload.kind === 'pick_alt') {
          const parent = db.getCallbackPayload(payload.parentToken);
          if (!parent || parent.kind !== 'item_ctrl') {
            await ctx.answerCallbackQuery({ text: 'פג תוקף הבחירה' });
            return;
          }

          const newProd =
            parent.alternatives.find((p) => p.code === payload.altProductCode) ??
            db.getCachedProduct(payload.altProductCode);
          if (!newProd) {
            await ctx.answerCallbackQuery({ text: 'המוצר לא נמצא' });
            return;
          }

          await ctx.answerCallbackQuery('מחליף מוצר ושומר העדפה...');
          const oldProd = db.getCachedProduct(parent.productCode);

          const { cart, finalNewQuantity } = await shufersal.replaceProduct({
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
            buildItemControlMessage({
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
              reply_markup: buildItemControlKeyboard(
                payload.parentToken,
                updatedAlts.length > 0,
              ),
            },
          );
          return;
        }

        if (payload.kind === 'search_add') {
          await ctx.answerCallbackQuery('מוסיף לעגלת שופרסל...');
          const senderName = getSenderDisplayName(ctx);
          const defaultQty = payload.product.sellingMethod === 'BY_WEIGHT' ? 0.5 : 1;

          const { cart, finalQuantity } = await shufersal.addOrIncrementProduct({
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
          );

          const ctrlToken = db.saveCallbackPayload({
            kind: 'item_ctrl',
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
            buildItemControlMessage({
              product: payload.product,
              addedQty: defaultQty,
              totalInCartQty: finalQuantity,
              senderName,
              cartTotal: cart.totalPrice,
              orderInUpdateMode: cart.orderInUpdateMode,
            }),
            {
              parse_mode: 'HTML',
              reply_markup: buildItemControlKeyboard(ctrlToken, false),
            },
          );
          return;
        }

        if (payload.kind === 'slot_day') {
          await ctx.answerCallbackQuery();
          await renderSlotsPicker(chatId, messageId, payload.dateKey);
          return;
        }

        if (payload.kind === 'slot_pick') {
          await ctx.answerCallbackQuery('משריין חלון משלוח בשופרסל...');
          const chosen = await shufersal.selectSlot(payload.slotCode);
          const feeText =
            chosen.deliveryFee !== null
              ? ` • דמי משלוח: <b>${formatCurrency(chosen.deliveryFee)}</b>`
              : '';
          const kb = new InlineKeyboard().text(
            '💳 המשך לסיכום ואישור הזמנה (מנהל)',
            'nav:checkout',
          );

          await ctx.editMessageText(
            `✅ <b>חלון המשלוח שוריין בהצלחה!</b>\n` +
              `🚚 מועד: <b>${escapeHtml(payload.label)}</b>${feeText}\n\n` +
              `ניתן להמשיך להוסיף מצרכים בקבוצה או לסגור את ההזמנה באמצעות /checkout.`,
            { parse_mode: 'HTML', reply_markup: kb },
          );
          return;
        }

        if (payload.kind === 'order_edit') {
          if (!(await isUserAdmin(ctx))) {
            await ctx.answerCallbackQuery({
              text: '⛔ טעינת הזמנה לעדכון מיועדת למנהלי הקבוצה בלבד',
              show_alert: true,
            });
            return;
          }
          await ctx.answerCallbackQuery('טוען את ההזמנה לעגלה...');
          const cart = await shufersal.loadOrderForUpdate(
            chatId,
            payload.orderCode,
          );
          await ctx.editMessageText(
            `✏️ <b>הזמנה #${escapeHtml(payload.orderCode)} נטענה לעגלה במצב עדכון!</b>\n\n` +
              `כל מצרך שיישלח עכשיו בקבוצה יתווסף להזמנה זו.\n` +
              `⚠️ <b>חשוב:</b> בסיום הוספת המצרכים, על המנהל/ת להריץ /checkout ולאשר את שמירת העדכון בשופרסל!\n\n` +
              renderCartSummaryHtml(cart),
            { parse_mode: 'HTML' },
          );
          return;
        }

        if (payload.kind === 'checkout_exec') {
          if (!(await isUserAdmin(ctx))) {
            await ctx.answerCallbackQuery({
              text: '⛔ אישור וחיוב הזמנה מותר למנהלי הקבוצה בלבד!',
              show_alert: true,
            });
            return;
          }

          await ctx.answerCallbackQuery('מבצע הזמנה בשופרסל אונליין...');
          await ctx.editMessageText(
            '⏳ <b>מבצע הזמנה מול שופרסל אונליין...</b> אנא המתן כ-10–20 שניות (אל תלחץ שוב).',
            { parse_mode: 'HTML' },
          );

          const result = await shufersal.checkout(chatId, {
            removeMissingItems: payload.removeMissingItems,
          });

          const removedNote =
            result.removedOutOfStockCodes.length > 0
              ? `\nℹ️ הוסרו אוטומטית ${result.removedOutOfStockCodes.length} פריטים שאזלו מהמלאי.`
              : '';

          const title = result.wasOrderUpdate
            ? `🎉 <b>עדכון ההזמנה בשופרסל נשמר בהצלחה!</b>`
            : `🎉 <b>ההזמנה בשופרסל אונליין בוצעה בהצלחה!</b>`;

          await ctx.editMessageText(
            `${title}\n\n` +
              `🧾 מספר הזמנה: <b>#${escapeHtml(result.orderCode)}</b>\n` +
              `🚚 מועד משלוח: <b>${escapeHtml(formatHebrewDateTime(result.deliveryIso))}</b>\n` +
              `💰 סה"כ הזמנה: <b>${formatCurrency(result.totalPrice)}</b>` +
              removedNote,
            { parse_mode: 'HTML' },
          );
          return;
        }
      }
    } catch (err) {
      logger.error(`Error handling callback query "${data}"`, err);
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

    const senderName = getSenderDisplayName(ctx);
    const parsed = await ai.parseGroupMessage(text);
    if (!parsed.isGroceryRelated || parsed.items.length === 0) {
      return;
    }

    const statusMsg = await ctx.reply(
      `⏳ מזהה ${parsed.items.length > 1 ? `${parsed.items.length} מצרכים` : 'מצרך'} ומעדכן את העגלה בשופרסל...`,
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
        const { removedItem, cart } = await shufersal.removeMatchingProduct({
          chatId: params.chatId,
          query: req.searchQuery,
        });
        const msg = removedItem
          ? `🗑 <b>הוסר מהעגלה:</b> ${escapeHtml(removedItem.productName ?? removedItem.productCode)} (סה"כ עגלה: ${formatCurrency(cart.totalPrice)})`
          : `ℹ️ לא נמצא בעגלה מוצר תואם ל-"<b>${escapeHtml(req.searchQuery)}</b>" להסרה.`;

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

      // Search Shufersal & check learned preference
      const learned = db.getPreference(req.searchQuery);
      const candidates = await shufersal.search(req.searchQuery, 15);
      const selection = await ai.selectBestProduct({
        request: req,
        candidates,
        learnedProductCode: learned?.productCode ?? null,
      });

      if (!selection.selected) {
        const notFoundMsg = `😕 לא נמצא מוצר זמין במלאי בשופרסל עבור "<b>${escapeHtml(req.searchQuery)}</b>". נסו לחפש ידנית עם <code>/search ${escapeHtml(req.searchQuery)}</code>.`;
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

      const mode = req.action === 'set' ? 'set' : 'increment';
      const { cart, finalQuantity } = await shufersal.addOrIncrementProduct({
        chatId: params.chatId,
        senderName: params.senderName,
        product: selection.selected,
        quantity: selection.adjustedQuantity,
        mode,
        comment: req.pickerComment,
      });

      const ctrlToken = db.saveCallbackPayload({
        kind: 'item_ctrl',
        chatId: params.chatId,
        query: req.searchQuery,
        productCode: selection.selected.code,
        sellingMethod: selection.selected.sellingMethod,
        quantity: selection.adjustedQuantity,
        senderName: params.senderName,
        alternatives: selection.alternatives,
      });

      const cardText = buildItemControlMessage({
        product: selection.selected,
        addedQty: selection.adjustedQuantity,
        totalInCartQty: finalQuantity,
        senderName: params.senderName,
        cartTotal: cart.totalPrice,
        orderInUpdateMode: cart.orderInUpdateMode,
      });
      const keyboard = buildItemControlKeyboard(
        ctrlToken,
        selection.alternatives.length > 0,
      );

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
    { command: 'cart', description: 'הצגת עגלת שופרסל הנוכחית וסה"כ לתשלום' },
    { command: 'slots', description: 'בחירת יום ושעת משלוח בשופרסל' },
    { command: 'checkout', description: '(מנהל) אישור וסגירת הזמנה בשופרסל' },
    { command: 'orders', description: 'צפייה בהזמנות פעילות וטעינת הזמנה לעדכון' },
    { command: 'search', description: 'חיפוש ידני בקטלוג שופרסל' },
    { command: 'clear', description: '(מנהל) ריקון כל העגלה' },
    { command: 'id', description: 'הצגת מזהה הקבוצה והמשתמש' },
    { command: 'help', description: 'מדריך שימוש בבוט הקניות' },
  ]);
}
