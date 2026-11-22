import fs from 'node:fs';
import path from 'node:path';
import puppeteer, {
  type Browser,
  type BrowserContext,
  type HTTPResponse,
  type Page,
} from 'puppeteer-core';
import { logger } from '../logger.js';
import { formatCurrency, normalizeIsraeliPhone } from '../utils/format.js';
import {
  STORE_META,
  StoreManualVerificationRequiredError,
  type ActiveOrderSummary,
  type AddCartItemInput,
  type CartItem,
  type CartState,
  type CatalogProduct,
  type CheckoutResult,
  type DeliverySlot,
  type SellingMethodCode,
  type StoreClient,
  type StoreMeta,
} from './types.js';

export const VICTORY_BASE_URL = 'https://www.victoryonline.co.il';
export const VICTORY_DEFAULT_BRANCH_ID = 2427;

const NAVIGATION_TIMEOUT = 30_000;
const HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export interface VictoryClientOptions {
  baseUrl?: string;
  retailerId?: number;
  branchId?: number;
  areaId?: number;
  username?: string;
  password?: string;
  chromePath?: string;
  browserWsEndpoint?: string;
  proxyUrl?: string;
  headless: boolean;
  sessionFilePath: string;
  screenshotsDir: string;
  defaultDeliveryFee?: number;
  fetchFn?: typeof fetch;
}

export interface VictoryDomCardInput {
  href: string;
  text: string;
  imgSrc?: string | null;
  alt?: string | null;
  title?: string | null;
}

interface TrackedCartEntry {
  productCode: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  sellingMethod: SellingMethodCode;
  inStock: boolean;
}

const IGNORED_API_HOST_PATTERNS = [
  'google-analytics',
  'googletagmanager',
  'doubleclick',
  'facebook',
  'tiktok',
  'cookieyes',
  'nagish',
  'clarity.ms',
  'hotjar',
  'sentry',
];

/**
 * Extracts a GS1 / EAN barcode from Victory Online's CloudFront or Next.js image URLs,
 * e.g. `/_next/image?url=https%3A%2F%2Fdlv1nnscfbvda.cloudfront.net%2Fgs1%2F7290019014751%2F...`
 */
export function extractVictoryBarcodeFromUrl(
  rawUrl: string | null | undefined,
): string | null {
  if (!rawUrl) return null;
  let decoded = rawUrl;
  try {
    decoded = decodeURIComponent(rawUrl);
  } catch {
    // keep raw
  }

  const gs1Match = /\/gs1\/(\d{7,14})(?:\/|$)/i.exec(decoded);
  if (gs1Match?.[1]) {
    return gs1Match[1];
  }

  const filenameMatch = /\/(\d{7,14})(?:[-_.]|$)/.exec(decoded);
  if (filenameMatch?.[1]) {
    return filenameMatch[1];
  }

  return null;
}

function readNumericPrice(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d.]/g, '');
    const n = Number(cleaned);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    return (
      readNumericPrice(rec['value']) ||
      readNumericPrice(rec['amount']) ||
      readNumericPrice(rec['price']) ||
      0
    );
  }
  return 0;
}

