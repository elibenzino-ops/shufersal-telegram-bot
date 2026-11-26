import type { AppConfig } from '../config.js';
import { logger } from '../logger.js';
import { ShufersalClient } from '../shufersal/client.js';
import type { BotDatabase } from '../store/database.js';
import { HaziHinamClient } from './haziHinamClient.js';
import { MultiStoreManager } from './multiStoreManager.js';
import { StoreManager } from './storeManager.js';

export function createMultiStoreManager(
  config: AppConfig,
  db: BotDatabase,
): MultiStoreManager {
  const managers: StoreManager[] = [];

  for (const storeId of config.enabledStores) {
    if (storeId === 'shufersal') {
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
      if (config.shufersalDeliveryFee !== undefined) {
        client.meta.defaultDeliveryFee = config.shufersalDeliveryFee;
      }
      managers.push(new StoreManager(client, db));
      logger.info('Enabled store: Shufersal Online (authenticated)');
    } else if (storeId === 'hazi_hinam') {
      const client = new HaziHinamClient({
        username: config.haziHinamUsername,
        password: config.haziHinamPassword,
        chromePath: config.chromePath,
        browserWsEndpoint: config.browserWsEndpoint,
        proxyUrl: config.proxyUrl,
        headless: config.headless,
        sessionFilePath: config.haziHinamSessionFilePath,
        screenshotsDir: config.screenshotsDir,
        defaultDeliveryFee: config.haziHinamDeliveryFee,
      });
      if (config.haziHinamDeliveryFee !== undefined) {
        client.meta.defaultDeliveryFee = config.haziHinamDeliveryFee;
      }
      managers.push(new StoreManager(client, db));
      logger.info(
        `Enabled store: Hazi Hinam Online (${config.haziHinamUsername ? 'authenticated' : 'guest/anonymous cart mode'})`,
      );
    }
  }

  return new MultiStoreManager(managers, db);
}
