import crypto from 'node:crypto';
import fs from 'node:fs';
import { logger } from '../logger.js';
import { formatCurrency } from '../utils/format.js';
import {
  fetchTextWithTimeout,
  isTimeoutError,
  type TimedTextResponse,
} from '../utils/timeout.js';
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
} from './types.js';

export const HAZI_HINAM_BASE_URL = 'https://shop.hazi-hinam.co.il';
export const HAZI_HINAM_AUTH_URL = 'https://auth.hazi-hinam.co.il';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export const HAZI_HINAM_HTTP_TIMEOUT_MS = 15_000;

export interface HaziHinamClientOptions {
  username?: string;
  password?: string;
  sessionFilePath: string;
  baseUrl?: string;
  authBaseUrl?: string;
  defaultDeliveryFee?: number;
  fetchFn?: typeof fetch;
  httpTimeoutMs?: number;
}

interface PersistedHaziSession {
  savedAt: string;
  username?: string;
  accessToken?: string;
  expiresAt?: number;
  isGuest?: boolean;
  cookies?: Array<{ name: string; value: string; domain?: string }>;
}

interface TrackedCartEntry {
  productCode: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  sellingMethod: SellingMethodCode;
  inStock: boolean;
}

export function parseHaziHinamProduct(raw: Record<string, unknown>): CatalogProduct | null {
  const idRaw = raw['Id'] ?? raw['ItemId'] ?? raw['id'];
  if (idRaw === undefined || idRaw === null || String(idRaw).trim() === '') {
    return null;
  }
  const code = String(idRaw).trim();
  const name = String(raw['Name'] ?? raw['ItemName'] ?? '').trim();
  if (!name) return null;

  const priceNet = Number(raw['Price_NET'] ?? raw['SalePrice'] ?? 0);
  const priceRegular = Number(raw['Price_Regular'] ?? raw['Price'] ?? 0);
  const effectivePrice =
    priceNet > 0 && Number.isFinite(priceNet)
      ? priceNet
      : priceRegular > 0 && Number.isFinite(priceRegular)
        ? priceRegular
        : 0;

  const isWeight = Boolean(
    raw['IsWeight'] ??
      raw['IsWeighable'] ??
      raw['SoldByWeight'] ??
      (typeof raw['UnitType'] === 'string' &&
        (raw['UnitType'].includes('ק"ג') || raw['UnitType'].toLowerCase() === 'kg')),
  );
  const sellingMethod: SellingMethodCode = isWeight ? 'BY_WEIGHT' : 'BY_UNIT';

  const barcodeRaw = raw['BarKod'] ?? raw['Barcode'] ?? raw['barcode'];
  const barcodeStr =
    barcodeRaw !== undefined && barcodeRaw !== null ? String(barcodeRaw).trim() : '';
  const barcode = /^\d{5,14}$/.test(barcodeStr) && barcodeStr !== '0' ? barcodeStr : null;

  const brandName =
    typeof raw['ManufacturerName'] === 'string' && raw['ManufacturerName'].trim()
      ? raw['ManufacturerName'].trim()
      : typeof raw['BrandName'] === 'string' && raw['BrandName'].trim()
        ? raw['BrandName'].trim()
        : null;

  const weightVal = raw['Weight'] ?? raw['Content'];
  const weightUnit =
    typeof raw['WeightUnit'] === 'string'
      ? raw['WeightUnit'].trim()
      : typeof raw['UnitName'] === 'string'
        ? raw['UnitName'].trim()
        : '';
  const unitDescription =
    typeof raw['UnitDescription'] === 'string' && raw['UnitDescription'].trim()
      ? raw['UnitDescription'].trim()
      : weightVal && weightUnit
        ? `${weightVal} ${weightUnit}`
        : isWeight
          ? '1 ק"ג'
          : null;

  const pricePerUnitText =
    typeof raw['PricePerUnitDesc'] === 'string' && raw['PricePerUnitDesc'].trim()
      ? raw['PricePerUnitDesc'].trim()
      : null;

  let promotionMsg: string | null = null;
  if (typeof raw['SaleDesc'] === 'string' && raw['SaleDesc'].trim()) {
    promotionMsg = raw['SaleDesc'].trim();
  } else if (Array.isArray(raw['Promotions']) && raw['Promotions'].length > 0) {
    const firstPromo = raw['Promotions'][0] as Record<string, unknown> | undefined;
    const desc = firstPromo?.['Description'] ?? firstPromo?.['Name'];
    if (typeof desc === 'string' && desc.trim()) {
      promotionMsg = desc.trim();
    }
  } else if (priceNet > 0 && priceRegular > priceNet) {
    promotionMsg = `מבצע! במקום ${formatCurrency(priceRegular)}`;
  }

  const inStock = raw['IsInStock'] !== false && raw['IsOutOfStock'] !== true;
  const imageUrl =
    typeof raw['Img'] === 'string' && raw['Img'].trim() ? raw['Img'].trim() : null;
  const categoryName =
    typeof raw['SubCategoryName'] === 'string' && raw['SubCategoryName'].trim()
      ? raw['SubCategoryName'].trim()
      : typeof raw['CategoryName'] === 'string' && raw['CategoryName'].trim()
        ? raw['CategoryName'].trim()
        : null;

  return {
    code,
    storeId: 'hazi_hinam',
    barcode,
    name,
    brandName,
    unitDescription,
    sellingMethod,
    price: Number(effectivePrice.toFixed(2)),
    formattedPrice: formatCurrency(effectivePrice),
    pricePerUnitText,
    promotionMsg,
    inStock,
    purchasable: inStock && effectivePrice > 0,
    categoryName,
    imageUrl,
  };
}

