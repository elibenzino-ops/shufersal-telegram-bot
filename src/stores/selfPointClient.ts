import fs from 'node:fs';
import path from 'node:path';
import puppeteer, {
  type Browser,
  type BrowserContext,
  type Page,
} from 'puppeteer-core';
import { logger } from '../logger.js';
import { formatCurrency, normalizeIsraeliPhone } from '../utils/format.js';
import {
  STORE_META,
  StoreAuthError,
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
  type StoreId,
  type StoreMeta,
} from './types.js';

const APP_ID = 4;
const LANGUAGE_ID = 1;
const NAVIGATION_TIMEOUT = 35_000;
const HTTP_TIMEOUT_MS = 15_000;
const IMAGE_BARCODE_RE = /\/(\d{7,14})-/;

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export const STANDARD_SELFPOINT_FILTERS = JSON.stringify({
  must: {
    exists: [
      'family.id',
      'family.categoriesPaths.id',
      'branch.regularPrice',
    ],
    term: {
      'branch.isActive': true,
      'branch.isVisible': true,
    },
  },
  mustNot: {
    term: {
      'branch.regularPrice': 0,
    },
  },
});

export interface SelfPointClientOptions {
  storeId: StoreId;
  envPrefix: string;
  baseUrl: string;
  retailerId: number;
  branchId: number;
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

interface PersistedSelfPointSession {
  savedAt: string;
  username?: string;
  token?: string;
  userId?: string | number;
  cartId?: string;
  branchId?: number;
  cookies?: unknown[];
}

interface TrackedCartEntry {
  productCode: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  sellingMethod: SellingMethodCode;
  inStock: boolean;
}

export function parseSelfPointProduct(
  raw: Record<string, unknown>,
  storeId: StoreId = 'super_haviv',
): CatalogProduct | null {
  // Important: Self-Point carts require the row id (`id` / `retailerProductId`), NOT branchProductId
  const idRaw = raw['id'] ?? raw['retailerProductId'];
  if (idRaw === undefined || idRaw === null || String(idRaw).trim() === '') {
    return null;
  }
  const code = String(idRaw).trim();

  const namesMap = (raw['names'] ?? {}) as Record<string, unknown>;
  const name = String(
    raw['localName'] ?? namesMap['1'] ?? raw['name'] ?? '',
  ).trim();
  if (!name) return null;

  const branch = (raw['branch'] ?? {}) as Record<string, unknown>;
  const regularPrice = Number(branch['regularPrice'] ?? raw['regularPrice'] ?? 0);
  const salePrice = Number(branch['salePrice'] ?? raw['salePrice'] ?? 0);
  const hasSale =
    salePrice > 0 &&
    Number.isFinite(salePrice) &&
    (regularPrice <= 0 || salePrice < regularPrice);
  const effectivePrice = hasSale
    ? salePrice
    : Number.isFinite(regularPrice) && regularPrice > 0
      ? regularPrice
      : 0;

  const isWeighable = Boolean(raw['isWeighable'] ?? branch['isWeighable']);
  const sellingMethod: SellingMethodCode = isWeighable ? 'BY_WEIGHT' : 'BY_UNIT';

  const brandObj = (raw['brand'] ?? {}) as Record<string, unknown>;
  const brandNames = (brandObj['names'] ?? {}) as Record<string, unknown>;
  const brandName =
    (typeof brandNames['1'] === 'string' && brandNames['1'].trim()) ||
    (typeof brandObj['name'] === 'string' && brandObj['name'].trim()) ||
    null;

  const weightVal = raw['weight'];
  const unitOfMeasure =
    typeof raw['unitOfMeasure'] === 'string'
      ? raw['unitOfMeasure'].trim()
      : '';
  let unitDescription: string | null = null;
  if (weightVal && unitOfMeasure) {
    unitDescription = `${weightVal} ${unitOfMeasure}`;
  } else if (
    typeof raw['unitDescription'] === 'string' &&
    raw['unitDescription'].trim()
  ) {
    unitDescription = raw['unitDescription'].trim();
  } else if (isWeighable) {
    unitDescription = '1 ק"ג';
  }

  const imageUrl =
    typeof raw['image'] === 'string' && raw['image'].trim()
      ? raw['image'].trim()
      : null;

  const barcodeRaw = raw['gtin'] ?? raw['barcode'] ?? raw['barCode'];
  const barcodeStr =
    barcodeRaw !== undefined && barcodeRaw !== null
      ? String(barcodeRaw).trim()
      : '';
  let barcode: string | null =
    /^\d{5,14}$/.test(barcodeStr) && barcodeStr !== '0' ? barcodeStr : null;
  if (!barcode && imageUrl) {
    const imgMatch = IMAGE_BARCODE_RE.exec(imageUrl);
    if (imgMatch?.[1]) {
      barcode = imgMatch[1];
    }
  }

  const isActive = branch['isActive'] !== false;
  const isVisible = branch['isVisible'] !== false;
  const isOutOfStock = branch['isOutOfStock'] === true;
  const inStock = isActive && isVisible && !isOutOfStock;

  let promotionMsg: string | null = null;
  if (hasSale && regularPrice > salePrice) {
    promotionMsg = `מבצע! במקום ${formatCurrency(regularPrice)}`;
  } else if (
    Array.isArray(branch['promotions']) &&
    branch['promotions'].length > 0
  ) {
    const firstPromo = branch['promotions'][0] as Record<string, unknown>;
    const label = firstPromo['description'] ?? firstPromo['name'];
    if (typeof label === 'string' && label.trim()) {
      promotionMsg = label.trim();
    }
  }

  const familyObj = (raw['family'] ?? {}) as Record<string, unknown>;
  const categoryName =
    typeof familyObj['name'] === 'string' && familyObj['name'].trim()
      ? familyObj['name'].trim()
      : null;

  return {
    code,
    storeId,
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
    categoryName,
    imageUrl,
  };
}

export function parseSelfPointCart(
  rawCart: Record<string, unknown>,
  defaultDeliveryFee: number | null,
  isGuestSession: boolean,
  storeId: StoreId = 'super_haviv',
): CartState {
  const rawLines = rawCart['lines'];
  const entries: Array<Record<string, unknown>> = Array.isArray(rawLines)
    ? (rawLines as Array<Record<string, unknown>>)
    : rawLines && typeof rawLines === 'object'
      ? (Object.values(rawLines) as Array<Record<string, unknown>>)
      : [];

  const items: CartItem[] = [];
  let computedSubtotal = 0;

  entries.forEach((line, idx) => {
    const product = (line['product'] ?? {}) as Record<string, unknown>;
    const branch = (product['branch'] ?? {}) as Record<string, unknown>;
    const productCode = String(
      line['retailerProductId'] ?? product['id'] ?? line['productId'] ?? '',
    ).trim();
    if (!productCode) return;

    const quantity = Number(line['quantity'] ?? 0);
    if (!Number.isFinite(quantity) || quantity <= 0) return;

    const isActive =
      line['isActive'] !== false && branch['isOutOfStock'] !== true;
    const regularPrice = Number(
      branch['regularPrice'] ?? line['regularPrice'] ?? 0,
    );
    const salePrice = Number(branch['salePrice'] ?? line['salePrice'] ?? 0);
    const unitPrice =
      salePrice > 0 && (regularPrice <= 0 || salePrice < regularPrice)
        ? salePrice
        : regularPrice;

    const lineTotalRaw = Number(
      line['totalPrice'] ??
        line['priceAfterDiscount'] ??
        line['price'] ??
        0,
    );
    const itemPrice =
      lineTotalRaw > 0
        ? Number(lineTotalRaw.toFixed(2))
        : Number((unitPrice * quantity).toFixed(2));

    if (isActive) {
      computedSubtotal += itemPrice;
    }

    const isWeighable = Boolean(product['isWeighable'] ?? line['isWeighable']);
    items.push({
      entryNumber: idx,
      productCode,
      productName:
        String(
          product['localName'] ?? product['name'] ?? line['name'] ?? '',
        ).trim() || undefined,
      quantity,
      itemPrice,
      inStock: isActive,
      sellingMethod: isWeighable ? 'BY_WEIGHT' : 'BY_UNIT',
    });
  });

  const totalObj = (rawCart['total'] ?? {}) as Record<string, unknown>;
  const serverSubtotal = Number(
    totalObj['priceForView'] ??
      totalObj['productsPrice'] ??
      rawCart['totalPrice'] ??
      rawCart['subTotal'] ??
      0,
  );
  const totalPrice =
    serverSubtotal > 0 && items.length > 0
      ? Number(serverSubtotal.toFixed(2))
      : Number(computedSubtotal.toFixed(2));

  const deliveryFeeRaw = Number(
    totalObj['deliveryPrice'] ?? rawCart['deliveryPrice'] ?? NaN,
  );
  const deliveryFee =
    Number.isFinite(deliveryFeeRaw) && deliveryFeeRaw >= 0
      ? deliveryFeeRaw
      : defaultDeliveryFee;

  return {
    storeId,
    items,
    totalPrice,
    deliveryFee,
    orderInUpdateMode: null,
    isGuestSession,
  };
}

/**
 * Shared client for Israeli grocery stores running on the Self-Point / Prutah (ZuZ)
 * platform (e.g., Super Haviv retailerId=1579, Victory Online retailerId=1470).
 */
export class SelfPointClient implements StoreClient {
  readonly storeId: StoreId;
  readonly meta: StoreMeta;

