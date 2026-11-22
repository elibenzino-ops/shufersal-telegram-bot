import type { AppConfig } from '../config.js';
import { logger } from '../logger.js';
import { ShufersalClient } from '../shufersal/client.js';
import type { BotDatabase } from '../store/database.js';
import { HaziHinamClient } from './haziHinamClient.js';
import { MultiStoreManager } from './multiStoreManager.js';
import { StoreManager } from './storeManager.js';
import { SuperHavivClient } from './superHavivClient.js';
import { VictoryClient } from './victoryClient.js';

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
        sessionFilePath: config.haziHinamSessionFilePath,
        defaultDeliveryFee: config.haziHinamDeliveryFee,
      });
      managers.push(new StoreManager(client, db));
      logger.info(
        `Enabled store: Hazi Hinam Online (${config.haziHinamUsername ? 'authenticated OAuth' : 'guest/anonymous cart mode'})`,
      );
    } else if (storeId === 'super_haviv') {
      const client = new SuperHavivClient({
        username: config.superHavivUsername,
        password: config.superHavivPassword,
        branchId: config.superHavivBranchId,
        areaId: config.superHavivAreaId,
        chromePath: config.chromePath,
        browserWsEndpoint: config.browserWsEndpoint,
        proxyUrl: config.proxyUrl,
        headless: config.headless,
        sessionFilePath: config.superHavivSessionFilePath,
        screenshotsDir: config.screenshotsDir,
        defaultDeliveryFee: config.superHavivDeliveryFee,
      });
      managers.push(new StoreManager(client, db));
      logger.info(
        `Enabled store: Super Haviv Online (${config.superHavivUsername ? 'authenticated' : 'guest/anonymous cart mode'}, branch=${config.superHavivBranchId ?? 3507})`,
      );
    } else if (storeId === 'victory') {
      const client = new VictoryClient({
        username: config.victoryUsername,
        password: config.victoryPassword,
        branchId: config.victoryBranchId,
        areaId: config.victoryAreaId,
        chromePath: config.chromePath,
        browserWsEndpoint: config.browserWsEndpoint,
        proxyUrl: config.proxyUrl,
        headless: config.headless,
        sessionFilePath: config.victorySessionFilePath,
        screenshotsDir: config.screenshotsDir,
        defaultDeliveryFee: config.victoryDeliveryFee,
      });
      managers.push(new StoreManager(client, db));
      logger.info(
        `Enabled store: Victory Online (${config.victoryUsername ? 'authenticated' : 'guest/anonymous cart mode'}, branch=${config.victoryBranchId ?? 2427})`,
      );
    }
  }

  return new MultiStoreManager(managers, db);
}
