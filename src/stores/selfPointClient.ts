import fs from 'node:fs';
import puppeteer, {
  type Browser,
  type BrowserContext,
  type Page,
} from 'puppeteer-core';
import { logger } from '../logger.js';
import { formatCurrency } from '../utils/format.js';
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
          session?: { token?: string; userId?: string | number };
          isVerified?: () => boolean;
        };
        const Cart = injector.get('Cart') as {
          serverCartId?: string;
        };
        return {
          token: User?.session?.token ?? null,
          userId: User?.session?.userId ?? null,
          verified:
            typeof User?.isVerified === 'function' ? User.isVerified() : false,
          cartId: Cart?.serverCartId ?? null,
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
    if (authResult.cartId) {
      this.cartId = authResult.cartId;
    }
    this.isGuestSession = false;

    const cookies = await this.context.cookies().catch(() => []);
    this.saveSession(cookies);
    logger.info(`Authenticated to ${this.meta.displayName} successfully`);
  }

  private async ensureReady(): Promise<void> {
    if (this.options.username && this.options.password && !this.token) {
      await this.ensureBrowserLogin();
    } else if (!this.token) {
      this.tryLoadSavedSession();
    }
  }

  private async httpJson<T = Record<string, unknown>>(
    url: string,
    init?: RequestInit,
  ): Promise<T> {
    const res = await this.fetchFn(url, {
      ...init,
      headers: {
        ...this.apiHeaders(),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    const text = await res.text();
    if (!res.ok) {
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

  async searchProducts(query: string, limit = 15): Promise<CatalogProduct[]> {
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];
    await this.ensureReady();

    const qs = new URLSearchParams({
      appId: String(APP_ID),
      query: cleanQuery,
      size: String(Math.max(limit, 15)),
      from: '0',
      isSearch: 'true',
      languageId: String(LANGUAGE_ID),
      filters: STANDARD_SELFPOINT_FILTERS,
    });

    const data = await this.httpJson<Record<string, unknown>>(
      `${this.apiBase()}/products?${qs.toString()}`,
      { method: 'GET' },
    );

    const rawProducts = Array.isArray(data['products'])
      ? (data['products'] as Array<Record<string, unknown>>)
      : Array.isArray(data['data'])
        ? (data['data'] as Array<Record<string, unknown>>)
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
            await new Promise((r) => setTimeout(r, 1500));
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
          }
          const parsed = parseSelfPointCart(
            angularCart as unknown as Record<string, unknown>,
            this.selectedSlot?.deliveryFee ?? this.deliveryFee,
            false,
            this.storeId,
          );
          if (parsed.items.length > 0 || lines.length === 0) {
            this.syncTrackedFromCartState(parsed);
            return parsed;
          }
        }
      } catch (err) {
        logger.warn(
          `${this.storeId} Angular Cart sync failed; falling back to REST API`,
          err,
        );
      }
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
      }

      const parsed = parseSelfPointCart(
        cartObj,
        this.selectedSlot?.deliveryFee ?? this.deliveryFee,
        this.isGuestSession,
        this.storeId,
      );
      if (parsed.items.length > 0 || lines.length === 0) {
        this.syncTrackedFromCartState(parsed);
        return parsed;
      }
    } catch (err) {
      if (err instanceof StoreManualVerificationRequiredError) {
        throw err;
      }
      logger.warn(`${this.storeId} REST cart sync fallback used`, err);
    }

    return this.buildTrackedCartState();
  }

  async getCartState(): Promise<CartState> {
    await this.ensureReady();

    if (this.cartId) {
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
        if (parsed.items.length > 0 || this.trackedCart.size === 0) {
          this.syncTrackedFromCartState(parsed);
          return parsed;
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

    if (this.isGuestSession) {
      throw new StoreManualVerificationRequiredError(
        this.storeId,
        'MANUAL_CHECKOUT',
        `עגלת ${this.meta.shortName} חושבה בסך ${total} (במצב אורח – לא הוגדרו פרטי התחברות ${this.options.envPrefix}_USERNAME/PASSWORD).${minNote}\nהתחברו לאתר ${this.meta.shortName} להשלמת ההזמנה או הגדירו פרטי התחברות ב-.env.`,
        this.meta.cartUrl,
      );
    }

    throw new StoreManualVerificationRequiredError(
      this.storeId,
      'MANUAL_CHECKOUT',
      `העגלה שלכם ב-${this.meta.shortName} מוכנה עם ${cart.items.length} פריטים בסך ${total}!${minNote}\nלהשלמת בחירת חלון המשלוח והתשלום המאובטח לחצו על הקישור הישיר לעגלה:`,
      this.meta.cartUrl,
    );
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