  private readonly baseUrl: string;
  private readonly retailerId: number;
  private branchId: number;
  private readonly fetchFn: typeof fetch;
  private deliveryFee: number | null;

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  private token: string | null = null;
  private userId: string | null = null;
  private cartId: string | null = null;
  private isGuestSession = true;
  private browserLoginAttempted = false;
  private authFallbackReason: string | null = null;
  private branchDiscoveryAttempted = false;
  private guestCartApiUnsupported = false;
  private serverCartSynced = false;
  private selectedSlot: DeliverySlot | null = null;
  private readonly knownProducts = new Map<string, CatalogProduct>();
  private readonly trackedCart = new Map<string, TrackedCartEntry>();

  constructor(private readonly options: SelfPointClientOptions) {
    this.storeId = options.storeId;
    this.meta = {
      ...STORE_META[options.storeId],
      ...(options.defaultDeliveryFee !== undefined
        ? { defaultDeliveryFee: options.defaultDeliveryFee }
        : {}),
    };
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.retailerId = options.retailerId;
    this.branchId = options.branchId;
    this.fetchFn = options.fetchFn ?? fetch;
    this.deliveryFee =
      options.defaultDeliveryFee ?? STORE_META[options.storeId].defaultDeliveryFee;
    this.tryLoadSavedSession();
  }

  getAuthWarning(): string | null {
    return this.authFallbackReason;
  }

  isAuthenticated(): boolean {
    if (!this.token) {
      this.tryLoadSavedSession();
    }
    return Boolean(this.token && !this.isGuestSession);
  }

  private apiBase(): string {
    return `${this.baseUrl}/v2/retailers/${this.retailerId}/branches/${this.branchId}`;
  }

