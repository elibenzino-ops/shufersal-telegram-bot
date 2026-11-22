import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import {
  ALL_STORE_IDS,
  isStoreId,
  type StoreId,
} from './stores/types.js';

dotenv.config();

export function parseIdList(raw: string | undefined): number[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n !== 0);
}

export function parseAdminUserIds(raw: string | undefined): number[] {
  // Telegram user IDs are strictly positive integers (> 0); negative IDs are group/channel chat IDs
  return parseIdList(raw).filter((n) => n > 0);
}

export function parseEnabledStores(
  raw: string | undefined,
  hasShufersalCreds: boolean,
): StoreId[] {
  if (!raw || !raw.trim()) {
    // Enable all 3 stores by default; only include Shufersal when its credentials are configured
    return ALL_STORE_IDS.filter(
      (id) => id !== 'shufersal' || hasShufersalCreds,
    );
  }

  const aliasMap: Record<string, StoreId> = {
    shufersal: 'shufersal',
    'שופרסל': 'shufersal',
    hazi_hinam: 'hazi_hinam',
    'hazi-hinam': 'hazi_hinam',
    hazi: 'hazi_hinam',
    hatzi: 'hazi_hinam',
    'חצי חינם': 'hazi_hinam',
    super_haviv: 'super_haviv',
    'super-haviv': 'super_haviv',
    superhaviv: 'super_haviv',
    haviv: 'super_haviv',
    'סופר חביב': 'super_haviv',
    'חביב': 'super_haviv',
    victory: 'victory',
    victoryonline: 'victory',
    victory_online: 'victory',
    'victory-online': 'victory',
    'ויקטורי': 'victory',
    'ויקטורי אונליין': 'victory',
  };

  const result: StoreId[] = [];
  for (const part of raw.split(',')) {
    const key = part.trim().toLowerCase();
    if (!key) continue;
    const mapped = aliasMap[key] ?? (isStoreId(key) ? key : undefined);
    if (mapped && !result.includes(mapped)) {
      result.push(mapped);
    }
  }
  return result;
}

function parseOptionalNumber(raw: string | undefined): number | undefined {
  if (!raw || !raw.trim()) return undefined;
  const num = Number(raw.trim());
  return Number.isFinite(num) && num >= 0 ? num : undefined;
}

function detectChromeExecutable(): string | undefined {
  const candidates = [
    process.env['CHROME_PATH'],
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return process.env['CHROME_PATH'];
}

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'חובה להגדיר TELEGRAM_BOT_TOKEN בקובץ .env'),
  ALLOWED_CHAT_IDS: z.string().optional(),
  ADMIN_USER_IDS: z.string().optional(),

  ENABLED_STORES: z.string().optional(),

  // Shufersal Online
  SHUFERSAL_USERNAME: z.string().optional(),
  SHUFERSAL_PASSWORD: z.string().optional(),
  SHUFERSAL_DELIVERY_FEE: z.string().optional(),

  // Hazi Hinam Online (חצי חינם)
  HAZI_HINAM_USERNAME: z.string().optional(),
  HAZI_HINAM_PASSWORD: z.string().optional(),
  HAZI_HINAM_DELIVERY_FEE: z.string().optional(),

  // Super Haviv Online (סופר חביב)
  SUPER_HAVIV_USERNAME: z.string().optional(),
  SUPER_HAVIV_PASSWORD: z.string().optional(),
  SUPER_HAVIV_BRANCH_ID: z.string().optional(),
  SUPER_HAVIV_AREA_ID: z.string().optional(),
  SUPER_HAVIV_DELIVERY_FEE: z.string().optional(),

  // Victory Online (ויקטורי אונליין)
  VICTORY_USERNAME: z.string().optional(),
  VICTORY_PASSWORD: z.string().optional(),
  VICTORY_BRANCH_ID: z.string().optional(),
  VICTORY_AREA_ID: z.string().optional(),
  VICTORY_DELIVERY_FEE: z.string().optional(),

  GEMINI_API_KEY: z.string().min(1, 'חובה להגדיר GEMINI_API_KEY לזיהוי חכם של מצרכים'),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),

  CHROME_PATH: z.string().optional(),
  BROWSER_WS_ENDPOINT: z.string().optional(),
  PROXY_URL: z.string().optional(),
  HEADLESS: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),

  DATA_DIR: z.string().default('./data'),
  AUTO_REMOVE_OUT_OF_STOCK: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
});

export interface AppConfig {
  telegramBotToken: string;
  allowedChatIds: number[];
  adminUserIds: number[];
  enabledStores: StoreId[];

  shufersalUsername: string;
  shufersalPassword: string;
  shufersalDeliveryFee?: number;

  haziHinamUsername?: string;
  haziHinamPassword?: string;
  haziHinamDeliveryFee?: number;

  superHavivUsername?: string;
  superHavivPassword?: string;
  superHavivBranchId?: number;
  superHavivAreaId?: number;
  superHavivDeliveryFee?: number;

  victoryUsername?: string;
  victoryPassword?: string;
  victoryBranchId?: number;
  victoryAreaId?: number;
  victoryDeliveryFee?: number;

