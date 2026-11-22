import type { BotDatabase } from '../store/database.js';
import { StoreManager } from '../stores/storeManager.js';
import { STORE_META, type StoreClient } from '../stores/types.js';
import type { ShufersalClient } from './client.js';

export class ShufersalManager extends StoreManager {
  constructor(client: ShufersalClient, db: BotDatabase) {
    // Ensure mock clients in unit tests also expose storeId & meta
    const normalizedClient =
      client.storeId && client.meta
        ? client
        : (Object.assign(client, {
            storeId: 'shufersal' as const,
            meta: STORE_META.shufersal,
          }) as StoreClient);
    super(normalizedClient, db);
  }
}
