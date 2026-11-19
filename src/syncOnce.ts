import { Bot } from 'grammy';
import { GroceryAiService } from './ai/groceryAi.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { ShufersalClient } from './shufersal/client.js';
import { ShufersalManager } from './shufersal/manager.js';
import { BotDatabase } from './store/database.js';
import { escapeHtml, formatCurrency, formatQuantity } from './utils/format.js';

/**
 * One-shot batch synchronization mode (ideal for GitHub Actions / cron jobs).
 * Pulls all unread Telegram group messages queued by Telegram's servers,
 * parses groceries via Gemini AI, updates the Shufersal cart, posts a summary
 * back to the group, acknowledges the processed updates, and exits cleanly.
 */
async function runBatchSync(): Promise<void> {
  logger.info('Starting one-shot Telegram -> Shufersal batch sync...');
  const config = loadConfig();
  const bot = new Bot(config.telegramBotToken);
  const db = new BotDatabase(config.dbPath);

  const client = new ShufersalClient({
    username: config.shufersalUsername,
    password: config.shufersalPassword,
    chromePath: config.chromePath,
    browserWsEndpoint: config.browserWsEndpoint,
    proxyUrl: config.proxyUrl,
    headless: config.headless,
    sessionFilePath: config.sessionFilePath,
    screenshotsDir: config.screenshotsDir,
  });

  const shufersal = new ShufersalManager(client, db);
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
          const { removedItem } = await shufersal.removeMatchingProduct({
            chatId,
            query: req.searchQuery,
          });
          if (removedItem) {
            chatLog.push(
              `🗑 הוסר: <b>${escapeHtml(removedItem.productName ?? removedItem.productCode)}</b>`,
            );
          }
          continue;
        }

        const learned = db.getPreference(req.searchQuery);
        const candidates = await shufersal.search(req.searchQuery, 15);
        const selection = await ai.selectBestProduct({
          request: req,
          candidates,
          learnedProductCode: learned?.productCode ?? null,
        });

        if (!selection.selected) {
          chatLog.push(
            `⚠️ לא נמצא במלאי: <b>${escapeHtml(req.searchQuery)}</b>`,
          );
          continue;
        }

        const { finalQuantity } = await shufersal.addOrIncrementProduct({
          chatId,
          senderName,
          product: selection.selected,
          quantity: selection.adjustedQuantity,
          mode: req.action === 'set' ? 'set' : 'increment',
          comment: req.pickerComment,
        });

        chatLog.push(
          `✅ <b>${escapeHtml(selection.selected.name)}</b> — ${escapeHtml(formatQuantity(finalQuantity, selection.selected.sellingMethod))} (${escapeHtml(selection.selected.formattedPrice)}) <i>[${escapeHtml(senderName)}]</i>`,
        );
      }

      changesByChat.set(chatId, chatLog);
    }

    for (const [chatId, logs] of changesByChat.entries()) {
      if (logs.length === 0) continue;
      const cart = await shufersal.getEnrichedCart(chatId);
      const summary =
        `🛒 <b>סיכום סנכרון אוטומטי לעגלת שופרסל:</b>\n\n` +
        logs.join('\n') +
        `\n\n💰 <b>סה"כ בעגלה כעת: ${formatCurrency(cart.totalPrice)}</b> (${cart.items.filter((i) => i.inStock).length} פריטים במלאי)\n` +
        `🔗 <a href="https://www.shufersal.co.il/online/he/cart">מעבר לעגלה בשופרסל אונליין</a>`;

      await bot.api.sendMessage(chatId, summary, { parse_mode: 'HTML' });
    }

    // Acknowledge all processed updates so Telegram clears them from its queue
    if (highestUpdateId > 0) {
      await bot.api.getUpdates({
        offset: highestUpdateId + 1,
        limit: 1,
        timeout: 0,
      });
    }

    logger.info(`Batch sync complete. Processed up to update_id=${highestUpdateId}.`);
  } finally {
    await shufersal.shutdown();
    db.close();
  }
}

runBatchSync().catch((err) => {
  logger.error('Batch sync failed', err);
  process.exit(1);
});