  geminiApiKey: string;
  geminiModel: string;
  chromePath?: string;
  browserWsEndpoint?: string;
  proxyUrl?: string;
  headless: boolean;
  dataDir: string;
  dbPath: string;
  sessionFilePath: string;
  haziHinamSessionFilePath: string;
  superHavivSessionFilePath: string;
  victorySessionFilePath: string;
  screenshotsDir: string;
  autoRemoveOutOfStock: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`שגיאה בהגדרות הסביבה (.env):\n${issues}`);
  }

  const data = parsed.data;
  const shufersalUsername = data.SHUFERSAL_USERNAME?.trim() ?? '';
  const shufersalPassword = data.SHUFERSAL_PASSWORD ?? '';
  const hasShufersalCreds = Boolean(shufersalUsername && shufersalPassword);

  const enabledStores = parseEnabledStores(
    data.ENABLED_STORES,
    hasShufersalCreds,
  );
  if (enabledStores.length === 0) {
    throw new Error(
      'לא הופעלה אף חנות! הגדירו ENABLED_STORES (למשל shufersal,hazi_hinam,super_haviv,victory) ו/או פרטי התחברות.',
    );
  }

  if (enabledStores.includes('shufersal') && !hasShufersalCreds) {
    throw new Error(
      'חובה להגדיר SHUFERSAL_USERNAME ו-SHUFERSAL_PASSWORD כאשר שופרסל מופעלת ב-ENABLED_STORES.',
    );
  }

  const haziHinamUsername = data.HAZI_HINAM_USERNAME?.trim() || undefined;
  const haziHinamPassword = data.HAZI_HINAM_PASSWORD || undefined;
  const superHavivUsername = data.SUPER_HAVIV_USERNAME?.trim() || undefined;
  const superHavivPassword = data.SUPER_HAVIV_PASSWORD || undefined;
  const victoryUsername = data.VICTORY_USERNAME?.trim() || undefined;
  const victoryPassword = data.VICTORY_PASSWORD || undefined;

  const chromePath = detectChromeExecutable();
  const needsBrowser =
    enabledStores.includes('shufersal') ||
    (enabledStores.includes('super_haviv') &&
      Boolean(superHavivUsername && superHavivPassword)) ||
    (enabledStores.includes('victory') &&
      Boolean(victoryUsername && victoryPassword));

  if (needsBrowser && !chromePath && !data.BROWSER_WS_ENDPOINT) {
    throw new Error(
      'לא נמצא דפדפן Chrome/Chromium במערכת. הגדר CHROME_PATH או BROWSER_WS_ENDPOINT בקובץ .env (ב-Docker זה מוגדר אוטומטית).',
    );
  }

  const dataDir = path.resolve(data.DATA_DIR);
  const screenshotsDir = path.join(dataDir, 'screenshots');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(screenshotsDir, { recursive: true });

  return {
    telegramBotToken: data.TELEGRAM_BOT_TOKEN,
    allowedChatIds: parseIdList(data.ALLOWED_CHAT_IDS),
    adminUserIds: parseAdminUserIds(data.ADMIN_USER_IDS),
    enabledStores,

    shufersalUsername,
    shufersalPassword,
    shufersalDeliveryFee: parseOptionalNumber(data.SHUFERSAL_DELIVERY_FEE),

    haziHinamUsername,
    haziHinamPassword,
    haziHinamDeliveryFee: parseOptionalNumber(data.HAZI_HINAM_DELIVERY_FEE),

    superHavivUsername,
    superHavivPassword,
    superHavivBranchId: parseOptionalNumber(data.SUPER_HAVIV_BRANCH_ID),
    superHavivAreaId: parseOptionalNumber(data.SUPER_HAVIV_AREA_ID),
    superHavivDeliveryFee: parseOptionalNumber(data.SUPER_HAVIV_DELIVERY_FEE),

    victoryUsername,
    victoryPassword,
    victoryBranchId: parseOptionalNumber(data.VICTORY_BRANCH_ID),
    victoryAreaId: parseOptionalNumber(data.VICTORY_AREA_ID),
    victoryDeliveryFee: parseOptionalNumber(data.VICTORY_DELIVERY_FEE),

    geminiApiKey: data.GEMINI_API_KEY,
    geminiModel: data.GEMINI_MODEL,
    chromePath,
    browserWsEndpoint: data.BROWSER_WS_ENDPOINT,
    proxyUrl: data.PROXY_URL?.trim() || undefined,
    headless: data.HEADLESS,
    dataDir,
    dbPath: path.join(dataDir, 'bot.sqlite'),
    sessionFilePath: path.join(dataDir, 'shufersal-session.json'),
    haziHinamSessionFilePath: path.join(dataDir, 'hazi-hinam-session.json'),
    superHavivSessionFilePath: path.join(dataDir, 'super-haviv-session.json'),
    victorySessionFilePath: path.join(dataDir, 'victory-session.json'),
    screenshotsDir,
    autoRemoveOutOfStock: data.AUTO_REMOVE_OUT_OF_STOCK,
  };
}