  private apiHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': DEFAULT_USER_AGENT,
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/`,
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  private tryLoadSavedSession(): boolean {
    if (!fs.existsSync(this.options.sessionFilePath)) return false;
    try {
      const raw = fs.readFileSync(this.options.sessionFilePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedSelfPointSession;
      const configuredUser = this.options.username?.trim();
      if (
        configuredUser &&
        parsed.username &&
        parsed.username !== configuredUser
      ) {
        logger.info(
          `${this.storeId} username changed in .env; ignoring cached session`,
        );
        return false;
      }
      if (parsed.token) {
        this.token = parsed.token;
        this.userId = parsed.userId ? String(parsed.userId) : null;
        this.cartId = parsed.cartId ?? null;
        if (parsed.branchId && parsed.branchId > 0) {
          this.branchId = parsed.branchId;
        }
        this.isGuestSession = false;
        return true;
      }
      return false;
    } catch (err) {
      logger.warn(`Failed reading saved ${this.storeId} session`, err);
      return false;
    }
  }

  private saveSession(cookies?: unknown[]): void {
    try {
      const payload: PersistedSelfPointSession = {
        savedAt: new Date().toISOString(),
        username: this.options.username?.trim(),
        token: this.token ?? undefined,
        userId: this.userId ?? undefined,
        cartId: this.cartId ?? undefined,
        branchId: this.branchId,
        cookies,
      };
      fs.writeFileSync(
        this.options.sessionFilePath,
        JSON.stringify(payload, null, 2),
        'utf8',
      );
    } catch (err) {
      logger.warn(`Failed saving ${this.storeId} session`, err);
    }
  }

  private async ensureBrowserLogin(): Promise<void> {
    if (!this.options.username || !this.options.password) return;
    if (
      this.page &&
      !this.page.isClosed() &&
      this.token &&
      !this.isGuestSession
    ) {
      return;
    }

    if (this.tryLoadSavedSession() && this.token) {
      return;
    }

    if (!this.options.chromePath && !this.options.browserWsEndpoint) {
      logger.warn(
        `Chromium not configured for ${this.storeId} browser login; continuing in public API mode`,
      );
      return;
    }

    logger.info(
      `Logging in to ${this.meta.displayName} (Self-Point retailer=${this.retailerId}) via Chromium...`,
    );
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

    this.context = await this.browser.createBrowserContext();
    this.page = await this.context.newPage();
    await this.page.setViewport({ width: 1366, height: 900 });

    await this.page.goto(`${this.baseUrl}/?loginOrRegister=1`, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT,
    });

    const gateDetected = await this.page.evaluate(() => {
      const html = document.documentElement?.innerHTML?.toLowerCase() ?? '';
      const title = document.title?.toLowerCase() ?? '';
      return (
        title.includes('just a moment') ||
        html.includes('cf-turnstile') ||
        html.includes('g-recaptcha') ||
        html.includes('hcaptcha') ||
        html.includes('perfdrive.com')
      );
    });

    if (gateDetected) {
      throw new StoreManualVerificationRequiredError(
        this.storeId,
        'SECURITY_GATE',
        `אתר ${this.meta.shortName} מציג בדיקת אבטחה/CAPTCHA. המערכת אינה עוקפת בדיקות אבטחה אוטומטית – התחברו ידנית באתר ${this.meta.shortName}.`,
      );
    }

    await this.page
      .waitForSelector('input[type="password"], #email', { timeout: 12_000 })
      .catch(() => null);

    const hasPasswordInput = await this.page.evaluate(
      () => document.querySelector('input[type="password"]') !== null,
    );

    if (!hasPasswordInput) {
      throw new StoreManualVerificationRequiredError(
        this.storeId,
        'OTP',
        `${this.meta.shortName} מבקש התחברות באמצעות קוד SMS (OTP) ולא סיסמה. ניתן להתחבר ידנית באתר ${this.meta.shortName} או להשתמש בהשוואת מחירים אוטומטית.`,
      );
    }

    await this.page.evaluate(
      (email: string, password: string) => {
        const emailInput =
          (document.getElementById('email') as HTMLInputElement | null) ??
          (document.querySelector(
            'input[type="email"], input[name="email"], input[ng-model*="email"]',
          ) as HTMLInputElement | null);
        const pwdInput = document.querySelector(
          'input[type="password"]',
        ) as HTMLInputElement | null;

        if (emailInput) {
          emailInput.value = email;
          emailInput.dispatchEvent(new Event('input', { bubbles: true }));
          emailInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (pwdInput) {
          pwdInput.value = password;
          pwdInput.dispatchEvent(new Event('input', { bubbles: true }));
          pwdInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const submitBtn = document.querySelector(
          'form button[type="submit"], button[type="submit"]',
        ) as HTMLButtonElement | null;
        submitBtn?.click();
      },
      this.options.username,
      this.options.password,
    );

    await new Promise((r) => setTimeout(r, 4500));

    // Dismiss any post-login notification/preferences popup (e.g. "אישור")
    await this.page
      .evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const okBtn = btns.find((b) => (b.textContent ?? '').trim() === 'אישור');
        okBtn?.click();
      })
      .catch(() => {});

    const authResult = await this.page.evaluate(() => {
      try {
        const angularObj = (
          window as unknown as {
            angular?: {
              element: (el: Element) => {
                injector: () => { get: (name: string) => Record<string, unknown> };
              };
            };
          }
        ).angular;
        if (!angularObj) return null;
        const injector = angularObj.element(document.body).injector();
        const User = injector.get('User') as {
          session?: {
            token?: string;
            userId?: string | number;
            branchId?: number;
            cartId?: string;
          };
          isVerified?: () => boolean;
        };
        const Cart = injector.get('Cart') as {
          serverCartId?: string;
          id?: string;
        };
        let activeBranchId: number | null = null;
        try {
          const Branch = injector.get('Branch') as {
            current?: { id?: number };
          };
          if (Branch?.current?.id) activeBranchId = Number(Branch.current.id);
        } catch {
          // Branch service optional
        }
        return {
          token: User?.session?.token ?? null,
          userId: User?.session?.userId ?? null,
          verified:
            typeof User?.isVerified === 'function' ? User.isVerified() : false,
          cartId:
            Cart?.serverCartId ?? Cart?.id ?? User?.session?.cartId ?? null,
          branchId: activeBranchId ?? User?.session?.branchId ?? null,
        };
      } catch {
        return null;
      }
    });

    if (!authResult?.token) {
      throw new StoreAuthError(
        this.storeId,
        `התחברות ל-${this.meta.shortName} נכשלה – בדקו את ${this.options.envPrefix}_USERNAME ו-${this.options.envPrefix}_PASSWORD`,
      );
    }

    this.token = authResult.token;
    this.userId = authResult.userId ? String(authResult.userId) : null;
    if (authResult.branchId && authResult.branchId > 0) {
      this.branchId = Number(authResult.branchId);
    }
    if (authResult.cartId) {
      this.cartId = String(authResult.cartId);
    }
    this.isGuestSession = false;

    if (!this.cartId && this.userId) {
      await this.discoverAuthenticatedCartId().catch(() => {});
    }

    const cookies = await this.context.cookies().catch(() => []);
    this.saveSession(cookies);
    logger.info(
      `Authenticated to ${this.meta.displayName} successfully (branch=${this.branchId}, cartId=${this.cartId ?? 'pending'})`,
    );
  }

  private async ensureReady(): Promise<void> {
    if (
      this.options.username &&
      this.options.password &&
      !this.token &&
      !this.browserLoginAttempted
    ) {
      this.browserLoginAttempted = true;
      try {
        await this.ensureBrowserLogin();
        this.authFallbackReason = null;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn(
          `${this.storeId} browser login failed (${reason}); continuing in public API guest mode for live price comparison`,
        );
        this.authFallbackReason = reason;
        this.isGuestSession = true;
        await this.shutdown().catch(() => {});
      }
    } else if (!this.token) {
      this.tryLoadSavedSession();
    }
  }

  private async httpJson<T = Record<string, unknown>>(
    url: string,
    init?: RequestInit,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        ...init,
        signal: init?.signal ?? controller.signal,
        headers: {
          ...this.apiHeaders(),
          ...(init?.headers as Record<string, string> | undefined),
        },
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(
          `${this.meta.shortName} לא הגיב תוך ${HTTP_TIMEOUT_MS / 1000} שניות`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401 && this.token) {
        logger.info(
          `${this.storeId} bearer token expired (HTTP 401); clearing cached session`,
        );
        this.token = null;
        this.isGuestSession = true;
        try {
          if (fs.existsSync(this.options.sessionFilePath)) {
            fs.unlinkSync(this.options.sessionFilePath);
          }
        } catch {
          // ignore
        }
      }
      const lower = text.toLowerCase();
      if (
        res.status === 403 &&
        (lower.includes('radware') ||
          lower.includes('unauthorized request blocked') ||
          lower.includes('cloudflare') ||
          lower.includes('just a moment') ||
          lower.includes('captcha'))
      ) {
        throw new StoreManualVerificationRequiredError(
          this.storeId,
          'SECURITY_GATE',
          `אתר ${this.meta.shortName} חסם את הבקשה עם הגנת WAF/CAPTCHA. המערכת אינה עוקפת חסימות אבטחה.`,
        );
      }
      throw new Error(
        `${this.meta.shortName} HTTP ${res.status}: ${text.slice(0, 180)}`,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return {} as T;
    }
  }

  private parseRawProductList(
    data: Record<string, unknown>,
    limit: number,
  ): CatalogProduct[] {
    const rawProducts = Array.isArray(data['products'])
      ? (data['products'] as Array<Record<string, unknown>>)
      : Array.isArray(data['data'])
        ? (data['data'] as Array<Record<string, unknown>>)
        : Array.isArray(data['items'])
          ? (data['items'] as Array<Record<string, unknown>>)
          : Array.isArray(data)
            ? (data as unknown as Array<Record<string, unknown>>)
            : [];

    const parsed: CatalogProduct[] = [];
    for (const raw of rawProducts) {
      const prod = parseSelfPointProduct(raw, this.storeId);
      if (prod) {
        this.knownProducts.set(prod.code, prod);
        parsed.push(prod);
      }
      if (parsed.length >= limit) break;
    }
    return parsed;
  }

  /**
   * If a retailer's default branchId returns 0 products (e.g. retired/changed branch),
   * auto-discover an active online fulfillment branch from /v2/retailers/{id}/branches.
   */
  private async tryDiscoverActiveBranch(): Promise<boolean> {
    if (this.branchDiscoveryAttempted) return false;
    this.branchDiscoveryAttempted = true;

    const urls = [
      `${this.baseUrl}/v2/retailers/${this.retailerId}/branches?appId=${APP_ID}&languageId=${LANGUAGE_ID}`,
      `${this.baseUrl}/v2/retailers/${this.retailerId}/branches?appId=${APP_ID}&deliveryTypeId=1&languageId=${LANGUAGE_ID}`,
    ];

    for (const url of urls) {
      try {
        const data = await this.httpJson<Record<string, unknown>>(url, {
          method: 'GET',
        });
        const branches = Array.isArray(data['branches'])
          ? (data['branches'] as Array<Record<string, unknown>>)
          : Array.isArray(data['data'])
            ? (data['data'] as Array<Record<string, unknown>>)
            : Array.isArray(data)
              ? (data as unknown as Array<Record<string, unknown>>)
              : [];
        if (branches.length === 0) continue;

        const activeBranches = branches.filter(
          (b) =>
            b['isActive'] !== false &&
            Number(b['id'] ?? b['branchId'] ?? 0) > 0,
        );
        if (activeBranches.length === 0) continue;

        // If current branchId is already in activeBranches, pick another active delivery branch
        // only if the current one isn't listed at all.
        const currentIsListed = activeBranches.some(
          (b) => Number(b['id'] ?? b['branchId']) === this.branchId,
        );
        if (currentIsListed) {
          return false;
        }

        const deliveryBranch =
          activeBranches.find(
            (b) => b['isDelivery'] === true || b['hasDelivery'] === true,
          ) ?? activeBranches[0]!;
        const discoveredId = Number(
          deliveryBranch['id'] ?? deliveryBranch['branchId'],
        );
        if (discoveredId > 0 && discoveredId !== this.branchId) {
          logger.info(
            `Auto-discovered active ${this.storeId} branchId=${discoveredId} (previous ${this.branchId} not active)`,
          );
          this.branchId = discoveredId;
          return true;
        }
      } catch (err) {
        logger.debug(`${this.storeId} branch discovery probe failed`, err);
      }
    }
    return false;
  }

  private async runProductQuery(
    cleanQuery: string,
    limit: number,
    includeStandardFilters: boolean,
  ): Promise<CatalogProduct[]> {
    const qs = new URLSearchParams({
      appId: String(APP_ID),
      query: cleanQuery,
      size: String(Math.max(limit, 15)),
      from: '0',
      isSearch: 'true',
      languageId: String(LANGUAGE_ID),
    });
    if (includeStandardFilters) {
      qs.set('filters', STANDARD_SELFPOINT_FILTERS);
    }

    const data = await this.httpJson<Record<string, unknown>>(
      `${this.apiBase()}/products?${qs.toString()}`,
      { method: 'GET' },
    );
    return this.parseRawProductList(data, limit);
  }

  async searchProducts(query: string, limit = 15): Promise<CatalogProduct[]> {
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];
    await this.ensureReady();

    let results: CatalogProduct[] = [];
    try {
      results = await this.runProductQuery(cleanQuery, limit, true);
    } catch (err) {
      if (err instanceof StoreManualVerificationRequiredError) {
        throw err;
      }
      logger.warn(
        `${this.storeId} filtered search failed for "${cleanQuery}"; retrying without strict filters`,
        err,
      );
    }

    // Fallback 1: retry without strict Elasticsearch filters (some retailers omit family.categoriesPaths.id)
    if (results.length === 0) {
      try {
        results = await this.runProductQuery(cleanQuery, limit, false);
      } catch (err) {
        if (err instanceof StoreManualVerificationRequiredError) {
          throw err;
        }
        logger.warn(
          `${this.storeId} unfiltered search failed for "${cleanQuery}"`,
          err,
        );
      }
    }

    // Fallback 2: if still empty, verify/discover active branch once and retry
    if (results.length === 0 && !this.branchDiscoveryAttempted) {
      const switched = await this.tryDiscoverActiveBranch();
      if (switched) {
        try {
          results = await this.runProductQuery(cleanQuery, limit, true);
          if (results.length === 0) {
            results = await this.runProductQuery(cleanQuery, limit, false);
          }
        } catch (err) {
          if (err instanceof StoreManualVerificationRequiredError) {
            throw err;
          }
        }
      }
    }

    // Fallback 3: try autocomplete endpoint if /products still returned empty
    if (results.length === 0) {
      try {
        const autoQs = new URLSearchParams({
          appId: String(APP_ID),
          query: cleanQuery,
          size: String(Math.max(limit, 10)),
          languageId: String(LANGUAGE_ID),
        });
        const autoData = await this.httpJson<Record<string, unknown>>(
          `${this.apiBase()}/products/autocomplete?${autoQs.toString()}`,
          { method: 'GET' },
        );
        results = this.parseRawProductList(autoData, limit);
      } catch (err) {
        if (err instanceof StoreManualVerificationRequiredError) {
          throw err;
        }
      }
    }

    return results;
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
      storeId: this.storeId,
      items,
      totalPrice: Number(totalPrice.toFixed(2)),
      deliveryFee: this.selectedSlot?.deliveryFee ?? this.deliveryFee,
      orderInUpdateMode: null,
      isGuestSession: this.isGuestSession,
    };
  }

  private syncTrackedFromCartState(cart: CartState): void {
    this.trackedCart.clear();
    for (const item of cart.items) {
      const known = this.knownProducts.get(item.productCode);
      const unitPrice =
        item.quantity > 0
          ? Number((item.itemPrice / item.quantity).toFixed(2))
          : known?.price ?? 0;
      this.trackedCart.set(item.productCode, {
        productCode: item.productCode,
        productName:
          item.productName ?? known?.name ?? `מוצר (${item.productCode})`,
        quantity: item.quantity,
        unitPrice,
        sellingMethod: item.sellingMethod ?? known?.sellingMethod ?? 'BY_UNIT',
        inStock: item.inStock,
      });
    }
  }

  private mergeServerPricesIntoTracked(cart: CartState): void {
    for (const item of cart.items) {
      const existing = this.trackedCart.get(item.productCode);
      if (!existing) continue;
      const unitPrice =
        item.quantity > 0 && item.itemPrice > 0
          ? Number((item.itemPrice / item.quantity).toFixed(2))
          : existing.unitPrice;
      this.trackedCart.set(item.productCode, {
        ...existing,
        productName: item.productName ?? existing.productName,
        unitPrice,
        inStock: item.inStock,
      });
    }
  }

  private async syncCartToServer(): Promise<CartState> {
    const lines = [...this.trackedCart.values()]
      .filter((e) => e.quantity > 0)
      .map((e) => ({
        retailerProductId: Number(e.productCode),
        quantity: e.quantity,
        type: 1,
      }))
      .filter(
        (l) => Number.isFinite(l.retailerProductId) && l.retailerProductId > 0,
      );

    if (this.page && !this.page.isClosed() && !this.isGuestSession) {
      try {
        const angularCart = await this.page.evaluate(
          async (
            desiredLines: Array<{ retailerProductId: number; quantity: number }>,
          ) => {
            const angularObj = (
              window as unknown as {
                angular?: {
                  element: (el: Element) => {
                    injector: () => { get: (name: string) => Record<string, unknown> };
                  };
                };
              }
            ).angular;
            if (!angularObj) return null;
            const Cart = angularObj.element(document.body).injector().get('Cart') as {
              lines?: Record<string, unknown>;
              total?: Record<string, unknown>;
              serverCartId?: string;
              addLine?: (arg: {
                product: { id: number };
                quantity: number;
                isCase: boolean;
              }) => void;
              removeLine?: (id: number) => void;
            };
            const desiredMap = new Map(
              desiredLines.map((l) => [String(l.retailerProductId), l.quantity]),
            );
            for (const existingId of Object.keys(Cart.lines ?? {})) {
              if (!desiredMap.has(existingId)) {
                Cart.removeLine?.(Number(existingId));
              }
            }
            for (const l of desiredLines) {
              Cart.addLine?.({
                product: { id: l.retailerProductId },
                quantity: l.quantity,
                isCase: false,
              });
            }
            // Self-Point Angular Cart auto-saves asynchronously to POST /v2/.../carts/{cartId}
            await new Promise((r) => setTimeout(r, 3500));
            return {
              serverCartId: Cart.serverCartId ?? null,
              lines: Cart.lines ?? {},
              total: Cart.total ?? {},
            };
          },
          lines,
        );

        if (angularCart) {
          if (angularCart.serverCartId) {
            this.cartId = angularCart.serverCartId;
            this.saveSession();
          }
          const parsed = parseSelfPointCart(
            angularCart as unknown as Record<string, unknown>,
            this.selectedSlot?.deliveryFee ?? this.deliveryFee,
            false,
            this.storeId,
          );
          if (parsed.items.length > 0 && this.cartId) {
            this.serverCartSynced = true;
          }
          if (lines.length === 0 || parsed.items.length >= lines.length) {
            this.syncTrackedFromCartState(parsed);
            return parsed;
          }
          if (parsed.items.length > 0) {
            this.mergeServerPricesIntoTracked(parsed);
          }
        }
      } catch (err) {
        logger.warn(
          `${this.storeId} Angular Cart sync failed; falling back to REST API`,
          err,
        );
      }
    }

    if (this.isGuestSession && !this.token && this.guestCartApiUnsupported) {
      return this.buildTrackedCartState();
    }

    if (!this.isGuestSession && this.token && !this.cartId && this.userId) {
      await this.discoverAuthenticatedCartId().catch(() => {});
    }

    const targetUrl = this.cartId
      ? `${this.apiBase()}/carts/${encodeURIComponent(this.cartId)}?appId=${APP_ID}&languageId=${LANGUAGE_ID}`
      : `${this.apiBase()}/carts?appId=${APP_ID}&languageId=${LANGUAGE_ID}`;

    try {
      const resp = await this.httpJson<Record<string, unknown>>(targetUrl, {
        method: 'POST',
        body: JSON.stringify({ lines }),
      });

      const cartObj = (resp['cart'] ?? resp) as Record<string, unknown>;
      const returnedCartId = cartObj['id'] ?? cartObj['cartId'] ?? resp['id'];
      if (returnedCartId) {
        this.cartId = String(returnedCartId);
        if (!this.isGuestSession) {
          this.saveSession();
        }
      }

      const parsed = parseSelfPointCart(
        cartObj,
        this.selectedSlot?.deliveryFee ?? this.deliveryFee,
        this.isGuestSession,
        this.storeId,
      );
      if (!this.isGuestSession && (parsed.items.length > 0 || lines.length === 0)) {
        this.serverCartSynced = true;
      }
      if (lines.length === 0 || parsed.items.length >= lines.length) {
        this.syncTrackedFromCartState(parsed);
        return parsed;
      }
      if (parsed.items.length > 0) {
        this.mergeServerPricesIntoTracked(parsed);
      }
    } catch (err) {
      if (err instanceof StoreManualVerificationRequiredError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (
        this.isGuestSession &&
        !this.token &&
        (msg.includes('HTTP 401') ||
          msg.includes('HTTP 403') ||
          msg.includes('HTTP 404') ||
          msg.includes('HTTP 405') ||
          msg.includes('ST10'))
      ) {
        this.guestCartApiUnsupported = true;
        logger.debug(
          `${this.storeId} guest REST cart creation unavailable (${msg}); tracking live cart locally`,
        );
      } else {
        this.serverCartSynced = false;
        logger.warn(`${this.storeId} REST cart sync fallback used`, err);
      }
    }

    return this.buildTrackedCartState();
  }

  private async discoverAuthenticatedCartId(): Promise<void> {
    if (!this.token || !this.userId) return;
    const urls = [
      `${this.baseUrl}/v2/retailers/${this.retailerId}/users/${encodeURIComponent(this.userId)}/carts?appId=${APP_ID}&languageId=${LANGUAGE_ID}`,
      `${this.apiBase()}/carts?appId=${APP_ID}&languageId=${LANGUAGE_ID}`,
    ];
    for (const url of urls) {
      try {
        const resp = await this.httpJson<Record<string, unknown>>(url, {
          method: 'GET',
        });
        const list = Array.isArray(resp['carts'])
          ? (resp['carts'] as Array<Record<string, unknown>>)
          : Array.isArray(resp)
            ? (resp as unknown as Array<Record<string, unknown>>)
            : [resp];
        const first = list[0];
        const id = first?.['id'] ?? first?.['cartId'] ?? first?.['serverCartId'];
        if (id) {
          this.cartId = String(id);
          this.saveSession();
          logger.info(`Discovered ${this.storeId} server cartId=${this.cartId}`);
          return;
        }
      } catch {
        // try next URL
      }
    }
  }

  private async tryCreateShopList(cart: CartState): Promise<string | null> {
    if (this.isGuestSession || !this.token || !this.userId) return null;
    const products = cart.items
      .filter((i) => i.inStock && i.quantity > 0)
      .map((i) => ({
        productId: Number(i.productCode),
        quantity: i.quantity,
        isCase: false,
      }))
      .filter((p) => Number.isFinite(p.productId) && p.productId > 0);
    if (products.length === 0) return null;

    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();
    const listName = `בוט קניות ${dd}-${mm}-${yyyy}`;

    try {
      await this.httpJson(
        `${this.baseUrl}/retailers/${this.retailerId}/users/${encodeURIComponent(this.userId)}/shopLists?appId=${APP_ID}`,
        {
          method: 'POST',
          body: JSON.stringify({ name: listName, products }),
        },
      );
      logger.info(
        `Saved ${products.length} items to ${this.storeId} shopping list "${listName}"`,
      );
      return listName;
    } catch (err) {
      logger.warn(`Failed creating ${this.storeId} shopping list fallback`, err);
      return null;
    }
  }

  async getCartState(): Promise<CartState> {
    await this.ensureReady();

    if (this.cartId && !this.guestCartApiUnsupported) {
      try {
        const resp = await this.httpJson<Record<string, unknown>>(
          `${this.apiBase()}/carts/${encodeURIComponent(this.cartId)}?appId=${APP_ID}&languageId=${LANGUAGE_ID}`,
          { method: 'GET' },
        );
        const cartObj = (resp['cart'] ?? resp) as Record<string, unknown>;
        const parsed = parseSelfPointCart(
          cartObj,
          this.selectedSlot?.deliveryFee ?? this.deliveryFee,
          this.isGuestSession,
          this.storeId,
        );
        // Never allow a partial/stale server cart to wipe locally tracked items
        if (
          this.trackedCart.size === 0 ||
          parsed.items.length >= this.trackedCart.size
        ) {
          this.syncTrackedFromCartState(parsed);
          return parsed;
        }
        if (parsed.items.length > 0) {
          this.mergeServerPricesIntoTracked(parsed);
        }
      } catch {
        // fall through to tracked state
      }
    }

    return this.buildTrackedCartState();
  }

  async setItemsInCart(items: AddCartItemInput[]): Promise<CartState> {
    await this.ensureReady();

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

    return this.syncCartToServer();
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
    await this.ensureReady();
    this.trackedCart.delete(productCode);
    return this.syncCartToServer();
  }

  async clearCart(): Promise<void> {
    await this.ensureReady();
    this.trackedCart.clear();
    await this.syncCartToServer().catch(() => {});
  }

  async getAvailableTimeSlots(): Promise<DeliverySlot[]> {
    await this.ensureReady();
    try {
      const data = await this.httpJson<Record<string, unknown>>(
        `${this.apiBase()}/areas?appId=${APP_ID}&deliveryTypeId=1&languageId=${LANGUAGE_ID}`,
        { method: 'GET' },
      );
      const areas = Array.isArray(data['areas'])
        ? (data['areas'] as Array<Record<string, unknown>>)
        : Array.isArray(data)
          ? (data as unknown as Array<Record<string, unknown>>)
          : [];
      const selectedArea =
        (this.options.areaId
          ? areas.find((a) => Number(a['id']) === this.options.areaId)
          : areas[0]) ?? areas[0];
      const fee = Number(selectedArea?.['deliveryAreaPrice'] ?? NaN);
      if (Number.isFinite(fee) && fee >= 0) {
        this.deliveryFee = fee;
      }
    } catch {
      // Keep default delivery fee
    }
    return [];
  }

  async getSelectedTimeSlot(): Promise<DeliverySlot | null> {
    return this.selectedSlot;
  }

  async selectTimeSlot(slotCode: string): Promise<DeliverySlot> {
    const slots = await this.getAvailableTimeSlots();
    const match = slots.find((s) => s.code === slotCode);
    if (!match) {
      throw new Error(`חלון המשלוח (${slotCode}) לא נמצא ב-${this.meta.shortName}`);
    }
    this.selectedSlot = match;
    return match;
  }

  async getActiveOrders(): Promise<ActiveOrderSummary[]> {
    return [];
  }

  async putOrderInUpdateMode(_orderCode: string): Promise<CartState> {
    throw new Error(
      `עדכון הזמנה קיימת אינו נתמך אוטומטית ב-${this.meta.shortName}`,
    );
  }

  async placeOrder(_options: {
    removeMissingItems: boolean;
  }): Promise<CheckoutResult> {
    const cart = await this.getCartState();
    if (cart.items.length === 0) {
      throw new Error(`עגלת ${this.meta.shortName} ריקה – אין מה להזמין.`);
    }

    const total = formatCurrency(cart.totalPrice);
    const minAmount = this.meta.minimumOrderAmount;
    const minNote =
      minAmount && cart.totalPrice < minAmount
        ? `\n⚠️ שימו לב: מינימום הזמנה ב-${this.meta.shortName} הוא ${formatCurrency(minAmount)}.`
        : '';

    // If logged in, ensure cart is genuinely persisted to Self-Point server (or saved as a shopList)
    if (!this.isGuestSession) {
      if (!this.serverCartSynced) {
        await this.syncCartToServer().catch(() => {});
      }
      if (this.serverCartSynced) {
        throw new StoreManualVerificationRequiredError(
          this.storeId,
          'MANUAL_CHECKOUT',
          `✅ העגלה שלכם ב-${this.meta.shortName} סונכרנה לחשבון שלכם באתר עם ${cart.items.length} פריטים בסך ${total}!${minNote}\nלהשלמת בחירת חלון המשלוח והתשלום המאובטח לחצו על הקישור הישיר לעגלה:`,
          this.meta.cartUrl,
        );
      }
      const listName = await this.tryCreateShopList(cart);
      if (listName) {
        throw new StoreManualVerificationRequiredError(
          this.storeId,
          'MANUAL_CHECKOUT',
          `✅ נשמרה רשימת קניות "${listName}" עם ${cart.items.length} פריטים (${total}) בחשבון שלכם ב-${this.meta.shortName}!${minNote}\nהיכנסו ל"הרשימות שלי" באתר והוסיפו לסל בלחיצה:`,
          this.meta.baseUrl,
        );
      }
    }

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
    const authHint = this.isGuestSession
      ? `הבוט רץ כרגע במצב אורח ב-${this.meta.shortName}, ולכן העגלה באתר עצמו נפתחת ריקה.\nלהתחברות מהירה באמצעות SMS (ללא סיסמה) כך שהבוט ימלא אוטומטית את העגלה האמיתית שלכם, שלחו: /login_haviv 05XXXXXXXX`
      : `לא ניתן היה לסנכרן את העגלה ישירות לחשבון ${this.meta.shortName} (${this.authFallbackReason ?? 'נדרשת התחברות באתר'}).`;

    throw new StoreManualVerificationRequiredError(
      this.storeId,
      'MANUAL_CHECKOUT',
      `📋 סיכום סל ${this.meta.shortName}: ${cart.items.length} פריטים בסך ${total}.${minNote}\n\nℹ️ ${authHint}\n\nרשימת הפריטים להזמנה:\n${checklist}${moreNote}`,
      this.meta.baseUrl,
    );
  }

  private async ensureOtpBrowserPage(): Promise<Page> {
    if (!this.options.chromePath && !this.options.browserWsEndpoint) {
      throw new Error(
        `Chromium אינו מוגדר בשרת – לא ניתן להריץ התחברות SMS עבור ${this.meta.shortName}.`,
      );
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
    if (this.context) {
      await this.context.close().catch(() => {});
    }
    this.context = await this.browser.createBrowserContext();
    this.page = await this.context.newPage();
    await this.page.setUserAgent(DEFAULT_USER_AGENT);
    await this.page.setViewport({ width: 1366, height: 900 });
    return this.page;
  }

  private async captureLoginDiagnosticScreenshot(tag: string): Promise<void> {
    if (!this.page || this.page.isClosed()) return;
    try {
      fs.mkdirSync(this.options.screenshotsDir, { recursive: true });
      const file = path.join(
        this.options.screenshotsDir,
        `${this.storeId}-${tag}-${Date.now()}.png`,
      );
      await this.page.screenshot({ path: file });
      logger.info(`Saved ${this.storeId} diagnostic screenshot: ${file}`);
    } catch {
      // ignore screenshot errors
    }
  }

  private async logDomDiagnostics(tag: string): Promise<void> {
    if (!this.page || this.page.isClosed()) return;
    try {
      const diag = await this.page.evaluate(() => {
        const isVis = (el: Element): boolean => {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const s = window.getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
        };
        const inputs = Array.from(document.querySelectorAll('input'))
          .filter((i) => isVis(i))
          .slice(0, 12)
          .map((i) => ({
            type: i.type,
            name: i.name || undefined,
            id: i.id || undefined,
            placeholder: i.placeholder || undefined,
            ngModel: i.getAttribute('ng-model') || undefined,
            ariaLabel: i.getAttribute('aria-label') || undefined,
            maxLength: i.maxLength > 0 && i.maxLength < 100 ? i.maxLength : undefined,
            w: Math.round(i.getBoundingClientRect().width),
          }));
        const loginLike = Array.from(
          document.querySelectorAll('button, a, [role="button"], [ng-click]'),
        )
          .filter((el) => {
            const t = (el.textContent ?? '').trim();
            const ng = el.getAttribute('ng-click') ?? '';
            return (
              /כניס|התחבר|תפריט|שלח|אמת|קוד|אישור|המשך/.test(t) ||
              /login|verif|auth|menu|otp|send/i.test(ng)
            );
          })
          .slice(0, 15)
          .map((el) => ({
            tag: el.tagName,
            text: (el.textContent ?? '').trim().slice(0, 35),
            ngClick: el.getAttribute('ng-click')?.slice(0, 50) || undefined,
            vis: isVis(el),
          }));
        const hasAngular = Boolean(
          (window as unknown as { angular?: unknown }).angular,
        );
        return {
          url: window.location.href,
          title: document.title,
          hasAngular,
          visibleInputs: inputs,
          loginLike,
        };
      });
      logger.info(`${this.storeId} DOM diagnostics (${tag}): ${JSON.stringify(diag)}`);
    } catch {
      // ignore diagnostic errors
    }
  }

  async startSmsOtpLogin(phoneNumber: string): Promise<{ message: string }> {
    const cleanPhone = normalizeIsraeliPhone(phoneNumber);
    if (!cleanPhone) {
      throw new Error(
        'מספר הטלפון אינו תקין. אנא הזינו מספר ישראלי בן 10 ספרות המתחיל ב-05 (למשל 0501234567).',
      );
    }

    const page = await this.ensureOtpBrowserPage();
    logger.info(`Starting SMS OTP login flow for ${this.meta.displayName}...`);

    await page.goto(`${this.baseUrl}/`, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT,
    });

    // Wait for Prutah AngularJS SPA to bootstrap
    await page
      .waitForFunction(
        () => {
          const ang = (window as unknown as { angular?: { element: (el: Element) => { injector?: () => unknown } } }).angular;
          return Boolean(ang && ang.element(document.body)?.injector?.());
        },
        { timeout: 12_000 },
      )
      .catch(() => null);
    await new Promise((r) => setTimeout(r, 1500));

    const gateDetected = await page.evaluate(() => {
      const html = document.documentElement?.innerHTML?.toLowerCase() ?? '';
      const title = document.title?.toLowerCase() ?? '';
      return (
        title.includes('just a moment') ||
        html.includes('cf-turnstile') ||
        html.includes('g-recaptcha') ||
        html.includes('hcaptcha') ||
        html.includes('perfdrive.com')
      );
    });
    if (gateDetected) {
      throw new StoreManualVerificationRequiredError(
        this.storeId,
        'SECURITY_GATE',
        `אתר ${this.meta.shortName} מציג בדיקת אבטחה/CAPTCHA. המערכת אינה עוקפת בדיקות אבטחה.`,
      );
    }

    // Helper: check if a visible login/phone input is already on screen
    const hasVisiblePhoneInput = async (): Promise<boolean> =>
      page.evaluate(() => {
        const isVis = (el: Element): boolean => {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const s = window.getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
        };
        const isSearch = (i: HTMLInputElement): boolean => {
          const p = (i.placeholder ?? '').toLowerCase();
          const n = (i.name ?? '').toLowerCase();
          const ng = (i.getAttribute('ng-model') ?? '').toLowerCase();
          return (
            i.type === 'search' ||
            p.includes('חיפוש') ||
            p.includes('חפש') ||
            p.includes('search') ||
            n.includes('search') ||
            ng.includes('search') ||
            ng.includes('query')
          );
        };
        const modal = Array.from(
          document.querySelectorAll(
            '.modal, [role="dialog"], [aria-modal="true"], [ng-controller*="Verification" i], [ng-controller*="Login" i], [class*="modal" i], [class*="popup" i], [class*="dialog" i]',
          ),
        ).find((m) => isVis(m) && m.getBoundingClientRect().width > 180);

        const scope: ParentNode = modal ?? document;
        const inputs = Array.from(scope.querySelectorAll('input')).filter(
          (i) =>
            isVis(i) &&
            !i.disabled &&
            !['hidden', 'checkbox', 'radio', 'submit', 'button', 'file', 'password'].includes(i.type) &&
            !isSearch(i),
        );
        if (modal && inputs.length > 0) return true;
        return inputs.some((i) => {
          const sig = `${i.type} ${i.name} ${i.id} ${i.placeholder} ${i.getAttribute('ng-model') ?? ''} ${i.getAttribute('aria-label') ?? ''}`.toLowerCase();
          return /phone|mobile|cell|tel|טלפון|נייד|פלאפון|סלולר|05/.test(sig);
        });
      });

    // Try opening the verification/login modal across multiple Prutah UI variants
    if (!(await hasVisiblePhoneInput())) {
      // Strategy A: Click visible direct login button ("כניסת משתמש" / "התחברות" / openVerification)
      const stepA = await page.evaluate(() => {
        const isVis = (el: Element): boolean => {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const s = window.getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
        };

        const directEls = Array.from(
          document.querySelectorAll(
            '.user-verification-btn, [ng-click*="openVerification" i], [ng-click*="openLogin" i], [ng-click*="login" i], .login-btn',
          ),
        ).filter((el) => isVis(el)) as HTMLElement[];
        if (directEls.length > 0) {
          directEls[0]!.click();
          return 'clicked_direct_visible';
        }

        // Deepest visible clickable matching Hebrew login label
        const clickables = Array.from(
          document.querySelectorAll('button, a, [role="button"], [ng-click], li, span'),
        ).filter((el) => {
          if (!isVis(el)) return false;
          const t = (el.textContent ?? '').trim();
          return (
            t.length > 0 &&
            t.length <= 28 &&
            (t === 'כניסת משתמש' ||
              t === 'התחברות' ||
              t === 'כניסה' ||
              t === 'להתחברות' ||
              t.includes('כניסת משתמש') ||
              t.includes('התחברות'))
          );
        }) as HTMLElement[];
        if (clickables.length > 0) {
          // Pick innermost (fewest children) to avoid clicking a wrapper container
          clickables.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
          clickables[0]!.click();
          return 'clicked_text_visible';
        }
        return 'not_visible';
      });

      if (stepA !== 'not_visible') {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    // Strategy B: On Super Haviv Prutah skin, "כניסת משתמש" lives inside the "תפריט" side menu!
    if (!(await hasVisiblePhoneInput())) {
      const openedMenu = await page.evaluate(() => {
        const isVis = (el: Element): boolean => {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const s = window.getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
        };

        const menuBtn =
          (Array.from(
            document.querySelectorAll(
              'button, a, [role="button"], [ng-click], span, div',
            ),
          )
            .filter((el) => {
              if (!isVis(el)) return false;
              const t = (el.textContent ?? '').trim();
              const aria = (el.getAttribute('aria-label') ?? '').trim();
              const cls = (el.className?.toString() ?? '').toLowerCase();
              const ng = (el.getAttribute('ng-click') ?? '').toLowerCase();
              return (
                t === 'תפריט' ||
                t === 'תפריט צד' ||
                aria.includes('תפריט') ||
                cls.includes('hamburger') ||
                cls.includes('menu-btn') ||
                ng.includes('togglemenu') ||
                ng.includes('openmenu') ||
                ng.includes('sidenav')
              );
            })
            .sort(
              (a, b) =>
                a.querySelectorAll('*').length - b.querySelectorAll('*').length,
            )[0] as HTMLElement | undefined) ?? null;

        if (menuBtn) {
          menuBtn.click();
          return true;
        }
        return false;
      });

      if (openedMenu) {
        await new Promise((r) => setTimeout(r, 1200));
        await page.evaluate(() => {
          const isVis = (el: Element): boolean => {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
          };
          const loginEls = Array.from(
            document.querySelectorAll('button, a, [role="button"], [ng-click], li, span, div'),
          )
            .filter((el) => {
              if (!isVis(el)) return false;
              const t = (el.textContent ?? '').trim();
              return (
                t.length > 0 &&
                t.length <= 28 &&
                (t.includes('כניסת משתמש') ||
                  t.includes('התחברות') ||
                  t === 'כניסה')
              );
            })
            .sort(
              (a, b) =>
                a.querySelectorAll('*').length - b.querySelectorAll('*').length,
            ) as HTMLElement[];
          loginEls[0]?.click();
        });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    // Strategy C: Trigger hidden DOM login button directly via AngularJS click / triggerHandler, or navigate to ?loginOrRegister=1
    if (!(await hasVisiblePhoneInput())) {
      const triggeredHidden = await page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll(
            '.user-verification-btn, [ng-click*="openVerification" i], [ng-click*="openLogin" i], [ng-click*="login" i], button, a, li, span, div',
          ),
        );
        const match = candidates
          .filter((el) => {
            const t = (el.textContent ?? '').trim();
            const ng = el.getAttribute('ng-click') ?? '';
            return (
              /openVerification|openLogin|loginModal/i.test(ng) ||
              (t.length > 0 &&
                t.length <= 25 &&
                (t === 'כניסת משתמש' || t === 'התחברות'))
            );
          })
          .sort(
            (a, b) =>
              a.querySelectorAll('*').length - b.querySelectorAll('*').length,
          )[0] as HTMLElement | undefined;

        if (match) {
          match.click();
          try {
            const ang = (window as unknown as {
              angular?: {
                element: (el: Element) => {
                  triggerHandler: (ev: string) => void;
                  scope: () => { $apply?: () => void };
                };
              };
            }).angular;
            if (ang) {
              const aEl = ang.element(match);
              aEl.triggerHandler('click');
              aEl.scope()?.$apply?.();
            }
          } catch {
            // ignore
          }
          return true;
        }
        return false;
      });

      if (triggeredHidden) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    if (!(await hasVisiblePhoneInput())) {
      await page
        .goto(`${this.baseUrl}/?loginOrRegister=1`, {
          waitUntil: 'domcontentloaded',
          timeout: NAVIGATION_TIMEOUT,
        })
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
    }

    // If modal opened on email/password tab, switch to SMS/OTP tab if present
    await page.evaluate(() => {
      const isVis = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
      };
      const tabEls = Array.from(
        document.querySelectorAll('button, a, [role="tab"], [ng-click], span'),
      ).filter((el) => {
        if (!isVis(el)) return false;
        const t = (el.textContent ?? '').trim();
        return (
          t.length > 0 &&
          t.length <= 40 &&
          (t.includes('קוד חד פעמי') ||
            t.includes('הודעת SMS') ||
            t.includes('באמצעות SMS') ||
            t.includes('SMS') ||
            t.includes('טלפון נייד'))
        );
      }) as HTMLElement[];
      if (tabEls.length > 0) {
        tabEls.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
        tabEls[0]!.click();
      }
    });
    await new Promise((r) => setTimeout(r, 800));

    // Locate the visible phone input and tag it so we can type via Puppeteer + AngularJS
    const foundPhone = await page.evaluate(() => {
      const isVis = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
      };
      const isSearch = (i: HTMLInputElement): boolean => {
        const p = (i.placeholder ?? '').toLowerCase();
        const n = (i.name ?? '').toLowerCase();
        const ng = (i.getAttribute('ng-model') ?? '').toLowerCase();
        return (
          i.type === 'search' ||
          p.includes('חיפוש') ||
          p.includes('חפש') ||
          p.includes('search') ||
          n.includes('search') ||
          ng.includes('search') ||
          ng.includes('query')
        );
      };

      const modals = Array.from(
        document.querySelectorAll(
          '.modal, [role="dialog"], [aria-modal="true"], [ng-controller*="Verification" i], [ng-controller*="Login" i], [class*="modal" i], [class*="popup" i], [class*="dialog" i]',
        ),
      ).filter((m) => isVis(m) && m.getBoundingClientRect().width > 180);
      const modal = modals[modals.length - 1] ?? null;

      const collect = (root: ParentNode) =>
        Array.from(root.querySelectorAll('input')).filter(
          (i) =>
            isVis(i) &&
            !i.disabled &&
            !['hidden', 'checkbox', 'radio', 'submit', 'button', 'file', 'password'].includes(i.type) &&
            !isSearch(i),
        );

      const candidates = modal && collect(modal).length > 0 ? collect(modal) : collect(document);
      const scored = candidates
        .map((i) => {
          const sig = `${i.type} ${i.name} ${i.id} ${i.placeholder} ${i.getAttribute('ng-model') ?? ''} ${i.getAttribute('aria-label') ?? ''}`.toLowerCase();
          let score = 0;
          if (/phone|mobile|cell|טלפון|נייד|פלאפון|סלולר/.test(sig)) score += 10;
          if (i.type === 'tel' || i.inputMode === 'tel') score += 8;
          if (/05/.test(i.placeholder ?? '')) score += 6;
          if (modal && modal.contains(i)) score += 5;
          if (i.type === 'number' || i.inputMode === 'numeric') score += 3;
          return { i, score };
        })
        .filter((x) => x.score > 0 || (modal && modal.contains(x.i)))
        .sort((a, b) => b.score - a.score);

      const chosen = scored[0]?.i ?? null;
      if (!chosen) return false;
      chosen.setAttribute('data-bot-otp-phone', '1');
      chosen.scrollIntoView({ block: 'center' });
      chosen.focus();
      return true;
    });

    if (!foundPhone) {
      await this.logDomDiagnostics('otp-no-phone-input');
      await this.captureLoginDiagnosticScreenshot('otp-no-phone-input');
      throw new Error(
        `לא נמצא שדה הזנת מספר טלפון באתר ${this.meta.shortName}. נסו שוב בעוד רגע.`,
      );
    }

    // Type using real Puppeteer keyboard events first (works with masks/validators)
    const phoneEl = await page.$('input[data-bot-otp-phone="1"]');
    if (phoneEl) {
      await phoneEl.click({ count: 3 }).catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.keyboard.type(cleanPhone, { delay: 45 });
    }

    // Also sync AngularJS scope model & submit
    const submitted = await page.evaluate((phone: string) => {
      const inp = document.querySelector(
        'input[data-bot-otp-phone="1"]',
      ) as HTMLInputElement | null;
      if (!inp) return { ok: false, reason: 'no_phone_input' };
      inp.removeAttribute('data-bot-otp-phone');

      if (inp.value.replace(/\D/g, '') !== phone) {
        inp.value = phone;
      }
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));

      let angularCtrlSendCalled = false;
      try {
        const angularObj = (
          window as unknown as {
            angular?: {
              element: (el: Element) => {
                scope: () => Record<string, unknown>;
              };
            };
          }
        ).angular;
        if (angularObj) {
          const scope = angularObj.element(inp).scope() as Record<
            string,
            unknown
          >;
          const ngModel = inp.getAttribute('ng-model') ?? '';
          if (ngModel && scope) {
            const parts = ngModel.split('.');
            let target: Record<string, unknown> = scope;
            for (let i = 0; i < parts.length - 1; i++) {
              const p = parts[i]!;
              if (target[p] && typeof target[p] === 'object') {
                target = target[p] as Record<string, unknown>;
              }
            }
            const lastKey = parts[parts.length - 1];
            if (lastKey) {
              target[lastKey] = phone;
            }
            if (typeof scope['$apply'] === 'function') {
              (scope['$apply'] as () => void)();
            }
          }

          // Prutah userVerificationCtrl support
          const ctrl = scope?.['userVerificationCtrl'] as
            | { phoneNumber?: string; send?: (p: string) => void }
            | undefined;
          if (ctrl && typeof ctrl.send === 'function') {
            ctrl.phoneNumber = phone;
            if (typeof scope['$apply'] === 'function') {
              (scope['$apply'] as () => void)();
            }
            ctrl.send(phone);
            angularCtrlSendCalled = true;
          }
        }
      } catch {
        // DOM events already dispatched
      }

      if (angularCtrlSendCalled) {
        return { ok: true, reason: 'angular_ctrl_send' };
      }

      const isVis = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
      };

      const form =
        inp.closest('form') ??
        inp.closest('.modal, [role="dialog"], [class*="modal" i]') ??
        document;
      const buttons = Array.from(
        form.querySelectorAll('button, input[type="submit"], [ng-click]'),
      ).filter((b) => isVis(b) && !(b as HTMLButtonElement).disabled);

      const sendBtn =
        (buttons.find((b) => {
          const t = (b.textContent ?? '').trim();
          return (
            t.length > 0 &&
            t.length <= 30 &&
            (t.includes('שלח') ||
              t.includes('קבל קוד') ||
              t.includes('המשך') ||
              t.includes('כניסה') ||
              t.includes('התחבר') ||
              t.includes('אישור'))
          );
        }) as HTMLElement | undefined) ??
        (buttons.find(
          (b) =>
            (b as HTMLButtonElement).type === 'submit' ||
            /send|submit|login|next/i.test(b.getAttribute('ng-click') ?? ''),
        ) as HTMLElement | undefined);

      if (sendBtn) {
        sendBtn.click();
        return { ok: true, reason: 'clicked_send' };
      }
      return { ok: true, reason: 'enter_fallback' };
    }, cleanPhone);

    if (!submitted.ok) {
      await this.logDomDiagnostics('otp-submit-failed');
      await this.captureLoginDiagnosticScreenshot('otp-no-phone-input');
      throw new Error(
        `לא נמצא שדה הזנת מספר טלפון באתר ${this.meta.shortName}. נסו שוב בעוד רגע.`,
      );
    }

    if (submitted.reason === 'enter_fallback') {
      await page.keyboard.press('Enter').catch(() => {});
    }

    await new Promise((r) => setTimeout(r, 2500));

    return {
      message: `📱 נשלח קוד SMS מ-${this.meta.displayName} לטלפון שלך!\nשלחו כאן את הקוד שקיבלתם (למשל <code>123456</code> או <code>/otp 123456</code>).`,
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
        `סשן ההתחברות של ${this.meta.shortName} פג או נסגר. הריצו שוב /login_haviv עם מספר הטלפון.`,
      );
    }

    logger.info(`Submitting SMS OTP verification for ${this.meta.displayName}...`);

    // Locate visible OTP input(s) (multi-box or single input)
    const locateResult = await this.page.evaluate((codeLen: number) => {
      const isVis = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
      };
      const isSearch = (i: HTMLInputElement): boolean => {
        const p = (i.placeholder ?? '').toLowerCase();
        const ng = (i.getAttribute('ng-model') ?? '').toLowerCase();
        return i.type === 'search' || p.includes('חיפוש') || ng.includes('search');
      };

      const modals = Array.from(
        document.querySelectorAll(
          '.modal, [role="dialog"], [aria-modal="true"], [ng-controller*="Verification" i], [ng-controller*="Login" i], [class*="modal" i], [class*="popup" i], [class*="dialog" i]',
        ),
      ).filter((m) => isVis(m) && m.getBoundingClientRect().width > 180);
      const root: ParentNode = modals[modals.length - 1] ?? document;

      const visibleInputs = Array.from(root.querySelectorAll('input')).filter(
        (i) =>
          isVis(i) &&
          !i.disabled &&
          !['hidden', 'checkbox', 'radio', 'submit', 'button', 'file'].includes(i.type) &&
          !isSearch(i),
      );

      // Clean old markers
      for (const el of Array.from(document.querySelectorAll('[data-bot-otp-box]'))) {
        el.removeAttribute('data-bot-otp-box');
      }

      // 1. Multi-box OTP inputs (one digit per input)
      const digitBoxes = visibleInputs.filter((i) => {
        const w = i.getBoundingClientRect().width;
        const cls = (i.className ?? '').toLowerCase();
        const parentCls = (i.parentElement?.className ?? '').toLowerCase();
        return (
          i.maxLength === 1 ||
          w <= 90 ||
          cls.includes('otp') ||
          parentCls.includes('otp')
        );
      });
      if (digitBoxes.length >= codeLen && digitBoxes.length <= 8) {
        digitBoxes.slice(0, codeLen).forEach((b, idx) => {
          b.setAttribute('data-bot-otp-box', String(idx));
        });
        return { mode: 'multi' as const, count: codeLen };
      }

      // 2. Single OTP input
      const scored = visibleInputs
        .map((i) => {
          const sig = `${i.type} ${i.name} ${i.id} ${i.placeholder} ${i.autocomplete} ${i.getAttribute('ng-model') ?? ''} ${i.getAttribute('aria-label') ?? ''}`.toLowerCase();
          let score = 0;
          if (/otp|code|verify|sms|one-time|קוד|אימות|ספרות/.test(sig)) score += 10;
          if (i.inputMode === 'numeric' || i.type === 'tel' || i.type === 'number') score += 5;
          if (modals.length > 0) score += 4;
          return { i, score };
        })
        .sort((a, b) => b.score - a.score);

      const single = scored[0]?.i ?? null;
      if (!single) return { mode: 'none' as const, count: 0 };
      single.setAttribute('data-bot-otp-box', 'single');
      return { mode: 'single' as const, count: 1 };
    }, cleanCode.length);

    if (locateResult.mode === 'none') {
      await this.logDomDiagnostics('otp-no-code-input');
      await this.captureLoginDiagnosticScreenshot('otp-no-code-input');
      throw new Error(
        `לא נמצא שדה הזנת קוד SMS באתר ${this.meta.shortName}. נסו להתחיל שוב עם /login_haviv.`,
      );
    }

    if (locateResult.mode === 'multi') {
      const firstBox = await this.page.$('input[data-bot-otp-box="0"]');
      if (firstBox) {
        await firstBox.click().catch(() => {});
        await this.page.keyboard.type(cleanCode, { delay: 75 });
      }
      // Verify every box got its digit; fill individually if focus didn't auto-advance
      for (let i = 0; i < cleanCode.length; i++) {
        const ch = cleanCode[i]!;
        const box = await this.page.$(`input[data-bot-otp-box="${i}"]`);
        if (!box) continue;
        const currentVal = await box
          .evaluate((el) => (el as HTMLInputElement).value)
          .catch(() => '');
        if (currentVal !== ch) {
          await box.click({ count: 3 }).catch(() => {});
          await this.page.keyboard.type(ch, { delay: 40 });
          await box.evaluate((el, digit) => {
            const inp = el as HTMLInputElement;
            if (inp.value !== digit) inp.value = digit;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
          }, ch);
        }
      }
    } else {
      const singleEl = await this.page.$('input[data-bot-otp-box="single"]');
      if (singleEl) {
        await singleEl.click({ count: 3 }).catch(() => {});
        await this.page.keyboard.press('Backspace').catch(() => {});
        await this.page.keyboard.type(cleanCode, { delay: 50 });
        await singleEl.evaluate((el, code) => {
          const inp = el as HTMLInputElement;
          if (inp.value !== code) inp.value = code;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          try {
            const angularObj = (
              window as unknown as {
                angular?: {
                  element: (e: Element) => {
                    scope: () => Record<string, unknown>;
                  };
                };
              }
            ).angular;
            if (angularObj) {
              const scope = angularObj.element(inp).scope() as Record<
                string,
                unknown
              >;
              const ngModel = inp.getAttribute('ng-model') ?? '';
              if (ngModel && scope) {
                const parts = ngModel.split('.');
                let target: Record<string, unknown> = scope;
                for (let i = 0; i < parts.length - 1; i++) {
                  const p = parts[i]!;
                  if (target[p] && typeof target[p] === 'object') {
                    target = target[p] as Record<string, unknown>;
                  }
                }
                const lastKey = parts[parts.length - 1];
                if (lastKey) target[lastKey] = code;
                if (typeof scope['$apply'] === 'function') {
                  (scope['$apply'] as () => void)();
                }
              }
            }
          } catch {
            // ignore
          }
        }, cleanCode);
      }
    }

    await new Promise((r) => setTimeout(r, 600));

    // Click verify button if still visible (some modals auto-submit on last digit)
    const clickedVerify = await this.page.evaluate(() => {
      const isVis = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
      };
      const modals = Array.from(
        document.querySelectorAll(
          '.modal, [role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="popup" i], [class*="dialog" i]',
        ),
      ).filter((m) => isVis(m) && m.getBoundingClientRect().width > 180);
      const root: ParentNode = modals[modals.length - 1] ?? document;

      const btns = Array.from(
        root.querySelectorAll('button, input[type="submit"], [ng-click]'),
      ).filter((b) => isVis(b) && !(b as HTMLButtonElement).disabled);

      const verifyBtn =
        (btns.find((b) => {
          const aria = (b.getAttribute('aria-label') ?? '').trim();
          const cls = (b.className?.toString() ?? '').toLowerCase();
          const ng = (b.getAttribute('ng-click') ?? '').toLowerCase();
          return (
            cls.includes('verify-btn') ||
            ng.includes('verify') ||
            aria.includes('אמת')
          );
        }) as HTMLElement | undefined) ??
        (btns.find((b) => {
          const t = (b.textContent ?? '').trim();
          if (t.includes('שלח שוב') || t.includes('קוד חדש')) return false;
          return (
            t.length > 0 &&
            t.length <= 28 &&
            (t.includes('אמת') ||
              t.includes('אימות') ||
              t === 'כניסה' ||
              t === 'התחברות' ||
              t === 'אישור' ||
              t === 'המשך' ||
              t === 'שלח')
          );
        }) as HTMLElement | undefined) ??
        (btns.find((b) => (b as HTMLButtonElement).type === 'submit') as
          | HTMLElement
          | undefined);

      if (verifyBtn) {
        verifyBtn.click();
        return true;
      }
      return false;
    });

    if (!clickedVerify) {
      await this.page.keyboard.press('Enter').catch(() => {});
    }

    // Poll up to 7 seconds for AngularJS User.session.token to populate
    let authResult: {
      token: string | null;
      userId: string | number | null;
      verified: boolean;
      cartId: string | null;
      branchId: number | null;
    } | null = null;

    for (let attempt = 0; attempt < 14; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      // Dismiss any post-login popup
      await this.page
        .evaluate(() => {
          const okBtn = Array.from(document.querySelectorAll('button')).find(
            (b) => (b.textContent ?? '').trim() === 'אישור',
          );
          okBtn?.click();
        })
        .catch(() => {});

      authResult = await this.page.evaluate(() => {
        try {
          const angularObj = (
            window as unknown as {
              angular?: {
                element: (el: Element) => {
                  injector: () => { get: (name: string) => Record<string, unknown> };
                };
              };
            }
          ).angular;
          if (!angularObj) return null;
          const injector = angularObj.element(document.body).injector();
          const User = injector.get('User') as {
            session?: {
              token?: string;
              userId?: string | number;
              branchId?: number;
              cartId?: string;
            };
            isVerified?: () => boolean;
          };
          const Cart = injector.get('Cart') as {
            serverCartId?: string;
            id?: string;
          };
          let activeBranchId: number | null = null;
          try {
            const Branch = injector.get('Branch') as {
              current?: { id?: number };
            };
            if (Branch?.current?.id) activeBranchId = Number(Branch.current.id);
          } catch {
            // optional
          }
          return {
            token: User?.session?.token ?? null,
            userId: User?.session?.userId ?? null,
            verified:
              typeof User?.isVerified === 'function' ? User.isVerified() : false,
            cartId:
              Cart?.serverCartId ?? Cart?.id ?? User?.session?.cartId ?? null,
            branchId: activeBranchId ?? User?.session?.branchId ?? null,
          };
        } catch {
          return null;
        }
      });

      if (authResult?.token) break;
    }

    if (!authResult?.token) {
      await this.logDomDiagnostics('otp-verify-failed');
      await this.captureLoginDiagnosticScreenshot('otp-verify-failed');
      throw new Error(
        `אימות קוד ה-SMS ב-${this.meta.shortName} לא הושלם (ייתכן שהקוד שגוי או פג תוקפו). נסו שוב עם /login_haviv.`,
      );
    }

    this.token = authResult.token;
    this.userId = authResult.userId ? String(authResult.userId) : null;
    if (authResult.branchId && authResult.branchId > 0) {
      this.branchId = Number(authResult.branchId);
    }
    if (authResult.cartId) {
      this.cartId = String(authResult.cartId);
    }
    this.isGuestSession = false;
    this.authFallbackReason = null;
    this.guestCartApiUnsupported = false;

    if (!this.cartId && this.userId) {
      await this.discoverAuthenticatedCartId().catch(() => {});
    }

    const cookies = (await this.context?.cookies().catch(() => [])) ?? [];
    this.saveSession(cookies);
    logger.info(
      `SMS OTP login succeeded for ${this.meta.displayName} (branch=${this.branchId}, cartId=${this.cartId ?? 'pending'})`,
    );

    // If items were already mirrored/tracked in memory, sync them immediately to the real server cart!
    let syncNote = '';
    if (this.trackedCart.size > 0) {
      await this.syncCartToServer().catch(() => {});
      if (this.serverCartSynced) {
        syncNote = `\n🛒 סונכרנו ${this.trackedCart.size} פריטים מהעגלה הנוכחית ישירות לחשבון שלכם באתר!`;
      }
    }

    return {
      isAuthenticated: true,
      message: `✅ <b>התחברתם בהצלחה ל-${this.meta.displayName}!</b>\nהסשן נשמר אוטומטית – מעכשיו הבוט ימלא ישירות את העגלה האמיתית בחשבון שלכם.${syncNote}`,
    };
  }

  async shutdown(): Promise<void> {
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
