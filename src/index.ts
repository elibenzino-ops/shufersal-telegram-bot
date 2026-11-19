import { GroceryAiService } from './ai/groceryAi.js';
import { createTelegramBot, registerBotCommands } from './bot/telegramBot.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { ShufersalClient } from './shufersal/client.js';
import { ShufersalManager } from './shufersal/manager.js';
import { BotDatabase } from './store/database.js';

async function main(): Promise<void> {
  logger.info('Starting Shufersal Online Telegram Group Bot...');
  const config = loadConfig();

  const db = new BotDatabase(config.dbPath);
  const shufersalClient = new ShufersalClient({
    username: config.shufersalUsername,
    password: config.shufersalPassword,
    chromePath: config.chromePath,
    browserWsEndpoint: config.browserWsEndpoint,
    proxyUrl: config.proxyUrl,
    headless: config.headless,
    sessionFilePath: config.sessionFilePath,
    screenshotsDir: config.screenshotsDir,
  });

  const shufersal = new ShufersalManager(shufersalClient, db);
  const ai = new GroceryAiService(config.geminiApiKey, config.geminiModel);

  const bot = createTelegramBot({
    config,
    db,
    shufersal,
    ai,
  });

  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}; shutting down gracefully...`);
    try {
      await bot.stop();
    } catch (err) {
      logger.warn('Error stopping Telegram bot', err);
    }
    try {
      await shufersal.shutdown();
    } catch (err) {
      logger.warn('Error closing Shufersal browser', err);
    }
    try {
      db.close();
    } catch (err) {
      logger.warn('Error closing SQLite database', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));

  await registerBotCommands(bot);

  if (config.allowedChatIds.length === 0) {
    logger.warn(
      'ALLOWED_CHAT_IDS is empty! Anyone who adds the bot can interact with it. Send /id in your Telegram group and set ALLOWED_CHAT_IDS in .env.',
    );
  }

  await bot.start({
    onStart: (botInfo) => {
      logger.info(
        `Telegram bot @${botInfo.username} is live and listening 24/7!`,
      );
    },
  });
}

main().catch((err) => {
  logger.error('Fatal startup error', err);
  process.exit(1);
});
