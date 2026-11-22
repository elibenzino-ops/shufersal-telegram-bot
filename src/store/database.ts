import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  CatalogProduct,
  SellingMethodCode,
  StoreId,
} from '../stores/types.js';
import { normalizeHebrewQuery } from '../utils/format.js';

export interface MultiItemStoreRef {
  storeId: StoreId;
  productCode: string;
  sellingMethod: SellingMethodCode;
  quantity: number;
  alternatives: CatalogProduct[];
}

export type CallbackPayload =
  | {
      kind: 'item_ctrl';
      storeId?: StoreId;
      chatId: number;
      query: string;
      productCode: string;
      sellingMethod: SellingMethodCode;
      quantity: number;
      senderName: string;
      alternatives: CatalogProduct[];
    }
  | {
      kind: 'multi_item_ctrl';
      chatId: number;
      query: string;
      senderName: string;
      stores: MultiItemStoreRef[];
    }
  | {
      kind: 'pick_alt';
      parentToken: string;
      storeId?: StoreId;
      altProductCode: string;
    }
  | {
      kind: 'search_add';
      storeId?: StoreId;
      chatId: number;
      query: string;
      product: CatalogProduct;
    }
  | {
      kind: 'store_cart';
      storeId: StoreId;
    }
  | {
      kind: 'slot_day';
      storeId?: StoreId;
      dateKey: string;
    }
  | {
      kind: 'slot_pick';
      storeId?: StoreId;
      slotCode: string;
      label: string;
    }
  | {
      kind: 'order_edit';
      storeId?: StoreId;
      orderCode: string;
    }
  | {
      kind: 'cart_edit_page';
      storeId?: StoreId;
      page: number;
    }
  | {
      kind: 'cart_item_op';
      storeId?: StoreId;
      productCode: string;
      sellingMethod: SellingMethodCode;
      op: 'rm' | 'dec';
      page: number;
    }
  | {
      kind: 'mirror_cart';
      sourceStoreId: StoreId;
    }
  | {
      kind: 'checkout_store';
      storeId: StoreId;
    }
  | {
      kind: 'checkout_exec';
      storeId?: StoreId;
      removeMissingItems: boolean;
    }
  | {
      kind: 'clear_store';
      storeId: StoreId | 'all';
    }
  | {
      kind: 'clear_others';
      keepStoreId: StoreId;
    }
  | {
      kind: 'otp_skip';
    };

export interface LearnedPreference {
  storeId: StoreId;
  normalizedQuery: string;
  productCode: string;
  productName: string;
  chosenCount: number;
}

export interface ShoppingListEntry {
  chatId: number;
  normalizedQuery: string;
  displayQuery: string;
  quantity: number;
  unitPreference: 'UNIT' | 'WEIGHT';
  senderName: string;
}

