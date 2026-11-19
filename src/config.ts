import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

function parseIdList(raw: string | undefined): number[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => !Number.isNaN(n));
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

  SHUFERSAL_USERNAME: z.string().min(1, 'חובה להגדיר SHUFERSAL_USERNAME (אימייל או ת.ז. לשופרסל)'),
  SHUFERSAL_PASSWORD: z.string().min(1, 'חובה להגדיר SHUFERSAL_PASSWORD'),

  GEMINI_API_KEY: z.string().min(1, 'חובה להגדיר GEMINI_API_KEY לזיהוי חכם של מצרכים'),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),

  CHROME_PATH: z.string().optional(),
  BROWSER_WS_ENDPOINT: z.string().optional(),
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
  shufersalUsername: string;
  shufersalPassword: string;
  geminiApiKey: string;
  geminiModel: string;
  chromePath?: string;
  browserWsEndpoint?: string;
  headless: boolean;
  dataDir: string;
  dbPath: string;
  sessionFilePath: string;
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
  const chromePath = detectChromeExecutable();
  if (!chromePath && !data.BROWSER_WS_ENDPOINT) {
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
    adminUserIds: parseIdList(data.ADMIN_USER_IDS),
    shufersalUsername: data.SHUFERSAL_USERNAME,
    shufersalPassword: data.SHUFERSAL_PASSWORD,
    geminiApiKey: data.GEMINI_API_KEY,
    geminiModel: data.GEMINI_MODEL,
    chromePath,
    browserWsEndpoint: data.BROWSER_WS_ENDPOINT,
    headless: data.HEADLESS,
    dataDir,
    dbPath: path.join(dataDir, 'bot.sqlite'),
    sessionFilePath: path.join(dataDir, 'shufersal-session.json'),
    screenshotsDir,
    autoRemoveOutOfStock: data.AUTO_REMOVE_OUT_OF_STOCK,
  };
}