export function parseHaziHinamCartResponse(
  payload: Record<string, unknown>,
  defaultDeliveryFee: number | null,
  isGuestSession: boolean,
): CartState | null {
  const results = (payload['Results'] ?? payload['results'] ?? payload) as
    | Record<string, unknown>
    | undefined;
  if (!results || typeof results !== 'object') return null;

  const cartObj = (results['Cart'] ?? results) as Record<string, unknown>;
  const rawItems =
    (Array.isArray(cartObj['Items']) ? cartObj['Items'] : null) ??
    (Array.isArray(cartObj['CartItems']) ? cartObj['CartItems'] : null) ??
    (Array.isArray(results['Items']) ? results['Items'] : null) ??
    (Array.isArray(results['CartItems']) ? results['CartItems'] : null);

  if (!rawItems) return null;

  const items: CartItem[] = [];
  let computedTotal = 0;

  rawItems.forEach((rawEntry, idx) => {
    const entry = rawEntry as Record<string, unknown>;
    const nestedItem = (entry['Item'] ?? entry) as Record<string, unknown>;
    const productCode = String(
      entry['ItemId'] ?? nestedItem['Id'] ?? entry['Id'] ?? '',
    ).trim();
    if (!productCode) return;

    const quantity = Number(entry['Quantity'] ?? entry['Qty'] ?? 1);
    if (!Number.isFinite(quantity) || quantity <= 0) return;

    const lineTotalRaw = Number(
      entry['TotalPrice'] ??
        entry['FinalPrice'] ??
        entry['TotalPriceAfterDiscount'] ??
        0,
    );
    const unitPrice = Number(
      entry['Price_NET'] ??
        entry['Price'] ??
        nestedItem['Price_NET'] ??
        nestedItem['Price_Regular'] ??
        0,
    );
    const itemPrice =
      lineTotalRaw > 0
        ? Number(lineTotalRaw.toFixed(2))
        : Number((unitPrice * quantity).toFixed(2));
    const inStock =
      entry['IsInStock'] !== false && nestedItem['IsInStock'] !== false;
    const isWeight = Boolean(entry['IsWeight'] ?? nestedItem['IsWeight']);

    if (inStock) {
      computedTotal += itemPrice;
    }

    items.push({
      entryNumber: idx,
      productCode,
      productName:
        String(entry['Name'] ?? nestedItem['Name'] ?? '').trim() || undefined,
      quantity,
      itemPrice,
      inStock,
      sellingMethod: isWeight ? 'BY_WEIGHT' : 'BY_UNIT',
    });
  });

  const serverTotal = Number(
    cartObj['TotalToPay'] ??
      cartObj['TotalPrice'] ??
      cartObj['SubTotal'] ??
      results['TotalToPay'] ??
      results['TotalPrice'] ??
      0,
  );
  const totalPrice =
    serverTotal > 0 && items.length > 0
      ? Number(serverTotal.toFixed(2))
      : Number(computedTotal.toFixed(2));

  const deliveryFeeRaw = Number(
    cartObj['DeliveryPrice'] ??
      cartObj['ShipmentPrice'] ??
      results['DeliveryPrice'] ??
      NaN,
  );
  const deliveryFee =
    Number.isFinite(deliveryFeeRaw) && deliveryFeeRaw >= 0
      ? deliveryFeeRaw
      : defaultDeliveryFee;

  return {
    storeId: 'hazi_hinam',
    items,
    totalPrice,
    deliveryFee,
    orderInUpdateMode: null,
    isGuestSession,
  };
}