function parseVictoryJsonObject(
  raw: Record<string, unknown>,
): CatalogProduct | null {
  const namesMap = (raw['names'] ?? {}) as Record<string, unknown>;
  const nameRaw =
    raw['name'] ??
    raw['localName'] ??
    raw['title'] ??
    raw['productName'] ??
    raw['hebrewName'] ??
    namesMap['1'];
  const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
  if (!name || name.length < 2) return null;

  const branch = (raw['branch'] ?? raw['pricing'] ?? {}) as Record<
    string,
    unknown
  >;
  const salePrice =
    readNumericPrice(raw['salePrice']) ||
    readNumericPrice(raw['discountPrice']) ||
    readNumericPrice(raw['clubPrice']) ||
    readNumericPrice(raw['finalPrice']) ||
    readNumericPrice(branch['salePrice']) ||
    readNumericPrice(branch['discountPrice']);
  const regularPrice =
    readNumericPrice(raw['regularPrice']) ||
    readNumericPrice(raw['price']) ||
    readNumericPrice(raw['unitPrice']) ||
    readNumericPrice(raw['catalogPrice']) ||
    readNumericPrice(raw['originalPrice']) ||
    readNumericPrice(branch['regularPrice']) ||
    readNumericPrice(branch['price']);

  const hasSale =
    salePrice > 0 && (regularPrice <= 0 || salePrice < regularPrice);
  const effectivePrice = hasSale ? salePrice : regularPrice;
  if (effectivePrice <= 0) return null;

  const imageRaw =
    raw['image'] ??
    raw['imageUrl'] ??
    raw['img'] ??
    raw['thumbnail'] ??
    raw['mainImage'] ??
    (Array.isArray(raw['images']) ? raw['images'][0] : null);
  const imageUrl =
    typeof imageRaw === 'string' && imageRaw.trim()
      ? imageRaw.trim()
      : imageRaw &&
          typeof imageRaw === 'object' &&
          typeof (imageRaw as Record<string, unknown>)['url'] === 'string'
        ? String((imageRaw as Record<string, unknown>)['url']).trim()
        : null;

  const barcodeRaw =
    raw['barcode'] ??
    raw['barCode'] ??
    raw['gtin'] ??
    raw['ean'] ??
    raw['itemCode'] ??
    raw['catalogNumber'];
  const barcodeStr =
    barcodeRaw !== undefined && barcodeRaw !== null
      ? String(barcodeRaw).trim()
      : '';
  let barcode: string | null =
    /^\d{6,14}$/.test(barcodeStr) && barcodeStr !== '0' ? barcodeStr : null;
  if (!barcode) {
    barcode = extractVictoryBarcodeFromUrl(imageUrl);
  }

  const idRaw =
    raw['id'] ??
    raw['productId'] ??
    raw['catalogProductId'] ??
    raw['sku'] ??
    raw['slug'] ??
    barcode;
  if (idRaw === undefined || idRaw === null || String(idRaw).trim() === '') {
    return null;
  }
  const code = String(idRaw).trim();

  const brandObj = raw['brand'];
  const brandName =
    typeof brandObj === 'string' && brandObj.trim()
      ? brandObj.trim()
      : typeof raw['brandName'] === 'string' && raw['brandName'].trim()
        ? raw['brandName'].trim()
        : typeof raw['manufacturer'] === 'string' && raw['manufacturer'].trim()
          ? raw['manufacturer'].trim()
          : brandObj && typeof brandObj === 'object'
            ? (typeof (brandObj as Record<string, unknown>)['name'] === 'string'
                ? String((brandObj as Record<string, unknown>)['name']).trim()
                : null)
            : null;

  const isWeighable = Boolean(
    raw['isWeighable'] ??
      raw['isWeight'] ??
      raw['soldByWeight'] ??
      raw['byWeight'] ??
      branch['isWeighable'],
  );
  const sellingMethod: SellingMethodCode = isWeighable ? 'BY_WEIGHT' : 'BY_UNIT';

  const weightVal = raw['weight'] ?? raw['content'] ?? raw['size'];
  const unitStr =
    typeof raw['unitOfMeasure'] === 'string'
      ? raw['unitOfMeasure'].trim()
      : typeof raw['unit'] === 'string'
        ? raw['unit'].trim()
        : '';
  const unitDescription =
    typeof raw['unitDescription'] === 'string' && raw['unitDescription'].trim()
      ? raw['unitDescription'].trim()
      : weightVal && unitStr
        ? `${weightVal} ${unitStr}`
        : typeof weightVal === 'string' && weightVal.trim()
          ? weightVal.trim()
          : isWeighable
            ? '1 ק"ג'
            : null;

  const isOutOfStock =
    raw['isOutOfStock'] === true ||
    raw['outOfStock'] === true ||
    raw['inStock'] === false ||
    raw['available'] === false ||
    branch['isOutOfStock'] === true ||
    branch['isActive'] === false;
  const inStock = !isOutOfStock;

  let promotionMsg: string | null = null;
  if (typeof raw['promotionText'] === 'string' && raw['promotionText'].trim()) {
    promotionMsg = raw['promotionText'].trim();
  } else if (hasSale && regularPrice > salePrice) {
    promotionMsg = `מבצע! במקום ${formatCurrency(regularPrice)}`;
  }

  return {
    code,
    storeId: 'victory',
    barcode,
    name,
    brandName,
    unitDescription,
    sellingMethod,
    price: Number(effectivePrice.toFixed(2)),
    formattedPrice: formatCurrency(effectivePrice),
    pricePerUnitText: null,
    promotionMsg,
    inStock,
    purchasable: inStock && effectivePrice > 0,
    categoryName:
      typeof raw['categoryName'] === 'string'
        ? raw['categoryName'].trim()
        : null,
    imageUrl,
  };
}

/**
 * Recursively extracts Victory catalog products from any JSON API payload
 * (Next.js API routes, Algolia/Typesense/Meilisearch hits, REST arrays, etc.).
 */
export function parseVictoryJsonProducts(
  payload: unknown,
  limit = 15,
): CatalogProduct[] {
  const found: CatalogProduct[] = [];
  const seenCodes = new Set<string>();

  const walk = (node: unknown, depth: number) => {
    if (depth > 6 || found.length >= limit || !node) return;
    if (Array.isArray(node)) {
      for (const entry of node) {
        if (found.length >= limit) break;
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const parsed = parseVictoryJsonObject(entry as Record<string, unknown>);
          if (parsed && !seenCodes.has(parsed.code)) {
            seenCodes.add(parsed.code);
            found.push(parsed);
            continue;
          }
        }
        walk(entry, depth + 1);
      }
      return;
    }
    if (typeof node === 'object') {
      const rec = node as Record<string, unknown>;
      // Prefer well-known collection keys first
      const priorityKeys = [
        'products',
        'items',
        'hits',
        'results',
        'data',
        'catalogProducts',
        'list',
      ];
      for (const key of priorityKeys) {
        if (key in rec) {
          walk(rec[key], depth + 1);
          if (found.length >= limit) return;
        }
      }
      for (const [key, val] of Object.entries(rec)) {
        if (priorityKeys.includes(key)) continue;
        if (val && typeof val === 'object') {
          walk(val, depth + 1);
          if (found.length >= limit) return;
        }
      }
    }
  };

  walk(payload, 0);
  return found;
}

/**
 * Parses Victory Online's Next.js rendered product cards (`a[href*="/product/"]`)
 * into normalized CatalogProduct entries, including GS1 barcode extraction from image URLs.
 */
