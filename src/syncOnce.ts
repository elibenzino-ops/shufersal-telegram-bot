import { Bot } from 'grammy';
import { GroceryAiService } from './ai/groceryAi.js';
import { renderComparisonHtml } from './bot/telegramBot.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { BotDatabase } from './store/database.js';
import { createMultiStoreManager } from './stores/factory.js';
import { escapeHtml, formatQuantity } from './utils/format.js';

/**
 * One-shot batch synchronization mode (ideal for GitHub Actions / cron jobs).
 * Pulls all unread Telegram group messages queued by Telegram's servers,
 * parses groceries via Gemini AI, updates carts across all enabled stores
 * (Shufersal and Hazi Hinam), posts a cheapest-cart comparison summary
 * back to the group, acknowledges the processed updates, and exits cleanly.
 */
async function runBatchSync(): Promise<void> {
  logger.info('Starting one-shot multi-store Telegram -> Grocery batch sync...');
  const config = loadConfig();
  const bot = new Bot(config.telegramBotToken);
  const db = new BotDatabase(config.dbPath);
  const stores = createMultiStoreManager(config, db);
  const ai = new GroceryAiService(config.geminiApiKey, config.geminiModel);

  try {
    const updates = await bot.api.getUpdates({
      timeout: 0,
      allowed_updates: ['message'],
    });

    if (updates.length === 0) {
      logger.info('No unread Telegram messages in queue. Exiting cleanly.');
      return;
    }

    let highestUpdateId = 0;
    const changesByChat = new Map<number, string[]>();

    for (const u of updates) {
      if (u.update_id > highestUpdateId) {
        highestUpdateId = u.update_id;
      }

      const msg = u.message;
      const chatId = msg?.chat?.id;
      const text = msg?.text?.trim();
      if (!msg || !chatId || !text || text.startsWith('/')) continue;

      if (
        config.allowedChatIds.length > 0 &&
        !config.allowedChatIds.includes(chatId)
      ) {
        continue;
      }

      const senderName =
        [msg.from?.first_name, msg.from?.last_name]
          .filter(Boolean)
          .join(' ')
          .trim() || 'משתתף';

      const parsed = await ai.parseGroupMessage(text);
      if (!parsed.isGroceryRelated || parsed.items.length === 0) {
        continue;
      }

      const chatLog = changesByChat.get(chatId) ?? [];

      for (const req of parsed.items) {
        if (req.action === 'remove') {
          const removed = await stores.removeAcrossStores({
            chatId,
            query: req.searchQuery,
          });
          const names = removed
            .filter((r) => r.removedItem)
            .map((r) => `${r.meta.emoji} ${r.meta.shortName}`);
          if (names.length > 0) {
            chatLog.push(
              `🗑 הוסר <b>${escapeHtml(req.searchQuery)}</b> (${names.join(', ')})`,
            );
          }
          continue;
        }

        const res = await stores.addItemAcrossStores({
          chatId,
          senderName,
          request: req,
          ai,
        });

        const addedParts = res.outcomes
          .filter((o) => o.status === 'added' && o.product)
          .map((o) => {
            const win = res.cheapestItemStoreId === o.storeId ? ' 🏆' : '';
            const qty = formatQuantity(
              o.addedQty ?? 1,
              o.product!.sellingMethod,
            );
            return `${o.meta.emoji} ${escapeHtml(o.meta.shortName)}: ${escapeHtml(o.product!.formattedPrice)} (${escapeHtml(qty)})${win}`;
          });

        if (addedParts.length > 0) {
          chatLog.push(
            `✅ <b>${escapeHtml(req.searchQuery)}</b> (${escapeHtml(senderName)}): ${addedParts.join(' | ')}`,
          );
        } else {
          chatLog.push(
            `😕 לא נמצא במלאי: <b>${escapeHtml(req.searchQuery)}</b>`,
          );
        }
      }

      if (chatLog.length > 0) {
        changesByChat.set(chatId, chatLog);
      }
    }

    // Post per-chat batch summary + live cheapest-cart comparison
    for (const [chatId, lines] of changesByChat.entries()) {
      const comparison = await stores.compareCarts(chatId);
      const comparisonHtml = renderComparisonHtml(
        comparison,
        '⚖️ השוואת עגלות מעודכנת בין הרשתות',
      );

      await bot.api.sendMessage(
        chatId,
        `🔄 <b>סנכרון מצרכים הושלם בהצלחה!</b>\n\n` +
          `${lines.join('\n')}\n\n` +
          `${comparisonHtml}`,
        { parse_mode: 'HTML' },
      );
    }

    // Acknowledge processed updates so Telegram won't re-deliver them next run
    if (highestUpdateId > 0) {
      await bot.api.getUpdates({
        offset: highestUpdateId + 1,
        timeout: 0,
        limit: 1,
      });
      logger.info(`Acknowledged Telegram updates up to ID ${highestUpdateId}`);
    }
  } finally {
    await stores.shutdown().catch(() => {});
    db.close();
  }
}

runBatchSync().catch((err) => {
  logger.error('One-shot batch sync failed', err);
  process.exit(1);
});