export class BotDatabase {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  }

  private tableExists(table: string): boolean {
    const row = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get(table) as { name?: string } | undefined;
    return Boolean(row?.name);
  }

  private migrateLegacyTables(): void {
    // Migrate legacy single-store product_cache -> composite (store_id, code)
    if (
      this.tableExists('product_cache') &&
      !this.hasColumn('product_cache', 'store_id')
    ) {
      this.db.exec(`
        ALTER TABLE product_cache RENAME TO product_cache_legacy;
        CREATE TABLE product_cache (
          store_id TEXT NOT NULL DEFAULT 'shufersal',
          code TEXT NOT NULL,
          barcode TEXT,
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
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (store_id, code)
        );
        INSERT INTO product_cache (
          store_id, code, barcode, name, brand_name, unit_description,
          selling_method, price, formatted_price, price_per_unit_text,
          promotion_msg, in_stock, purchasable, category_name, image_url, updated_at
        )
        SELECT
          'shufersal', code, NULL, name, brand_name, unit_description,
          selling_method, price, formatted_price, price_per_unit_text,
          promotion_msg, in_stock, purchasable, category_name, image_url, updated_at
        FROM product_cache_legacy;
        DROP TABLE product_cache_legacy;
      `);
    }

    // Migrate legacy learned_preferences -> composite (store_id, normalized_query)
    if (
      this.tableExists('learned_preferences') &&
      !this.hasColumn('learned_preferences', 'store_id')
    ) {
      this.db.exec(`
        ALTER TABLE learned_preferences RENAME TO learned_preferences_legacy;
        CREATE TABLE learned_preferences (
          store_id TEXT NOT NULL DEFAULT 'shufersal',
          normalized_query TEXT NOT NULL,
          product_code TEXT NOT NULL,
          product_name TEXT NOT NULL,
          chosen_count INTEGER NOT NULL DEFAULT 1,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (store_id, normalized_query)
        );
        INSERT INTO learned_preferences (
          store_id, normalized_query, product_code, product_name, chosen_count, updated_at
        )
        SELECT
          'shufersal', normalized_query, product_code, product_name, chosen_count, updated_at
        FROM learned_preferences_legacy;
        DROP TABLE learned_preferences_legacy;
      `);
    }

    // Migrate legacy cart_contributors -> composite (chat_id, store_id, product_code, sender_name)
    if (
      this.tableExists('cart_contributors') &&
      !this.hasColumn('cart_contributors', 'store_id')
    ) {
      this.db.exec(`
        ALTER TABLE cart_contributors RENAME TO cart_contributors_legacy;
        CREATE TABLE cart_contributors (
          chat_id INTEGER NOT NULL,
          store_id TEXT NOT NULL DEFAULT 'shufersal',
          product_code TEXT NOT NULL,
          sender_name TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (chat_id, store_id, product_code, sender_name)
        );
        INSERT INTO cart_contributors (
          chat_id, store_id, product_code, sender_name, updated_at
        )
        SELECT
          chat_id, 'shufersal', product_code, sender_name, updated_at
        FROM cart_contributors_legacy;
        DROP TABLE cart_contributors_legacy;
      `);
    }
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
    `);

    this.migrateLegacyTables();

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS product_cache (
        store_id TEXT NOT NULL DEFAULT 'shufersal',
        code TEXT NOT NULL,
        barcode TEXT,
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
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (store_id, code)
      );

      CREATE TABLE IF NOT EXISTS learned_preferences (
        store_id TEXT NOT NULL DEFAULT 'shufersal',
        normalized_query TEXT NOT NULL,
        product_code TEXT NOT NULL,
        product_name TEXT NOT NULL,
        chosen_count INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (store_id, normalized_query)
      );

      CREATE TABLE IF NOT EXISTS cart_contributors (
        chat_id INTEGER NOT NULL,
        store_id TEXT NOT NULL DEFAULT 'shufersal',
        product_code TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, store_id, product_code, sender_name)
      );

      CREATE TABLE IF NOT EXISTS shopping_list_items (
        chat_id INTEGER NOT NULL,
        normalized_query TEXT NOT NULL,
        display_query TEXT NOT NULL,
        quantity REAL NOT NULL DEFAULT 1,
        unit_preference TEXT NOT NULL DEFAULT 'UNIT',
        sender_name TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, normalized_query)
      );

      CREATE TABLE IF NOT EXISTS callback_tokens (
        token TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bot_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  cacheProducts(
    products: CatalogProduct[],
    storeId: StoreId = 'shufersal',
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO product_cache (
        store_id, code, barcode, name, brand_name, unit_description, selling_method,
        price, formatted_price, price_per_unit_text, promotion_msg,
        in_stock, purchasable, category_name, image_url, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(store_id, code) DO UPDATE SET
        barcode = COALESCE(excluded.barcode, product_cache.barcode),
        name = excluded.name,
        brand_name = excluded.brand_name,
        unit_description = excluded.unit_description,
        selling_method = excluded.selling_method,
        price = excluded.price,
        formatted_price = excluded.formatted_price,
        price_per_unit_text = excluded.price_per_unit_text,
        promotion_msg = excluded.promotion_msg,
        in_stock = excluded.in_stock,
        purchasable = excluded.purchasable,
        category_name = excluded.category_name,
        image_url = excluded.image_url,
        updated_at = excluded.updated_at
    `);

    const now = Date.now();
    for (const p of products) {
      const effectiveStoreId = p.storeId ?? storeId;
      stmt.run(
        effectiveStoreId,
        p.code,
        p.barcode ?? null,
        p.name,
        p.brandName,
        p.unitDescription,
        p.sellingMethod,
        p.price,
        p.formattedPrice,
        p.pricePerUnitText,
        p.promotionMsg,
        p.inStock ? 1 : 0,
        p.purchasable ? 1 : 0,
        p.categoryName,
        p.imageUrl,
        now,
      );
    }
  }

  getCachedProduct(
    code: string,
    storeId: StoreId = 'shufersal',
  ): CatalogProduct | null {
    const stmt = this.db.prepare(
      `SELECT * FROM product_cache WHERE store_id = ? AND code = ?`,
    );
    const row = stmt.get(storeId, code) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      code: String(row['code']),
      storeId: String(row['store_id']) as StoreId,
      barcode: row['barcode'] ? String(row['barcode']) : null,
      name: String(row['name']),
      brandName: row['brand_name'] ? String(row['brand_name']) : null,
      unitDescription: row['unit_description']
        ? String(row['unit_description'])
        : null,
      sellingMethod: String(row['selling_method']) as SellingMethodCode,
      price: Number(row['price']),
      formattedPrice: String(row['formatted_price']),
      pricePerUnitText: row['price_per_unit_text']
        ? String(row['price_per_unit_text'])
        : null,
      promotionMsg: row['promotion_msg'] ? String(row['promotion_msg']) : null,
      inStock: Number(row['in_stock']) === 1,
      purchasable: Number(row['purchasable']) === 1,
      categoryName: row['category_name'] ? String(row['category_name']) : null,
      imageUrl: row['image_url'] ? String(row['image_url']) : null,
    };
  }

  recordPreference(
    rawQuery: string,
    productCode: string,
    productName: string,
    storeId: StoreId = 'shufersal',
  ): void {
    const normalized = normalizeHebrewQuery(rawQuery);
    if (!normalized) return;

    const stmt = this.db.prepare(`
      INSERT INTO learned_preferences (
        store_id, normalized_query, product_code, product_name, chosen_count, updated_at
      )
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(store_id, normalized_query) DO UPDATE SET
        chosen_count = CASE
          WHEN learned_preferences.product_code = excluded.product_code
          THEN learned_preferences.chosen_count + 1
          ELSE 1
        END,
        product_code = excluded.product_code,
        product_name = excluded.product_name,
        updated_at = excluded.updated_at
    `);
    stmt.run(storeId, normalized, productCode, productName, Date.now());
  }

  getPreference(
    rawQuery: string,
    storeId: StoreId = 'shufersal',
  ): LearnedPreference | null {
    const normalized = normalizeHebrewQuery(rawQuery);
    if (!normalized) return null;

    const stmt = this.db.prepare(
      `SELECT * FROM learned_preferences WHERE store_id = ? AND normalized_query = ?`,
    );
    const row = stmt.get(storeId, normalized) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;

    return {
      storeId: String(row['store_id']) as StoreId,
      normalizedQuery: String(row['normalized_query']),
      productCode: String(row['product_code']),
      productName: String(row['product_name']),
      chosenCount: Number(row['chosen_count']),
    };
  }

  addContributor(
    chatId: number,
    productCode: string,
    senderName: string,
    storeId: StoreId = 'shufersal',
  ): void {
    if (!senderName.trim()) return;
    const stmt = this.db.prepare(`
      INSERT INTO cart_contributors (chat_id, store_id, product_code, sender_name, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, store_id, product_code, sender_name) DO UPDATE SET
        updated_at = excluded.updated_at
    `);
    stmt.run(chatId, storeId, productCode, senderName.trim(), Date.now());
  }

  removeProductContributors(
    chatId: number,
    productCode: string,
    storeId: StoreId = 'shufersal',
  ): void {
    const stmt = this.db.prepare(
      `DELETE FROM cart_contributors WHERE chat_id = ? AND store_id = ? AND product_code = ?`,
    );
    stmt.run(chatId, storeId, productCode);
  }

  clearChatContributors(chatId: number, storeId?: StoreId): void {
    if (storeId) {
      const stmt = this.db.prepare(
        `DELETE FROM cart_contributors WHERE chat_id = ? AND store_id = ?`,
      );
      stmt.run(chatId, storeId);
    } else {
      const stmt = this.db.prepare(
        `DELETE FROM cart_contributors WHERE chat_id = ?`,
      );
      stmt.run(chatId);
    }
  }

  getContributorsByChat(
    chatId: number,
    storeId: StoreId = 'shufersal',
  ): Map<string, string[]> {
    const stmt = this.db.prepare(
      `SELECT product_code, sender_name FROM cart_contributors WHERE chat_id = ? AND store_id = ? ORDER BY updated_at ASC, rowid ASC`,
    );
    const rows = stmt.all(chatId, storeId) as Array<{
      product_code: string;
      sender_name: string;
    }>;

    const map = new Map<string, string[]>();
    for (const r of rows) {
      const existing = map.get(r.product_code) ?? [];
      if (!existing.includes(r.sender_name)) {
        existing.push(r.sender_name);
      }
      map.set(r.product_code, existing);
    }
    return map;
  }

  upsertShoppingListItem(params: {
    chatId: number;
    query: string;
    quantity: number;
    mode: 'increment' | 'set';
    unitPreference: 'UNIT' | 'WEIGHT';
    senderName: string;
  }): void {
    const normalized = normalizeHebrewQuery(params.query);
    if (!normalized) return;

    const existing = this.db
      .prepare(
        `SELECT quantity FROM shopping_list_items WHERE chat_id = ? AND normalized_query = ?`,
      )
      .get(params.chatId, normalized) as { quantity: number } | undefined;

    const nextQty =
      params.mode === 'increment'
        ? Number(((existing?.quantity ?? 0) + params.quantity).toFixed(2))
        : Number(params.quantity.toFixed(2));

    if (nextQty <= 0) {
      this.removeShoppingListItem(params.chatId, params.query);
      return;
    }

    this.db
      .prepare(
        `
      INSERT INTO shopping_list_items (
        chat_id, normalized_query, display_query, quantity, unit_preference, sender_name, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, normalized_query) DO UPDATE SET
        display_query = excluded.display_query,
        quantity = excluded.quantity,
        unit_preference = excluded.unit_preference,
        sender_name = excluded.sender_name,
        updated_at = excluded.updated_at
    `,
      )
      .run(
        params.chatId,
        normalized,
        params.query.trim(),
        nextQty,
        params.unitPreference,
        params.senderName.trim(),
        Date.now(),
      );
  }

  removeShoppingListItem(chatId: number, query: string): void {
    const normalized = normalizeHebrewQuery(query);
    if (!normalized) return;
    this.db
      .prepare(
        `DELETE FROM shopping_list_items WHERE chat_id = ? AND (normalized_query = ? OR normalized_query LIKE ?)`,
      )
      .run(chatId, normalized, `%${normalized}%`);
  }

  getShoppingList(chatId: number): ShoppingListEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM shopping_list_items WHERE chat_id = ? ORDER BY updated_at ASC`,
      )
      .all(chatId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      chatId: Number(r['chat_id']),
      normalizedQuery: String(r['normalized_query']),
      displayQuery: String(r['display_query']),
      quantity: Number(r['quantity']),
      unitPreference:
        String(r['unit_preference']) === 'WEIGHT' ? 'WEIGHT' : 'UNIT',
      senderName: String(r['sender_name'] ?? ''),
    }));
  }

  clearShoppingList(chatId: number): void {
    this.db
      .prepare(`DELETE FROM shopping_list_items WHERE chat_id = ?`)
      .run(chatId);
  }

  saveCallbackPayload(payload: CallbackPayload): string {
    this.pruneOldTokens();
    const token = crypto.randomBytes(5).toString('base64url');
    const stmt = this.db.prepare(
      `INSERT INTO callback_tokens (token, payload_json, created_at) VALUES (?, ?, ?)`,
    );
    stmt.run(token, JSON.stringify(payload), Date.now());
    return token;
  }

  updateCallbackPayload(token: string, payload: CallbackPayload): void {
    const stmt = this.db.prepare(
      `UPDATE callback_tokens SET payload_json = ?, created_at = ? WHERE token = ?`,
    );
    stmt.run(JSON.stringify(payload), Date.now(), token);
  }

  getCallbackPayload(token: string): CallbackPayload | null {
    const stmt = this.db.prepare(
      `SELECT payload_json FROM callback_tokens WHERE token = ?`,
    );
    const row = stmt.get(token) as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload_json) as CallbackPayload;
    } catch {
      return null;
    }
  }

  private pruneOldTokens(): void {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const stmt = this.db.prepare(
      `DELETE FROM callback_tokens WHERE created_at < ?`,
    );
    stmt.run(sevenDaysAgo);
  }

  getSetting(key: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM bot_settings WHERE key = ?`)
      .get(key) as { value?: string } | undefined;
    return typeof row?.value === 'string' ? row.value : null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO bot_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  close(): void {
    this.db.close();
  }
}
