import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { CatalogProduct, ShufersalSellingMethodCode } from '../shufersal/types.js';
import { normalizeHebrewQuery } from '../utils/format.js';

export type CallbackPayload =
  | {
      kind: 'item_ctrl';
      chatId: number;
      query: string;
      productCode: string;
      sellingMethod: ShufersalSellingMethodCode;
      quantity: number;
      senderName: string;
      alternatives: CatalogProduct[];
    }
  | {
      kind: 'pick_alt';
      parentToken: string;
      altProductCode: string;
    }
  | {
      kind: 'search_add';
      chatId: number;
      query: string;
      product: CatalogProduct;
    }
  | {
      kind: 'slot_day';
      dateKey: string;
    }
  | {
      kind: 'slot_pick';
      slotCode: string;
      label: string;
    }
  | {
      kind: 'order_edit';
      orderCode: string;
    }
  | {
      kind: 'checkout_exec';
      removeMissingItems: boolean;
    };

export interface LearnedPreference {
  normalizedQuery: string;
  productCode: string;
  productName: string;
  chosenCount: number;
}

export class BotDatabase {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS product_cache (
        code TEXT PRIMARY KEY,
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
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS learned_preferences (
        normalized_query TEXT PRIMARY KEY,
        product_code TEXT NOT NULL,
        product_name TEXT NOT NULL,
        chosen_count INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cart_contributors (
        chat_id INTEGER NOT NULL,
        product_code TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, product_code, sender_name)
      );

      CREATE TABLE IF NOT EXISTS callback_tokens (
        token TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  cacheProducts(products: CatalogProduct[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO product_cache (
        code, name, brand_name, unit_description, selling_method,
        price, formatted_price, price_per_unit_text, promotion_msg,
        in_stock, purchasable, category_name, image_url, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
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
      stmt.run(
        p.code,
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

  getCachedProduct(code: string): CatalogProduct | null {
    const stmt = this.db.prepare(`SELECT * FROM product_cache WHERE code = ?`);
    const row = stmt.get(code) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      code: String(row['code']),
      name: String(row['name']),
      brandName: row['brand_name'] ? String(row['brand_name']) : null,
      unitDescription: row['unit_description'] ? String(row['unit_description']) : null,
      sellingMethod: String(row['selling_method']) as ShufersalSellingMethodCode,
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

  recordPreference(rawQuery: string, productCode: string, productName: string): void {
    const normalized = normalizeHebrewQuery(rawQuery);
    if (!normalized) return;

    const stmt = this.db.prepare(`
      INSERT INTO learned_preferences (normalized_query, product_code, product_name, chosen_count, updated_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(normalized_query) DO UPDATE SET
        chosen_count = CASE
          WHEN learned_preferences.product_code = excluded.product_code
          THEN learned_preferences.chosen_count + 1
          ELSE 1
        END,
        product_code = excluded.product_code,
        product_name = excluded.product_name,
        updated_at = excluded.updated_at
    `);
    stmt.run(normalized, productCode, productName, Date.now());
  }

  getPreference(rawQuery: string): LearnedPreference | null {
    const normalized = normalizeHebrewQuery(rawQuery);
    if (!normalized) return null;

    const stmt = this.db.prepare(
      `SELECT * FROM learned_preferences WHERE normalized_query = ?`,
    );
    const row = stmt.get(normalized) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      normalizedQuery: String(row['normalized_query']),
      productCode: String(row['product_code']),
      productName: String(row['product_name']),
      chosenCount: Number(row['chosen_count']),
    };
  }

  addContributor(chatId: number, productCode: string, senderName: string): void {
    if (!senderName.trim()) return;
    const stmt = this.db.prepare(`
      INSERT INTO cart_contributors (chat_id, product_code, sender_name, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id, product_code, sender_name) DO UPDATE SET
        updated_at = excluded.updated_at
    `);
    stmt.run(chatId, productCode, senderName.trim(), Date.now());
  }

  removeProductContributors(chatId: number, productCode: string): void {
    const stmt = this.db.prepare(
      `DELETE FROM cart_contributors WHERE chat_id = ? AND product_code = ?`,
    );
    stmt.run(chatId, productCode);
  }

  clearChatContributors(chatId: number): void {
    const stmt = this.db.prepare(`DELETE FROM cart_contributors WHERE chat_id = ?`);
    stmt.run(chatId);
  }

  getContributorsByChat(chatId: number): Map<string, string[]> {
    const stmt = this.db.prepare(
      `SELECT product_code, sender_name FROM cart_contributors WHERE chat_id = ? ORDER BY updated_at ASC`,
    );
    const rows = stmt.all(chatId) as Array<{
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

  close(): void {
    this.db.close();
  }
}