export function parseVictoryDomCards(
  rawCards: VictoryDomCardInput[],
  limit = 15,
): CatalogProduct[] {
  const results: CatalogProduct[] = [];
  const seenCodes = new Set<string>();

  for (const card of rawCards) {
    if (results.length >= limit) break;
    const rawText = (card.text ?? '').replace(/\s+/g, ' ').trim();
    if (!rawText && !card.title && !card.alt) continue;

    // Extract multi-buy promo label before stripping it from price detection
    const multiBuyMatch = /(\d+\s*ב-?\s*₪?\s*\d+(?:\.\d{1,2})?)/.exec(rawText);
    let promotionMsg: string | null = multiBuyMatch?.[1]?.trim() ?? null;

    // Remove per-100g / per-100ml / per-500g comparison unit prices & multi-buy promo prices
    // so we isolate the actual product price(s)
    const priceSearchText = rawText
      .replace(
        /₪\s*\d+(?:\.\d{1,2})?\s*ל(?:100|500|1000)?\s*(?:גרם|גר'|ג'|מ"ל|מ״ל|מל|ק"ג|ק״ג|קג|ליטר)/gi,
        ' ',
      )
      .replace(/\d+\s*ב-?\s*₪\s*\d+(?:\.\d{1,2})?/gi, ' ')
      .replace(/₪\s*\d+(?:\.\d{1,2})?\s*(?:ליחידה|לק"ג|לק״ג)/gi, (m) => m);

    const priceMatches = [...priceSearchText.matchAll(/₪\s*(\d+(?:\.\d{1,2})?)/g)]
      .map((m) => Number(m[1]))
      .filter((n) => Number.isFinite(n) && n > 0 && n < 5000);

    if (priceMatches.length === 0) continue;

    // When Victory shows sale + struck-through regular price (e.g. "₪11.90₪25.90"),
    // the effective price is the minimum of the displayed item prices.
    const effectivePrice = Math.min(...priceMatches);
    const maxPrice = Math.max(...priceMatches);
    if (!promotionMsg && maxPrice > effectivePrice) {
      promotionMsg = `מבצע! במקום ${formatCurrency(maxPrice)}`;
    }

    const barcode = extractVictoryBarcodeFromUrl(card.imgSrc);

    let slug = '';
    const slugMatch = /\/product\/([^/?#]+)/i.exec(card.href ?? '');
    if (slugMatch?.[1]) {
      try {
        slug = decodeURIComponent(slugMatch[1]).trim();
      } catch {
        slug = slugMatch[1].trim();
      }
    }

    const code = barcode || slug;
    if (!code || seenCodes.has(code)) continue;

    const cleanCandidateTitle = (s: string | null | undefined): string => {
      if (!s) return '';
      return s
        .replace(/ - תמונה \d+ מתוך \d+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    };

    let name =
      cleanCandidateTitle(card.title) ||
      cleanCandidateTitle(card.alt) ||
      slug.replace(/-/g, ' ').trim();

    if (!name || name.length < 2) {
      // Fallback to stripping price/promo tokens from rawText
      name = rawText
        .replace(/₪\s*\d+(?:\.\d{1,2})?/g, '')
        .replace(/מבצע|הוספה לסל|ליחידה|לק"ג|לק״ג/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
    }
    if (!name || name.length < 2) continue;

    const unitMatch =
      /(\d+(?:\.\d+)?\s*(?:גרם|גר'|ג'|ק"ג|ק״ג|קג|מ"ל|מ״ל|מל|ליטר|יח'))/i.exec(
        rawText,
      );
    const unitDescription = unitMatch?.[1]?.trim() ?? null;

    const isWeighable =
      rawText.includes('לק"ג') ||
      rawText.includes('לק״ג') ||
      rawText.includes('500גרם500גרם');

    const inStock =
      !rawText.includes('אזל מהמלאי') && !rawText.includes('חסר במלאי');

    seenCodes.add(code);
    results.push({
      code,
      storeId: 'victory',
      barcode,
      name,
      brandName: null,
      unitDescription: unitDescription ?? (isWeighable ? '1 ק"ג' : null),
      sellingMethod: isWeighable ? 'BY_WEIGHT' : 'BY_UNIT',
      price: Number(effectivePrice.toFixed(2)),
      formattedPrice: formatCurrency(effectivePrice),
      pricePerUnitText: null,
      promotionMsg,
      inStock,
      purchasable: inStock && effectivePrice > 0,
      categoryName: null,
      imageUrl: card.imgSrc ?? null,
    });
  }

  return results;
}

/**
 * Client for Victory Online's Next.js storefront (https://www.victoryonline.co.il).
 * Uses a reusable headless Chromium session to execute live searches against Victory's
 * new 2026 storefront, automatically discovering & reusing any underlying JSON search API
 * when available, with full DOM card parsing + GS1 barcode extraction as fallback.
 */
export class VictoryClient implements StoreClient {
  readonly storeId = 'victory' as const;
  readonly meta: StoreMeta;

  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly deliveryFee: number | null;

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private pageInitialized = false;
  private isGuestSession = true;
  private discoveredSearchUrlTemplate: string | null = null;
  private authFallbackReason: string | null = null;

  private selectedSlot: DeliverySlot | null = null;
  private readonly knownProducts = new Map<string, CatalogProduct>();
  private readonly trackedCart = new Map<string, TrackedCartEntry>();

  constructor(private readonly options: VictoryClientOptions) {
    this.meta = {
      ...STORE_META.victory,
      ...(options.defaultDeliveryFee !== undefined
        ? { defaultDeliveryFee: options.defaultDeliveryFee }
        : {}),
    };
    this.baseUrl = (options.baseUrl ?? VICTORY_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
    this.deliveryFee =
      options.defaultDeliveryFee ?? STORE_META.victory.defaultDeliveryFee;

    // Check if a saved SMS OTP session already exists on disk
    if (this.readSavedSessionFile()) {
      this.isGuestSession = false;
    }
  }

  private readSavedSessionFile(): {
    savedAt: string;
    cookies?: Array<Record<string, unknown>>;
    localStorage?: Record<string, string>;
  } | null {
    if (!fs.existsSync(this.options.sessionFilePath)) return null;
    try {
      const raw = fs.readFileSync(this.options.sessionFilePath, 'utf8');
      const parsed = JSON.parse(raw) as {
        savedAt?: string;
        cookies?: Array<Record<string, unknown>>;
        localStorage?: Record<string, string>;
      };
      if (
        (Array.isArray(parsed.cookies) && parsed.cookies.length > 0) ||
        (parsed.localStorage && Object.keys(parsed.localStorage).length > 0)
      ) {
        return {
          savedAt: parsed.savedAt ?? new Date().toISOString(),
          cookies: parsed.cookies,
          localStorage: parsed.localStorage,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async saveVictorySession(): Promise<void> {
    if (!this.page || this.page.isClosed()) return;
    try {
      const cookies = (await this.context?.cookies().catch(() => [])) ?? [];
      const localStorageData = await this.page
        .evaluate(() => {
          const out: Record<string, string> = {};
          for (let i = 0; i < window.localStorage.length; i++) {
            const k = window.localStorage.key(i);
            if (!k) continue;
            const v = window.localStorage.getItem(k);
            if (v !== null) out[k] = v;
          }
          return out;
        })
        .catch(() => ({} as Record<string, string>));

      fs.writeFileSync(
        this.options.sessionFilePath,
        JSON.stringify(
          {
            savedAt: new Date().toISOString(),
            cookies,
            localStorage: localStorageData,
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch (err) {
      logger.warn('Failed saving Victory session', err);
    }
  }

  getAuthWarning(): string | null {
    return this.authFallbackReason;
  }

  private async fetchWithTimeout(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      return await this.fetchFn(url, {
        ...init,
        signal: init?.signal ?? controller.signal,
        headers: {
          Accept: 'application/json, text/html, */*',
          'User-Agent': DEFAULT_USER_AGENT,
          Origin: this.baseUrl,
          Referer: `${this.baseUrl}/`,
          ...(init?.headers as Record<string, string> | undefined),
        },
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(
          `ויקטורי לא הגיב תוך ${HTTP_TIMEOUT_MS / 1000} שניות`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private rememberProducts(products: CatalogProduct[]): CatalogProduct[] {
    for (const p of products) {
      this.knownProducts.set(p.code, p);
    }
    return products;
  }

  private async ensureBrowserPage(): Promise<Page | null> {
    if (!this.options.chromePath && !this.options.browserWsEndpoint) {
      return null;
    }

    if (this.page && !this.page.isClosed() && this.pageInitialized) {
      return this.page;
    }

    if (!this.browser || !this.browser.connected) {
      if (this.options.browserWsEndpoint) {
        this.browser = await puppeteer.connect({
          browserWSEndpoint: this.options.browserWsEndpoint,
        });
      } else {
        const args = [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--lang=he-IL',
          '--window-size=1366,900',
        ];
        if (this.options.proxyUrl) {
          args.push(`--proxy-server=${this.options.proxyUrl}`);
        }
        this.browser = await puppeteer.launch({
          executablePath: this.options.chromePath,
          headless: this.options.headless,
          args,
        });
      }
    }

    if (!this.context) {
      this.context = await this.browser.createBrowserContext();
    }
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
      await this.page.setUserAgent(DEFAULT_USER_AGENT);
      await this.page.setViewport({ width: 1366, height: 900 });
    }

    const saved = this.readSavedSessionFile();
    if (saved?.cookies && saved.cookies.length > 0) {
      await this.context
        .setCookie(
          ...(saved.cookies as unknown as Parameters<
            BrowserContext['setCookie']
          >),
        )
        .catch(() => {});
    }

    logger.info('Opening Victory Online Next.js storefront in Chromium...');
    await this.page.goto(`${this.baseUrl}/`, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT,
    });

    if (saved?.localStorage && Object.keys(saved.localStorage).length > 0) {
      await this.page
        .evaluate((entries: Record<string, string>) => {
          for (const [k, v] of Object.entries(entries)) {
            try {
              window.localStorage.setItem(k, v);
            } catch {
              // ignore storage quota errors
            }
          }
        }, saved.localStorage)
        .catch(() => {});
      await this.page
        .reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT })
        .catch(() => {});
    }

    await new Promise((r) => setTimeout(r, 1500));

    const gateDetected = await this.page.evaluate(() => {
      const title = document.title?.toLowerCase() ?? '';
      const html = document.documentElement?.innerHTML?.toLowerCase() ?? '';
      return (
        title.includes('just a moment') ||
        html.includes('cf-turnstile') ||
        html.includes('g-recaptcha') ||
        html.includes('hcaptcha')
      );
    });

    if (gateDetected) {
      throw new StoreManualVerificationRequiredError(
        'victory',
        'SECURITY_GATE',
        'אתר ויקטורי אונליין מציג בדיקת אבטחה/CAPTCHA. המערכת אינה עוקפת בדיקות אבטחה.',
      );
    }

    // Dismiss CookieYes / legal notice popups if shown
    await this.page
      .evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
          const t = (btn.textContent ?? '').trim();
          if (
            t === 'הבנתי' ||
            t.includes('מאשר/ת הכול') ||
            t.includes('דחה הכול')
          ) {
            btn.click();
          }
        }
      })
      .catch(() => {});

    // Check if the restored session is genuinely logged in
    const stillGuest = await this.page
      .evaluate(() => (document.body?.innerText ?? '').includes('שלום אורח'))
      .catch(() => true);
    this.isGuestSession = stillGuest;

    this.pageInitialized = true;
    return this.page;
  }

  private async tryHttpSearchFallback(
    cleanQuery: string,
    limit: number,
  ): Promise<CatalogProduct[]> {
    const encoded = encodeURIComponent(cleanQuery);
    const urls = this.discoveredSearchUrlTemplate
      ? [this.discoveredSearchUrlTemplate.replace('{QUERY}', encoded)]
      : [
          `${this.baseUrl}/api/search?q=${encoded}`,
          `${this.baseUrl}/api/products?q=${encoded}`,
          `${this.baseUrl}/search?q=${encoded}`,
        ];

    for (const url of urls) {
      try {
        const res = await this.fetchWithTimeout(url, { method: 'GET' });
        if (!res.ok) continue;
        const contentType = res.headers.get('content-type') ?? '';
        const text = await res.text();
        if (contentType.includes('application/json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
          const parsed = parseVictoryJsonProducts(JSON.parse(text), limit);
          if (parsed.length > 0) {
            return this.rememberProducts(parsed);
          }
        }
      } catch {
        // try next URL
      }
    }
    return [];
  }

  private async searchViaDiscoveredApi(
    page: Page,
    cleanQuery: string,
    limit: number,
  ): Promise<CatalogProduct[] | null> {
    if (!this.discoveredSearchUrlTemplate) return null;
    const url = this.discoveredSearchUrlTemplate.replace(
      '{QUERY}',
      encodeURIComponent(cleanQuery),
    );
    try {
      const payload = await page.evaluate(async (targetUrl: string) => {
        const res = await fetch(targetUrl, {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'application/json, */*' },
        });
        if (!res.ok) return null;
        return res.json().catch(() => null);
      }, url);
      if (!payload) return null;
      return this.rememberProducts(parseVictoryJsonProducts(payload, limit));
    } catch (err) {
      logger.debug('Victory discovered API replay failed; falling back to UI', err);
      this.discoveredSearchUrlTemplate = null;
      return null;
    }
  }

  async searchProducts(query: string, limit = 15): Promise<CatalogProduct[]> {
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    // Fast path when no browser is configured (e.g. unit tests with custom fetchFn)
    if (!this.options.chromePath && !this.options.browserWsEndpoint) {
      return this.tryHttpSearchFallback(cleanQuery, limit);
    }

    let page: Page | null;
    try {
      page = await this.ensureBrowserPage();
    } catch (err) {
      if (err instanceof StoreManualVerificationRequiredError) throw err;
      logger.warn('Victory Chromium init failed; trying HTTP fallback', err);
      return this.tryHttpSearchFallback(cleanQuery, limit);
    }
    if (!page) {
      return this.tryHttpSearchFallback(cleanQuery, limit);
    }

    // Fast path: if we already discovered Victory's live JSON search API, call it directly
    if (this.discoveredSearchUrlTemplate) {
      const fastResults = await this.searchViaDiscoveredApi(
        page,
        cleanQuery,
        limit,
      );
      if (fastResults !== null) {
        return fastResults;
      }
    }

    // Capture any JSON search API responses fired by Victory's Next.js UI
    const capturedJsonProducts: CatalogProduct[] = [];
    const encodedQuery = encodeURIComponent(cleanQuery);

    const onResponse = async (res: HTTPResponse) => {
      try {
        const url = res.url();
        if (IGNORED_API_HOST_PATTERNS.some((h) => url.includes(h))) return;
        const ct = (res.headers()['content-type'] ?? '').toLowerCase();
        if (!ct.includes('json')) return;
        if (res.status() < 200 || res.status() >= 300) return;

        const data = await res.json().catch(() => null);
        if (!data) return;

        const parsed = parseVictoryJsonProducts(data, limit);
        if (parsed.length > 0) {
          capturedJsonProducts.push(...parsed);
          if (
            !this.discoveredSearchUrlTemplate &&
            res.request().method() === 'GET'
          ) {
            if (url.includes(encodedQuery)) {
              this.discoveredSearchUrlTemplate = url.replace(
                encodedQuery,
                '{QUERY}',
              );
              logger.info(
                `Discovered Victory Online live search API: ${this.discoveredSearchUrlTemplate}`,
              );
            } else if (url.includes(cleanQuery)) {
              this.discoveredSearchUrlTemplate = url.replace(
                cleanQuery,
                '{QUERY}',
              );
              logger.info(
                `Discovered Victory Online live search API: ${this.discoveredSearchUrlTemplate}`,
              );
            }
          }
        }
      } catch {
        // Ignore non-JSON or closed-body responses
      }
    };

    page.on('response', onResponse);
    try {
      // Ensure search input is visible (click mobile/header search trigger if needed)
      const inputFound = await page.evaluate((searchText: string) => {
        const findInput = (): HTMLInputElement | null =>
          (document.querySelector(
            'input[placeholder*="חיפוש"], input[type="search"], input[aria-label*="חיפוש"], input[name*="search"]',
          ) as HTMLInputElement | null);

        let inp = findInput();
        if (!inp) {
          const triggers = Array.from(
            document.querySelectorAll('button, a, [role="button"]'),
          );
          const searchTrigger = triggers.find((el) => {
            const t = (el.textContent ?? '').trim();
            const aria = el.getAttribute('aria-label') ?? '';
            return t.includes('חיפוש') || aria.includes('חיפוש');
          }) as HTMLElement | undefined;
          searchTrigger?.click();
          inp = findInput();
        }
        if (!inp) return false;

        inp.focus();
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        if (setter) {
          setter.call(inp, searchText);
        } else {
          inp.value = searchText;
        }
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, cleanQuery);

      if (inputFound) {
        await page.keyboard.press('Enter').catch(() => {});
      } else {
        // Fallback: navigate directly to Victory's search route
        await page
          .goto(`${this.baseUrl}/search?q=${encodedQuery}`, {
            waitUntil: 'domcontentloaded',
            timeout: 15_000,
          })
          .catch(() => {});
      }

      // Wait briefly for API response or DOM search results to render
      const deadline = Date.now() + 3_500;
      while (Date.now() < deadline && capturedJsonProducts.length === 0) {
        await new Promise((r) => setTimeout(r, 300));
      }

      if (capturedJsonProducts.length > 0) {
        const deduped: CatalogProduct[] = [];
        const seen = new Set<string>();
        for (const p of capturedJsonProducts) {
          if (!seen.has(p.code)) {
            seen.add(p.code);
            deduped.push(p);
          }
          if (deduped.length >= limit) break;
        }
        return this.rememberProducts(deduped);
      }

      // Extract rendered product cards from the DOM (preferring search dropdown/results container)
      const domExtraction = await page.evaluate((): {
        cards: VictoryDomCardInput[];
        isHomepageFallback: boolean;
      } => {
        const dedicatedSelectors = [
          '[role="dialog"]',
          '[role="listbox"]',
          '[class*="searchResult" i]',
          '[class*="search-result" i]',
          '[class*="autocomplete" i]',
        ];
        let searchRoot: Element | null = null;
        let isDedicated = false;
        for (const sel of dedicatedSelectors) {
          const el = document.querySelector(sel);
          if (el && el.querySelector('a[href*="/product/"]')) {
            searchRoot = el;
            isDedicated = true;
            break;
          }
        }
        const isSearchRoute =
          window.location.pathname.includes('search') ||
          window.location.search.includes('q=') ||
          window.location.search.includes('query=') ||
          window.location.search.includes('search=');

        if (!searchRoot) {
          searchRoot = document.querySelector('main') ?? document.body;
        }

        const links = Array.from(
          searchRoot.querySelectorAll('a[href*="/product/"]'),
        );
        const cards: VictoryDomCardInput[] = [];
        const seenHref = new Set<string>();

        for (const a of links) {
          const href = a.getAttribute('href') ?? '';
          if (!href || seenHref.has(href)) continue;
          seenHref.add(href);

          // Walk up to the enclosing product card container that holds price (₪)
          let container: HTMLElement | null = a as HTMLElement;
          for (let depth = 0; depth < 4 && container?.parentElement; depth++) {
            if ((container.textContent ?? '').includes('₪')) break;
            container = container.parentElement;
          }
          const text = (container?.textContent ?? a.textContent ?? '').trim();
          const img =
            container?.querySelector('img') ?? a.querySelector('img');
          const heading =
            container?.querySelector('h2, h3, h4, [class*="title" i], [class*="name" i]') ??
            a;
          cards.push({
            href,
            text,
            imgSrc: img?.getAttribute('src') ?? null,
            alt: img?.getAttribute('alt') ?? null,
            title: heading?.textContent?.trim() ?? null,
          });
          if (cards.length >= 40) break;
        }
        return {
          cards,
          isHomepageFallback: !isDedicated && !isSearchRoute,
        };
      });

      let parsedDom = parseVictoryDomCards(domExtraction.cards, limit);
      if (domExtraction.isHomepageFallback && parsedDom.length > 0) {
        const queryTokens = cleanQuery
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length >= 2);
        parsedDom = parsedDom.filter((p) => {
          const hay = `${p.name} ${p.barcode ?? ''} ${p.code}`.toLowerCase();
          return queryTokens.some((t) => hay.includes(t));
        });
      }
      if (parsedDom.length > 0) {
        return this.rememberProducts(parsedDom);
      }
      return [];
    } finally {
      page.off('response', onResponse);
    }
  }

  private buildTrackedCartState(): CartState {
    const items: CartItem[] = [];
    let totalPrice = 0;
    let idx = 0;
    for (const entry of this.trackedCart.values()) {
      if (entry.quantity <= 0) continue;
      const itemPrice = Number((entry.unitPrice * entry.quantity).toFixed(2));
      if (entry.inStock) {
        totalPrice += itemPrice;
      }
      items.push({
        entryNumber: idx++,
        productCode: entry.productCode,
        productName: entry.productName,
        quantity: entry.quantity,
        itemPrice,
        inStock: entry.inStock,
        sellingMethod: entry.sellingMethod,
      });
    }
    return {
      storeId: 'victory',
      items,
      totalPrice: Number(totalPrice.toFixed(2)),
      deliveryFee: this.selectedSlot?.deliveryFee ?? this.deliveryFee,
      orderInUpdateMode: null,
      isGuestSession: this.isGuestSession,
    };
  }

  async getCartState(): Promise<CartState> {
    return this.buildTrackedCartState();
  }

  async setItemsInCart(items: AddCartItemInput[]): Promise<CartState> {
    for (const item of items) {
      const cleanQty =
        item.sellingMethod === 'BY_WEIGHT'
          ? Number(item.quantity.toFixed(2))
          : Math.max(1, Math.round(item.quantity));
      const known = this.knownProducts.get(item.productCode);
      const existing = this.trackedCart.get(item.productCode);

      this.trackedCart.set(item.productCode, {
        productCode: item.productCode,
        productName:
          known?.name ?? existing?.productName ?? `מוצר (${item.productCode})`,
        quantity: cleanQty,
        unitPrice: known?.price ?? existing?.unitPrice ?? 0,
        sellingMethod: item.sellingMethod,
        inStock: known?.inStock ?? true,
      });
    }
    return this.buildTrackedCartState();
  }

  async updateCartItemQuantity(
    productCode: string,
    quantity: number,
  ): Promise<CartState> {
    if (quantity <= 0) {
      return this.removeFromCart(productCode);
    }
    const existing = this.trackedCart.get(productCode);
    const known = this.knownProducts.get(productCode);
    return this.setItemsInCart([
      {
        productCode,
        quantity,
        sellingMethod:
          existing?.sellingMethod ?? known?.sellingMethod ?? 'BY_UNIT',
      },
    ]);
  }

  async removeFromCart(productCode: string): Promise<CartState> {
    this.trackedCart.delete(productCode);
    return this.buildTrackedCartState();
  }

  async clearCart(): Promise<void> {
    this.trackedCart.clear();
  }

  async getAvailableTimeSlots(): Promise<DeliverySlot[]> {
    return [];
  }

  async getSelectedTimeSlot(): Promise<DeliverySlot | null> {
    return this.selectedSlot;
  }

  async selectTimeSlot(slotCode: string): Promise<DeliverySlot> {
    throw new Error(`חלון המשלוח (${slotCode}) לא נמצא בויקטורי`);
  }

  async getActiveOrders(): Promise<ActiveOrderSummary[]> {
    return [];
  }

  async putOrderInUpdateMode(_orderCode: string): Promise<CartState> {
    throw new Error('עדכון הזמנה קיימת אינו נתמך אוטומטית בויקטורי');
  }

  async placeOrder(_options: {
    removeMissingItems: boolean;
  }): Promise<CheckoutResult> {
    const cart = await this.getCartState();
    if (cart.items.length === 0) {
      throw new Error('עגלת ויקטורי ריקה – אין מה להזמין.');
    }

    const total = formatCurrency(cart.totalPrice);
    const minAmount = this.meta.minimumOrderAmount;
    const minNote =
      minAmount && cart.totalPrice < minAmount
        ? `\n⚠️ שימו לב: מינימום הזמנה בויקטורי הוא ${formatCurrency(minAmount)}.`
        : '';

    const previewItems = cart.items.slice(0, 25);
    const checklist = previewItems
      .map(
        (i, idx) =>
          `${idx + 1}. ${i.productName ?? i.productCode} × ${i.quantity} (${formatCurrency(i.itemPrice)})`,
      )
      .join('\n');
    const moreNote =
      cart.items.length > previewItems.length
        ? `\n...ועוד ${cart.items.length - previewItems.length} פריטים`
        : '';
    const loginHint = this.isGuestSession
      ? `\nℹ️ להתחברות לחשבון ויקטורי באמצעות SMS שלחו: /login_victory 05XXXXXXXX`
      : `\n✅ מחובר לחשבון ויקטורי אונליין.`;

    throw new StoreManualVerificationRequiredError(
      'victory',
      'MANUAL_CHECKOUT',
      `📋 סיכום סל ויקטורי אונליין: ${cart.items.length} פריטים בסך ${total}.${minNote}${loginHint}\n\nרשימת הפריטים להזמנה:\n${checklist}${moreNote}`,
      this.meta.baseUrl,
    );
  }

  private async captureLoginDiagnosticScreenshot(tag: string): Promise<void> {
    if (!this.page || this.page.isClosed()) return;
    try {
      fs.mkdirSync(this.options.screenshotsDir, { recursive: true });
      const file = path.join(
        this.options.screenshotsDir,
        `victory-${tag}-${Date.now()}.png`,
      );
      await this.page.screenshot({ path: file });
      logger.info(`Saved Victory diagnostic screenshot: ${file}`);
    } catch {
      // ignore screenshot errors
    }
  }

  async startSmsOtpLogin(phoneNumber: string): Promise<{ message: string }> {
    const cleanPhone = normalizeIsraeliPhone(phoneNumber);
    if (!cleanPhone) {
      throw new Error(
        'מספר הטלפון אינו תקין. אנא הזינו מספר ישראלי בן 10 ספרות המתחיל ב-05 (למשל 0501234567).',
      );
    }

    const page = await this.ensureBrowserPage();
    if (!page) {
      throw new Error(
        'Chromium אינו מוגדר בשרת – לא ניתן להריץ התחברות SMS עבור ויקטורי אונליין.',
      );
    }

    logger.info('Starting SMS OTP login flow for Victory Online...');

    // Ensure we are on homepage and click the login trigger ("להתחברות" / "שלום אורח")
    await page.goto(`${this.baseUrl}/`, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT,
    });
    await new Promise((r) => setTimeout(r, 1500));

    // Dismiss CookieYes / legal popup if shown
    await page
      .evaluate(() => {
        for (const btn of Array.from(document.querySelectorAll('button'))) {
          const t = (btn.textContent ?? '').trim();
          if (
            t === 'הבנתי' ||
            t.includes('מאשר/ת הכול') ||
            t.includes('דחה הכול')
          ) {
            btn.click();
          }
        }
      })
      .catch(() => {});

    const opened = await page.evaluate(() => {
      const findPhoneInput = () =>
        document.querySelector(
          'input[type="tel"], input[name*="phone" i], input[placeholder*="טלפון"], input[placeholder*="נייד"], input[inputmode="tel"]',
        ) as HTMLInputElement | null;

      if (findPhoneInput()) return 'already_open';

      const els = Array.from(
        document.querySelectorAll('button, a, [role="button"], span, div'),
      );
      const loginTrigger = els.find((el) => {
        const t = (el.textContent ?? '').trim();
        return (
          t.length <= 35 &&
          (t.includes('להתחברות') ||
            t === 'התחברות' ||
            t === 'כניסה' ||
            t.includes('שלום אורח'))
        );
      }) as HTMLElement | undefined;

      if (loginTrigger) {
        loginTrigger.click();
        return 'clicked_login';
      }
      return 'not_found';
    });

    if (opened !== 'already_open') {
      await new Promise((r) => setTimeout(r, 2000));
    }

    await page
      .waitForSelector(
        'input[type="tel"], input[name*="phone" i], input[placeholder*="טלפון"], input[placeholder*="נייד"], input[inputmode="tel"]',
        { timeout: 10_000 },
      )
      .catch(() => null);

    const gateDetected = await page.evaluate(() => {
      const html = document.documentElement?.innerHTML?.toLowerCase() ?? '';
      return (
        html.includes('cf-turnstile') ||
        html.includes('g-recaptcha') ||
        html.includes('hcaptcha')
      );
    });
    if (gateDetected) {
      throw new StoreManualVerificationRequiredError(
        'victory',
        'SECURITY_GATE',
        'אתר ויקטורי אונליין מציג בדיקת אבטחה/CAPTCHA. המערכת אינה עוקפת בדיקות אבטחה.',
      );
    }

    const submitted = await page.evaluate((phone: string) => {
      const inp = document.querySelector(
        'input[type="tel"], input[name*="phone" i], input[placeholder*="טלפון"], input[placeholder*="נייד"], input[inputmode="tel"]',
      ) as HTMLInputElement | null;
      if (!inp) return { ok: false, reason: 'no_phone_input' };

      inp.focus();
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      if (setter) setter.call(inp, phone);
      else inp.value = phone;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));

      const scope =
        inp.closest('form') ?? inp.closest('[role="dialog"]') ?? document;
      const sendBtn =
        (Array.from(scope.querySelectorAll('button')).find((b) => {
          const t = (b.textContent ?? '').trim();
          return (
            t.length <= 30 &&
            (t.includes('שלח') ||
              t.includes('קבל קוד') ||
              t.includes('המשך') ||
              t.includes('התחברות') ||
              t.includes('כניסה'))
          );
        }) as HTMLElement | undefined) ??
        (scope.querySelector('button[type="submit"]') as HTMLElement | null);

      if (sendBtn) {
        sendBtn.click();
        return { ok: true, reason: 'clicked_send' };
      }
      return { ok: true, reason: 'enter_fallback' };
    }, cleanPhone);

    if (!submitted.ok) {
      await this.captureLoginDiagnosticScreenshot('otp-no-phone-input');
      throw new Error(
        'לא נמצא שדה הזנת מספר טלפון באתר ויקטורי אונליין. נסו שוב בעוד רגע.',
      );
    }

    if (submitted.reason === 'enter_fallback') {
      await page.keyboard.press('Enter').catch(() => {});
    }

    await new Promise((r) => setTimeout(r, 2500));

    return {
      message:
        '📱 נשלח קוד SMS מ-ויקטורי אונליין לטלפון שלך!\nשלחו כאן את הקוד שקיבלתם (למשל <code>123456</code> או <code>/otp 123456</code>).',
    };
  }

  async completeSmsOtpLogin(
    otpCode: string,
  ): Promise<{ message: string; isAuthenticated: boolean }> {
    const cleanCode = otpCode.replace(/\D/g, '').trim();
    if (cleanCode.length < 4 || cleanCode.length > 8) {
      throw new Error('קוד האימות חייב להכיל 4 עד 8 ספרות.');
    }

    if (!this.page || this.page.isClosed()) {
      throw new Error(
        'סשן ההתחברות של ויקטורי פג או נסגר. הריצו שוב /login_victory עם מספר הטלפון.',
      );
    }

    logger.info('Submitting SMS OTP verification for Victory Online...');

    const fillResult = await this.page.evaluate((code: string) => {
      const dialog =
        document.querySelector('[role="dialog"], [class*="modal" i]') ??
        document;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;

      const setVal = (inp: HTMLInputElement, val: string) => {
        inp.focus();
        if (setter) setter.call(inp, val);
        else inp.value = val;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      };

      // 1. Multi-box OTP inputs (one digit per box)
      const digitBoxes = Array.from(
        dialog.querySelectorAll(
          'input[maxlength="1"], [class*="otp" i] input, [data-testid*="otp" i] input',
        ),
      ).filter((el) => {
        const inp = el as HTMLInputElement;
        return inp.offsetParent !== null && !inp.disabled;
      }) as HTMLInputElement[];

      if (digitBoxes.length >= code.length && digitBoxes.length <= 8) {
        digitBoxes.forEach((inp, idx) => {
          setVal(inp, code[idx] ?? '');
        });
      } else {
        // 2. Single OTP input
        const inp = dialog.querySelector(
          'input[placeholder*="קוד"], input[name*="otp" i], input[name*="code" i], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="tel"]',
        ) as HTMLInputElement | null;
        if (!inp) return { ok: false, reason: 'no_otp_input' };
        setVal(inp, code);
      }

      const verifyBtn =
        (Array.from(dialog.querySelectorAll('button')).find((b) => {
          const t = (b.textContent ?? '').trim();
          return (
            t.length <= 30 &&
            (t.includes('אמת') ||
              t.includes('אימות') ||
              t.includes('התחברות') ||
              t === 'כניסה' ||
              t === 'אישור' ||
              t === 'המשך')
          );
        }) as HTMLElement | undefined) ??
        (dialog.querySelector('button[type="submit"]') as HTMLElement | null);

      if (verifyBtn) {
        verifyBtn.click();
        return { ok: true, reason: 'clicked_verify' };
      }
      return { ok: true, reason: 'enter_fallback' };
    }, cleanCode);

    if (!fillResult.ok) {
      await this.captureLoginDiagnosticScreenshot('otp-no-code-input');
      throw new Error(
        'לא נמצא שדה הזנת קוד SMS באתר ויקטורי אונליין. נסו להתחיל שוב עם /login_victory.',
      );
    }

    if (fillResult.reason === 'enter_fallback') {
      await this.page.keyboard.press('Enter').catch(() => {});
    }

    await new Promise((r) => setTimeout(r, 4500));

    const verifyState = await this.page.evaluate(() => {
      const bodyText = document.body?.innerText ?? '';
      const stillGuest = bodyText.includes('שלום אורח');
      const dialogStillOpen = Boolean(
        document.querySelector(
          '[role="dialog"] input[placeholder*="קוד"], [role="dialog"] input[autocomplete="one-time-code"]',
        ),
      );
      return { stillGuest, dialogStillOpen };
    });

    if (verifyState.stillGuest && verifyState.dialogStillOpen) {
      await this.captureLoginDiagnosticScreenshot('otp-verify-failed');
      throw new Error(
        'אימות קוד ה-SMS בוויקטורי אונליין לא הושלם (ייתכן שהקוד שגוי או פג תוקפו). נסו שוב עם /login_victory.',
      );
    }

    this.isGuestSession = false;
    this.authFallbackReason = null;
    await this.saveVictorySession();
    logger.info('SMS OTP login succeeded for Victory Online; session saved');

    return {
      isAuthenticated: true,
      message:
        '✅ <b>התחברתם בהצלחה ל-ויקטורי אונליין!</b>\nהסשן נשמר אוטומטית ב-<code>data/victory-session.json</code>.',
    };
  }

  async shutdown(): Promise<void> {
    this.pageInitialized = false;
    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.close();
      }
    } catch {
      // ignore
    }
    try {
      if (this.context) {
        await this.context.close();
      }
    } catch {
      // ignore
    }
    try {
      if (this.browser) {
        if (this.options.browserWsEndpoint) {
          this.browser.disconnect();
        } else {
          await this.browser.close();
        }
      }
    } catch {
      // ignore
    }
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}