function deepFindAccessToken(obj: unknown, depth = 0): string | null {
  if (depth > 8 || !obj) return null;
  if (typeof obj === 'object' && !Array.isArray(obj)) {
    const rec = obj as Record<string, unknown>;
    if (typeof rec['access_token'] === 'string' && rec['access_token'].length > 8) {
      return rec['access_token'];
    }
    for (const val of Object.values(rec)) {
      const found = deepFindAccessToken(val, depth + 1);
      if (found) return found;
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = deepFindAccessToken(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export class HaziHinamClient implements StoreClient {
  readonly storeId = 'hazi_hinam' as const;
  readonly meta = STORE_META.hazi_hinam;

  private readonly baseUrl: string;
  private readonly authBaseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly httpTimeoutMs: number;
  private readonly defaultDeliveryFee: number | null;

  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private isGuestSession = true;
  private oauthFailed = false;
  private authFallbackReason: string | null = null;
  private cookieHeader: string | null = null;
  private readonly knownProducts = new Map<string, CatalogProduct>();
  private readonly trackedCart = new Map<string, TrackedCartEntry>();
  private selectedSlot: DeliverySlot | null = null;

  constructor(private readonly options: HaziHinamClientOptions) {
    this.baseUrl = (options.baseUrl ?? HAZI_HINAM_BASE_URL).replace(/\/+$/, '');
    this.authBaseUrl = (options.authBaseUrl ?? HAZI_HINAM_AUTH_URL).replace(
      /\/+$/,
      '',
    );
    this.fetchFn = options.fetchFn ?? fetch;
    this.httpTimeoutMs = options.httpTimeoutMs ?? HAZI_HINAM_HTTP_TIMEOUT_MS;
    this.defaultDeliveryFee =
      options.defaultDeliveryFee ?? STORE_META.hazi_hinam.defaultDeliveryFee;
  }

  getAuthWarning(): string | null {
    return this.authFallbackReason;
  }

  private async fetchWithTimeout(
    url: string,
    init?: RequestInit,
  ): Promise<TimedTextResponse> {
    const secs = Math.max(1, Math.ceil(this.httpTimeoutMs / 1000));
    return fetchTextWithTimeout(
      this.fetchFn,
      url,
      init,
      this.httpTimeoutMs,
      `חצי חינם לא הגיב תוך ${secs} שניות`,
    );
  }

  private baseHeaders(includeAuth = true): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': DEFAULT_USER_AGENT,
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/`,
    };
    if (includeAuth && this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }
    if (this.cookieHeader) {
      headers['Cookie'] = this.cookieHeader;
    }
    return headers;
  }

  private tryLoadSavedSession(): boolean {
    if (!fs.existsSync(this.options.sessionFilePath)) return false;
    try {
      const raw = fs.readFileSync(this.options.sessionFilePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedHaziSession;
      const configuredUser = this.options.username?.trim();

      // If credentials are configured, ignore saved sessions belonging to a different username
      if (
        configuredUser &&
        !parsed.isGuest &&
        parsed.username &&
        parsed.username !== configuredUser
      ) {
        logger.info(
          'Hazi Hinam username changed in .env; ignoring cached session for previous user',
        );
        return false;
      }

      // Support saved cookies (including Playwright storage_state format)
      if (Array.isArray(parsed.cookies) && parsed.cookies.length > 0) {
        const haziCookies = parsed.cookies.filter(
          (c) => !c.domain || c.domain.includes('hazi-hinam'),
        );
        if (haziCookies.length > 0) {
          this.cookieHeader = haziCookies
            .map((c) => `${c.name}=${c.value}`)
            .join('; ');
          const authCookie = haziCookies.find(
            (c) => c.name === 'H_Authentication',
          );
          if (authCookie) {
            try {
              const decoded = JSON.parse(
                decodeURIComponent(authCookie.value),
              ) as Record<string, unknown>;
              if (typeof decoded['access_token'] === 'string') {
                this.accessToken = decoded['access_token'];
                this.isGuestSession = false;
                this.tokenExpiresAt = Date.now() + 12 * 60 * 60 * 1000;
                return true;
              }
            } catch {
              // ignore malformed cookie JSON
            }
          }
        }
      }

      if (
        parsed.accessToken &&
        parsed.expiresAt &&
        Date.now() < parsed.expiresAt - 60_000
      ) {
        this.accessToken = parsed.accessToken;
        this.tokenExpiresAt = parsed.expiresAt;
        this.isGuestSession = Boolean(parsed.isGuest);
        return true;
      }
      return false;
    } catch (err) {
      logger.warn('Failed loading saved Hazi Hinam session', err);
      return false;
    }
  }

  private saveSession(): void {
    if (!this.accessToken) return;
    try {
      const payload: PersistedHaziSession = {
        savedAt: new Date().toISOString(),
        username: this.isGuestSession
          ? undefined
          : this.options.username?.trim(),
        accessToken: this.accessToken,
        expiresAt: this.tokenExpiresAt,
        isGuest: this.isGuestSession,
      };
      fs.writeFileSync(
        this.options.sessionFilePath,
        JSON.stringify(payload, null, 2),
        'utf8',
      );
    } catch (err) {
      logger.warn('Failed saving Hazi Hinam session', err);
    }
  }

  async ensureAuthenticated(): Promise<void> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return;
    }

    if (this.tryLoadSavedSession()) {
      // If we now have credentials configured (and OAuth hasn't failed yet) but only a guest token was saved, upgrade to OAuth
      if (
        !this.isGuestSession ||
        this.oauthFailed ||
        !(this.options.username && this.options.password)
      ) {
        return;
      }
    }

    if (this.options.username && this.options.password && !this.oauthFailed) {
      try {
        await this.performOAuthLogin(this.options.username, this.options.password);
        this.authFallbackReason = null;
        return;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn(
          `Hazi Hinam OAuth login failed (${reason}); falling back to guest session for live price comparison`,
        );
        this.oauthFailed = true;
        this.authFallbackReason = reason;
        // Fall back to anonymous session so price comparison & mirroring keep working!
        try {
          await this.initAnonymousSession();
          return;
        } catch (guestErr) {
          logger.warn('Hazi Hinam anonymous session fallback also failed', guestErr);
          throw err;
        }
      }
    }

    await this.initAnonymousSession();
  }

  private async performOAuthLogin(
    username: string,
    password: string,
  ): Promise<void> {
    logger.info('Authenticating to Hazi Hinam via OAuth2 password grant...');
    const deviceInfo = JSON.stringify({
      DEVICE_TYPE: 4,
      UDID: `grocery-bot-${crypto.randomBytes(6).toString('hex')}`,
      MANUFACTURER: '',
      MODEL: '',
      VERSION: '',
    });

    const form = new URLSearchParams({
      grant_type: 'password',
      client_id: 'OSWS',
      userName: username.trim(),
      password,
    });

    const res = await this.fetchWithTimeout(`${this.authBaseUrl}/connect/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        DEVICE_INFO: deviceInfo,
        'User-Agent': DEFAULT_USER_AGENT,
        Origin: this.baseUrl,
        Referer: `${this.baseUrl}/`,
      },
      body: form.toString(),
    });

    const rawText = res.text;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      if (
        rawText.toLowerCase().includes('captcha') ||
        rawText.toLowerCase().includes('cloudflare')
      ) {
        throw new StoreManualVerificationRequiredError(
          'hazi_hinam',
          'SECURITY_GATE',
          'חצי חינם דורש אימות אבטחה (CAPTCHA) בהתחברות. המערכת לא עוקפת CAPTCHA – התחברו פעם אחת ידנית באתר חצי חינם או השאירו במצב השוואת מחירים אנונימי.',
        );
      }
      throw new StoreAuthError(
        'hazi_hinam',
        `שגיאת התחברות לחצי חינם (HTTP ${res.status})`,
      );
    }

    if (!res.ok || typeof parsed['access_token'] !== 'string') {
      const errMsg = String(
        parsed['error_description'] ?? parsed['error'] ?? `HTTP ${res.status}`,
      );
      if (errMsg.toLowerCase().includes('captcha')) {
        throw new StoreManualVerificationRequiredError(
          'hazi_hinam',
          'SECURITY_GATE',
          'חצי חינם דורש אימות CAPTCHA להתחברות לחשבון. התחברו ידנית באתר חצי חינם ושמרו סשן, או השתמשו בהשוואת מחירים.',
        );
      }
      throw new StoreAuthError(
        'hazi_hinam',
        `התחברות לחצי חינם נכשלה: ${errMsg}`,
      );
    }

    const expiresInSec = Number(parsed['expires_in'] ?? 172_800);
    this.accessToken = parsed['access_token'];
    this.tokenExpiresAt = Date.now() + Math.max(300, expiresInSec) * 1000;
    this.isGuestSession = false;
    this.saveSession();
    logger.info('Authenticated to Hazi Hinam successfully');
  }

  private async initAnonymousSession(): Promise<void> {
    logger.info('Initializing Hazi Hinam guest session via /proxy/init...');
    const res = await this.fetchWithTimeout(`${this.baseUrl}/proxy/init`, {
      method: 'GET',
      headers: this.baseHeaders(false),
    });

    if (!res.ok) {
      throw new Error(`Hazi Hinam /proxy/init failed with HTTP ${res.status}`);
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(res.text) as Record<string, unknown>;
    } catch {
      throw new Error('Hazi Hinam /proxy/init returned invalid JSON');
    }
    const results = (data['Results'] ?? data['results'] ?? {}) as Record<
      string,
      unknown
    >;
    const anon = (results['AnonymousToken'] ??
      results['anonymousToken'] ??
      {}) as Record<string, unknown>;

    const token =
      (typeof anon['access_token'] === 'string' && anon['access_token']) ||
      deepFindAccessToken(results);

    if (!token) {
      throw new Error('Hazi Hinam /proxy/init did not return an access_token');
    }

    const expiresInSec = Number(anon['expires_in'] ?? 172_800);
    this.accessToken = token;
    this.tokenExpiresAt = Date.now() + Math.max(300, expiresInSec) * 1000;
    this.isGuestSession = !this.cookieHeader;
    this.saveSession();
  }

  private async apiFetchJson(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
    retryOn401 = true,
  ): Promise<Record<string, unknown>> {
    await this.ensureAuthenticated();
    const res = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: init.method,
      headers: this.baseHeaders(true),
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

    if (res.status === 401 && retryOn401) {
      logger.warn('Hazi Hinam returned 401; refreshing token and retrying...');
      this.accessToken = null;
      this.tokenExpiresAt = 0;
      return this.apiFetchJson(path, init, false);
    }

    const text = res.text;
    if (!res.ok) {
      throw new Error(`Hazi Hinam ${path} failed (HTTP ${res.status}): ${text.slice(0, 180)}`);
    }

    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  async searchProducts(query: string, limit = 15): Promise<CatalogProduct[]> {
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    const data = await this.apiFetchJson('/proxy/api/item/getItemsBySearch', {
      method: 'POST',
      body: {
        Paging: { Page: 1, PageSize: Math.max(limit, 15) },
        Object: {
          SearchPhrase: cleanQuery,
          SearchPhrases: null,
          ItemGroupping: null,
        },
      },
    });

    const results = (data['Results'] ?? data['results'] ?? {}) as Record<
      string,
      unknown
    >;
    const rawItems = Array.isArray(results['Items'])
      ? (results['Items'] as Array<Record<string, unknown>>)
      : [];

    const parsed: CatalogProduct[] = [];
    for (const raw of rawItems) {
      const prod = parseHaziHinamProduct(raw);
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
      storeId: 'hazi_hinam',
      items,
      totalPrice: Number(totalPrice.toFixed(2)),
      deliveryFee: this.selectedSlot?.deliveryFee ?? this.defaultDeliveryFee,
      orderInUpdateMode: null,
      isGuestSession: this.isGuestSession,
    };
  }

  private syncTrackedFromServer(serverCart: CartState): void {
    this.trackedCart.clear();
    for (const item of serverCart.items) {
      const known = this.knownProducts.get(item.productCode);
      const unitPrice =
        item.quantity > 0
          ? Number((item.itemPrice / item.quantity).toFixed(2))
          : known?.price ?? 0;
      this.trackedCart.set(item.productCode, {
        productCode: item.productCode,
        productName: item.productName ?? known?.name ?? `מוצר (${item.productCode})`,
        quantity: item.quantity,
        unitPrice,
        sellingMethod: item.sellingMethod ?? known?.sellingMethod ?? 'BY_UNIT',
        inStock: item.inStock,
      });
    }
  }

  async getCartState(): Promise<CartState> {
    await this.ensureAuthenticated();
    for (const attempt of [
      { method: 'GET' as const, path: '/proxy/api/cart/getCart' },
      { method: 'POST' as const, path: '/proxy/api/cart/getCart', body: {} },
    ]) {
      try {
        const resp = await this.apiFetchJson(attempt.path, {
          method: attempt.method,
          body: attempt.body,
        });
        const parsed = parseHaziHinamCartResponse(
          resp,
          this.selectedSlot?.deliveryFee ?? this.defaultDeliveryFee,
          this.isGuestSession,
        );
        if (parsed) {
          if (
            this.trackedCart.size === 0 ||
            (!this.isGuestSession && parsed.items.length > 0) ||
            parsed.items.length >= this.trackedCart.size
          ) {
            this.syncTrackedFromServer(parsed);
            return parsed;
          }
          // If server returned empty/partial cart in guest mode while we have tracked additions, keep tracked state
          return this.buildTrackedCartState();
        }
      } catch (err) {
        if (isTimeoutError(err)) {
          logger.warn('Hazi Hinam getCart timed out; returning locally tracked cart state');
          break;
        }
        // try next endpoint shape
      }
    }
    return this.buildTrackedCartState();
  }

  async setItemsInCart(items: AddCartItemInput[]): Promise<CartState> {
    await this.ensureAuthenticated();
    const isBatch = items.length > 1;
    let consecutiveTimeouts = 0;
    let skipRemainingNetwork = false;

    for (const item of items) {
      const numericId = Number(item.productCode);
      const cleanQty =
        item.sellingMethod === 'BY_WEIGHT'
          ? Number(item.quantity.toFixed(2))
          : Math.max(1, Math.round(item.quantity));

      const known = this.knownProducts.get(item.productCode);
      const existing = this.trackedCart.get(item.productCode);

      if (!skipRemainingNetwork) {
        const body: Record<string, unknown> = {
          Object: {
            ItemId: Number.isFinite(numericId) && numericId > 0 ? numericId : item.productCode,
            Quantity: cleanQty,
            ...(item.comment ? { Remarks: item.comment } : {}),
          },
        };

        try {
          const resp = await this.apiFetchJson('/proxy/api/item/addItemToCart', {
            method: 'POST',
            body,
          });
          consecutiveTimeouts = 0;

          if (resp['IsOK'] === false) {
            const errInfo = JSON.stringify(resp['ErrorResponse'] ?? resp).slice(0, 180);
            if (isBatch) {
              logger.warn(
                `Hazi Hinam rejected batch item ${item.productCode}: ${errInfo}`,
              );
              continue;
            }
            throw new Error(`חצי חינם דחה את הוספת המוצר (${item.productCode}): ${errInfo}`);
          }
        } catch (err) {
          const timedOut = isTimeoutError(err);
          if (timedOut) {
            consecutiveTimeouts++;
          } else {
            consecutiveTimeouts = 0;
          }

          if (!isBatch) {
            throw err;
          }

          if (timedOut && consecutiveTimeouts >= 2) {
            if (!this.isGuestSession) {
              logger.warn(
                'Hazi Hinam timed out repeatedly during authenticated batch cart sync; aborting batch',
              );
              throw err;
            }
            logger.warn(
              'Hazi Hinam timed out repeatedly during guest batch sync; tracking remaining items locally',
            );
            skipRemainingNetwork = true;
          } else if (!this.isGuestSession) {
            logger.warn(
              `Hazi Hinam failed adding batch item ${item.productCode}; continuing batch`,
              err,
            );
            continue;
          } else {
            // In guest mode, if addItemToCart endpoint fails, still keep tracked live price for comparison
            logger.warn(
              `Hazi Hinam guest addItemToCart failed for ${item.productCode}; tracking locally`,
              err,
            );
          }
        }
      }

      this.trackedCart.set(item.productCode, {
        productCode: item.productCode,
        productName: known?.name ?? existing?.productName ?? `מוצר (${item.productCode})`,
        quantity: cleanQty,
        unitPrice: known?.price ?? existing?.unitPrice ?? 0,
        sellingMethod: item.sellingMethod,
        inStock: known?.inStock ?? true,
      });
    }

    if (skipRemainingNetwork) {
      return this.buildTrackedCartState();
    }
    return this.getCartState();
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
    const sellingMethod = existing?.sellingMethod ?? known?.sellingMethod ?? 'BY_UNIT';

    return this.setItemsInCart([
      {
        productCode,
        quantity,
        sellingMethod,
      },
    ]);
  }

  async removeFromCart(productCode: string): Promise<CartState> {
    await this.ensureAuthenticated();
    const numericId = Number(productCode);
    const itemId =
      Number.isFinite(numericId) && numericId > 0 ? numericId : productCode;

    let removedOnServer = false;
    let timedOut = false;
    for (const attempt of [
      {
        path: '/proxy/api/item/removeItemFromCart',
        body: { Object: { ItemId: itemId } },
      },
      {
        path: '/proxy/api/item/addItemToCart',
        body: { Object: { ItemId: itemId, Quantity: 0 } },
      },
    ]) {
      try {
        const resp = await this.apiFetchJson(attempt.path, {
          method: 'POST',
          body: attempt.body,
        });
        if (resp['IsOK'] !== false) {
          removedOnServer = true;
          break;
        }
      } catch (err) {
        if (isTimeoutError(err)) {
          timedOut = true;
          break;
        }
        // try fallback endpoint
      }
    }

    if (!removedOnServer) {
      logger.warn(`Hazi Hinam server removal fallback used for item ${productCode}`);
    }
    this.trackedCart.delete(productCode);
    if (timedOut) {
      return this.buildTrackedCartState();
    }
    return this.getCartState();
  }

  async clearCart(): Promise<void> {
    await this.ensureAuthenticated();
    try {
      await this.apiFetchJson('/proxy/api/cart/clearCart', {
        method: 'POST',
        body: {},
      });
    } catch (err) {
      if (!isTimeoutError(err)) {
        const codes = [...this.trackedCart.keys()];
        for (const code of codes) {
          await this.removeFromCart(code).catch(() => {});
        }
      }
    }
    this.trackedCart.clear();
  }

  async getAvailableTimeSlots(): Promise<DeliverySlot[]> {
    try {
      const data = await this.apiFetchJson('/proxy/api/delivery/getDeliveryDates', {
        method: 'POST',
        body: {},
      });
      const results = (data['Results'] ?? {}) as Record<string, unknown>;
      const rawSlots = Array.isArray(results['Dates'])
        ? (results['Dates'] as Array<Record<string, unknown>>)
        : Array.isArray(results['Shipments'])
          ? (results['Shipments'] as Array<Record<string, unknown>>)
          : [];

      return rawSlots
        .map((s): DeliverySlot | null => {
          const code = String(s['Id'] ?? s['ShipmentId'] ?? '').trim();
          const startIso = String(s['FromDate'] ?? s['StartDate'] ?? '').trim();
          if (!code || !startIso) return null;
          const fee = Number(s['Price'] ?? s['DeliveryPrice'] ?? this.defaultDeliveryFee ?? NaN);
          return {
            code,
            startIso,
            endIso: typeof s['ToDate'] === 'string' ? s['ToDate'] : null,
            startHourText: String(s['FromHour'] ?? ''),
            endHourText: typeof s['ToHour'] === 'string' ? s['ToHour'] : null,
            deliveryFee: Number.isFinite(fee) ? fee : this.defaultDeliveryFee,
            selectable: s['IsAvailable'] !== false,
            isToday: false,
            rawSlot: s,
          };
        })
        .filter((s): s is DeliverySlot => s !== null && s.selectable);
    } catch {
      return [];
    }
  }

  async getSelectedTimeSlot(): Promise<DeliverySlot | null> {
    return this.selectedSlot;
  }

  async selectTimeSlot(slotCode: string): Promise<DeliverySlot> {
    const slots = await this.getAvailableTimeSlots();
    const match = slots.find((s) => s.code === slotCode);
    if (!match) {
      throw new Error(`חלון המשלוח (${slotCode}) לא נמצא בחצי חינם`);
    }
    this.selectedSlot = match;
    return match;
  }

  async getActiveOrders(): Promise<ActiveOrderSummary[]> {
    return [];
  }

  async putOrderInUpdateMode(_orderCode: string): Promise<CartState> {
    throw new Error('עדכון הזמנה קיימת אינו נתמך אוטומטית בחצי חינם');
  }

  async placeOrder(_options: {
    removeMissingItems: boolean;
  }): Promise<CheckoutResult> {
    const cart = await this.getCartState();
    if (cart.items.length === 0) {
      throw new Error('עגלת חצי חינם ריקה – אין מה להזמין.');
    }

    const total = formatCurrency(cart.totalPrice);
    if (this.isGuestSession) {
      throw new StoreManualVerificationRequiredError(
        'hazi_hinam',
        'MANUAL_CHECKOUT',
        `עגלת חצי חינם חושבה בסך ${total} (במצב אורח – לא הוגדרו פרטי התחברות HAZI_HINAM_USERNAME/PASSWORD). התחברו לאתר חצי חינם כדי להשלים את ההזמנה או הגדירו פרטי התחברות ב-.env.`,
        STORE_META.hazi_hinam.cartUrl,
      );
    }

    throw new StoreManualVerificationRequiredError(
      'hazi_hinam',
      'MANUAL_CHECKOUT',
      `העגלה שלכם בחצי חינם מוכנה עם ${cart.items.length} פריטים בסך ${total}! להשלמת בחירת חלון המשלוח והתשלום המאובטח לחצו על הקישור הישיר לעגלה:`,
      STORE_META.hazi_hinam.cartUrl,
    );
  }

  async shutdown(): Promise<void> {
    // Pure HTTP client; nothing to tear down
  }
}
