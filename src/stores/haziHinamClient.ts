import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, {
  type Browser,
  type BrowserContext,
  type Page,
} from 'puppeteer-core';
import { logger } from '../logger.js';
import { formatCurrency, formatHebrewDateTime } from '../utils/format.js';
import {
  fetchTextWithTimeout,
  isTimeoutError,
  withTimeout,
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
const BROWSER_NAV_TIMEOUT_MS = 35_000;
const BROWSER_CLOSE_TIMEOUT_MS = 5_000;
const BROWSER_PROTOCOL_TIMEOUT_MS = 45_000;
const AUTH_RETRY_COOLDOWN_MS = 5 * 60_000;

export interface HaziHinamClientOptions {
  username?: string;
  password?: string;
  sessionFilePath: string;
  chromePath?: string;
  browserWsEndpoint?: string;
  proxyUrl?: string;
  headless?: boolean;
  screenshotsDir?: string;
  baseUrl?: string;
  authBaseUrl?: string;
  defaultDeliveryFee?: number;
  fetchFn?: typeof fetch;
  httpTimeoutMs?: number;
}

interface PersistedCookie {
  name: string;
  value: string;
  domain?: string;
}

interface PersistedHaziSession {
  savedAt: string;
  username?: string;
  accessToken?: string;
  expiresAt?: number;
  isGuest?: boolean;
  cookies?: PersistedCookie[];
  selectedSlot?: DeliverySlot | null;
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

function formatHourFromIso(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleTimeString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function normalizeHourText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  const hm = /^(\d{1,2}):(\d{2})/.exec(trimmed);
  if (hm) {
    return `${hm[1]!.padStart(2, '0')}:${hm[2]!}`;
  }
  return trimmed;
}

function combineDateAndHourToIso(dateRaw: unknown, hourRaw?: unknown): string | null {
  if (typeof dateRaw === 'number' && Number.isFinite(dateRaw) && dateRaw > 0) {
    const dt = new Date(dateRaw);
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
  }
  if (typeof dateRaw !== 'string' || !dateRaw.trim()) return null;
  const trimmed = dateRaw.trim();
  const hourStr = normalizeHourText(hourRaw);

  // Date-only format (YYYY-MM-DD) or DD/MM/YYYY with separate hour text
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (ymd) {
    const timePart = /^\d{2}:\d{2}$/.test(hourStr) ? `${hourStr}:00` : '09:00:00';
    const dt = new Date(`${ymd[1]}-${ymd[2]}-${ymd[3]}T${timePart}+02:00`);
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
  }

  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(trimmed);
  if (dmy) {
    const timePart = /^\d{2}:\d{2}$/.test(hourStr) ? `${hourStr}:00` : '09:00:00';
    const dt = new Date(
      `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}T${timePart}+02:00`,
    );
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
  }

  const direct = new Date(trimmed);
  if (!Number.isNaN(direct.getTime())) {
    if (
      /^\d{2}:\d{2}$/.test(hourStr) &&
      trimmed.includes('T00:00:00')
    ) {
      const datePrefix = trimmed.slice(0, 10);
      const combined = new Date(`${datePrefix}T${hourStr}:00+02:00`);
      if (!Number.isNaN(combined.getTime())) return combined.toISOString();
    }
    return direct.toISOString();
  }
  return null;
}

function isSameIsraelDay(iso: string, now = new Date()): boolean {
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return false;
  return fmt(target) === fmt(now);
}

export function parseHaziHinamDeliverySlots(
  payload: Record<string, unknown>,
  defaultDeliveryFee: number | null,
): DeliverySlot[] {
  const results = (payload['Results'] ?? payload['results'] ?? payload) as
    | Record<string, unknown>
    | Array<Record<string, unknown>>
    | undefined;
  if (!results) return [];

  const rawEntries: Array<Record<string, unknown>> = Array.isArray(results)
    ? results
    : Array.isArray(results['Dates'])
      ? (results['Dates'] as Array<Record<string, unknown>>)
      : Array.isArray(results['Shipments'])
        ? (results['Shipments'] as Array<Record<string, unknown>>)
        : Array.isArray(results['DeliveryDates'])
          ? (results['DeliveryDates'] as Array<Record<string, unknown>>)
          : Array.isArray(results['TimeSlots'])
            ? (results['TimeSlots'] as Array<Record<string, unknown>>)
            : Array.isArray(results['Slots'])
              ? (results['Slots'] as Array<Record<string, unknown>>)
              : [];

  const slots: DeliverySlot[] = [];
  const seenCodes = new Set<string>();

  const pushSlot = (
    s: Record<string, unknown>,
    parentDate?: unknown,
  ): void => {
    const rawCode =
      s['Id'] ??
      s['ShipmentId'] ??
      s['SlotId'] ??
      s['TimeSlotId'] ??
      s['Code'] ??
      s['id'];
    const fromHourRaw = s['FromHour'] ?? s['StartHour'] ?? s['StartTime'] ?? s['fromHour'];
    const toHourRaw = s['ToHour'] ?? s['EndHour'] ?? s['EndTime'] ?? s['toHour'];

    const startIso = combineDateAndHourToIso(
      s['FromDate'] ?? s['StartDate'] ?? s['DeliveryDate'] ?? s['Date'] ?? parentDate,
      fromHourRaw,
    );
    if (!startIso) return;

    const endIso = combineDateAndHourToIso(
      s['ToDate'] ?? s['EndDate'] ?? (toHourRaw ? (s['DeliveryDate'] ?? s['Date'] ?? parentDate) : undefined),
      toHourRaw,
    );

    const startHourText =
      normalizeHourText(fromHourRaw) || formatHourFromIso(startIso);
    const endHourText =
      normalizeHourText(toHourRaw) || (endIso ? formatHourFromIso(endIso) : null);

    const code =
      rawCode !== undefined && rawCode !== null && String(rawCode).trim() !== ''
        ? String(rawCode).trim()
        : `${startIso.slice(0, 10)}_${startHourText}`;

    const selectable =
      s['IsAvailable'] !== false &&
      s['Available'] !== false &&
      s['Selectable'] !== false &&
      s['IsFull'] !== true &&
      s['IsClosed'] !== true;

    if (!selectable || seenCodes.has(code)) return;
    seenCodes.add(code);

    const feeRaw = Number(
      s['Price'] ??
        s['DeliveryPrice'] ??
        s['ShipmentPrice'] ??
        s['Cost'] ??
        NaN,
    );

    slots.push({
      code,
      startIso,
      endIso,
      startHourText,
      endHourText: endHourText || null,
      deliveryFee: Number.isFinite(feeRaw) && feeRaw >= 0 ? feeRaw : defaultDeliveryFee,
      selectable: true,
      isToday:
        typeof s['IsToday'] === 'boolean'
          ? s['IsToday']
          : isSameIsraelDay(startIso),
      rawSlot: parentDate !== undefined ? { ...s, ParentDate: parentDate } : s,
    });
  };

  for (const entry of rawEntries) {
    const nested =
      (Array.isArray(entry['Hours']) ? entry['Hours'] : null) ??
      (Array.isArray(entry['TimeSlots']) ? entry['TimeSlots'] : null) ??
      (Array.isArray(entry['Shipments']) ? entry['Shipments'] : null) ??
      (Array.isArray(entry['Slots']) ? entry['Slots'] : null);

    if (nested && nested.length > 0) {
      const parentDate =
        entry['Date'] ?? entry['DeliveryDate'] ?? entry['FromDate'] ?? entry['DayDate'];
      for (const child of nested) {
        if (child && typeof child === 'object') {
          pushSlot(child as Record<string, unknown>, parentDate);
        }
      }
    } else {
      pushSlot(entry);
    }
  }

  slots.sort(
    (a, b) => new Date(a.startIso).getTime() - new Date(b.startIso).getTime(),
  );
  return slots;
}

export function parseHaziHinamOrders(
  payload: Record<string, unknown>,
): ActiveOrderSummary[] {
  const results = (payload['Results'] ?? payload['results'] ?? payload) as
    | Record<string, unknown>
    | Array<Record<string, unknown>>
    | undefined;
  if (!results) return [];

  const rawOrders: Array<Record<string, unknown>> = Array.isArray(results)
    ? results
    : Array.isArray(results['Orders'])
      ? (results['Orders'] as Array<Record<string, unknown>>)
      : Array.isArray(results['ActiveOrders'])
        ? (results['ActiveOrders'] as Array<Record<string, unknown>>)
        : Array.isArray(results['Items'])
          ? (results['Items'] as Array<Record<string, unknown>>)
          : [];

  const orders: ActiveOrderSummary[] = [];
  for (const raw of rawOrders) {
    const code = String(
      raw['OrderId'] ?? raw['OrderNumber'] ?? raw['Id'] ?? raw['Code'] ?? '',
    ).trim();
    if (!code) continue;

    const statusCode = String(
      raw['StatusName'] ?? raw['Status'] ?? raw['OrderStatus'] ?? 'ACTIVE',
    ).trim();
    const statusLower = statusCode.toLowerCase();
    if (
      statusLower.includes('cancel') ||
      statusLower.includes('בוטל') ||
      statusLower.includes('delivered') ||
      statusLower.includes('סופק') ||
      raw['IsHistory'] === true
    ) {
      continue;
    }

    const fromHour = normalizeHourText(raw['FromHour'] ?? raw['StartHour']);
    const toHour = normalizeHourText(raw['ToHour'] ?? raw['EndHour']);
    const deliveryIso =
      combineDateAndHourToIso(
        raw['DeliveryDate'] ?? raw['SupplyDate'] ?? raw['FromDate'] ?? raw['OrderDate'],
        fromHour,
      ) ?? new Date().toISOString();

    const totalPrice = Number(
      raw['TotalToPay'] ?? raw['TotalPrice'] ?? raw['FinalPrice'] ?? 0,
    );
    const totalItems = Number(
      raw['ItemsCount'] ?? raw['TotalItems'] ?? (Array.isArray(raw['Items']) ? raw['Items'].length : 0),
    );

    orders.push({
      code,
      deliveryIso,
      deliveryHoursText:
        fromHour && toHour ? `${fromHour}–${toHour}` : fromHour || null,
      updatableUntilText:
        typeof raw['UpdateUntil'] === 'string' && raw['UpdateUntil'].trim()
          ? raw['UpdateUntil'].trim()
          : null,
      totalPrice: Number.isFinite(totalPrice) ? Number(totalPrice.toFixed(2)) : 0,
      totalItems: Number.isFinite(totalItems) ? totalItems : 0,
      statusCode,
      isUpdatable: false,
      isBeingUpdated: false,
    });
  }

  return orders;
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
  private authRetryAfter = 0;
  private authFallbackReason: string | null = null;
  private cookieHeader: string | null = null;
  private persistedCookies: PersistedCookie[] = [];
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
    this.tryLoadSavedSession();
  }

  getAuthWarning(): string | null {
    return this.authFallbackReason;
  }

  isAuthenticated(): boolean {
    if (!this.accessToken) {
      this.tryLoadSavedSession();
    }
    return Boolean(
      this.accessToken &&
        !this.isGuestSession &&
        Date.now() < this.tokenExpiresAt - 60_000,
    );
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

      if (
        parsed.selectedSlot &&
        typeof parsed.selectedSlot.startIso === 'string' &&
        new Date(parsed.selectedSlot.startIso).getTime() > Date.now()
      ) {
        this.selectedSlot = parsed.selectedSlot;
      }

      // Support saved cookies (including Puppeteer/Playwright storage_state format)
      if (Array.isArray(parsed.cookies) && parsed.cookies.length > 0) {
        const haziCookies = parsed.cookies.filter(
          (c) => !c.domain || c.domain.includes('hazi-hinam'),
        );
        if (haziCookies.length > 0) {
          this.persistedCookies = haziCookies;
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
                this.tokenExpiresAt =
                  parsed.expiresAt && parsed.expiresAt > Date.now() + 60_000
                    ? parsed.expiresAt
                    : Date.now() + 12 * 60 * 60 * 1000;
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
        ...(this.persistedCookies.length > 0
          ? { cookies: this.persistedCookies }
          : {}),
        selectedSlot: this.selectedSlot,
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
      // If we are on a guest token, credentials exist, and retry cooldown has expired, upgrade to full login
      if (
        !this.isGuestSession ||
        !(this.options.username && this.options.password) ||
        Date.now() < this.authRetryAfter
      ) {
        return;
      }
    }

    if (this.tryLoadSavedSession()) {
      if (
        !this.isGuestSession ||
        Date.now() < this.authRetryAfter ||
        !(this.options.username && this.options.password)
      ) {
        return;
      }
    }

    if (
      this.options.username &&
      this.options.password &&
      Date.now() >= this.authRetryAfter
    ) {
      try {
        await this.performOAuthLogin(this.options.username, this.options.password);
        this.authFallbackReason = null;
        this.authRetryAfter = 0;
        return;
      } catch (oauthErr) {
        const oauthReason =
          oauthErr instanceof Error ? oauthErr.message : String(oauthErr);

        // If Chromium is available and OAuth didn't hit a hard CAPTCHA gate, try browser login like Shufersal
        const canTryBrowser =
          Boolean(this.options.chromePath || this.options.browserWsEndpoint) &&
          !(oauthErr instanceof StoreManualVerificationRequiredError);

        if (canTryBrowser) {
          logger.warn(
            `Hazi Hinam OAuth login failed (${oauthReason}); attempting Chromium web login...`,
          );
          try {
            await this.performBrowserLogin(
              this.options.username,
              this.options.password,
            );
            this.authFallbackReason = null;
            this.authRetryAfter = 0;
            return;
          } catch (browserErr) {
            const browserReason =
              browserErr instanceof Error ? browserErr.message : String(browserErr);
            logger.warn(
              `Hazi Hinam Chromium login also failed (${browserReason}); falling back to guest session for live price comparison`,
            );
            this.authRetryAfter = Date.now() + AUTH_RETRY_COOLDOWN_MS;
            this.authFallbackReason = browserReason;
            try {
              await this.initAnonymousSession();
              return;
            } catch (guestErr) {
              logger.warn('Hazi Hinam anonymous session fallback also failed', guestErr);
              throw browserErr;
            }
          }
        }

        logger.warn(
          `Hazi Hinam OAuth login failed (${oauthReason}); falling back to guest session for live price comparison`,
        );
        this.authRetryAfter = Date.now() + AUTH_RETRY_COOLDOWN_MS;
        this.authFallbackReason = oauthReason;
        // Fall back to anonymous session so price comparison & mirroring keep working!
        try {
          await this.initAnonymousSession();
          return;
        } catch (guestErr) {
          logger.warn('Hazi Hinam anonymous session fallback also failed', guestErr);
          throw oauthErr;
        }
      }
    }

    await this.initAnonymousSession();
  }

  private async detectBrowserSecurityGate(page: Page): Promise<void> {
    const gateDetected = await withTimeout(
      page.evaluate(() => {
        const html = document.documentElement?.innerHTML?.toLowerCase() ?? '';
        const title = document.title?.toLowerCase() ?? '';
        return (
          title.includes('just a moment') ||
          title.includes('attention required') ||
          html.includes('cf-turnstile') ||
          html.includes('g-recaptcha') ||
          html.includes('hcaptcha')
        );
      }),
      10_000,
      'Hazi Hinam security gate check timed out',
    );

    if (gateDetected) {
      await this.captureBrowserScreenshot(page, 'hazi-security-gate');
      throw new StoreManualVerificationRequiredError(
        'hazi_hinam',
        'SECURITY_GATE',
        'אתר חצי חינם מציג בדיקת אבטחה/CAPTCHA בהתחברות. המערכת לא עוקפת CAPTCHA – ניתן להתחבר ידנית באתר חצי חינם או להמשיך במצב השוואת מחירים.',
        STORE_META.hazi_hinam.cartUrl,
      );
    }
  }

  private async captureBrowserScreenshot(page: Page, tag: string): Promise<void> {
    if (!this.options.screenshotsDir) return;
    try {
      const fullPath = path.join(
        this.options.screenshotsDir,
        `${tag}-${Date.now()}.png`,
      );
      await withTimeout(
        page.screenshot({ path: fullPath }),
        BROWSER_CLOSE_TIMEOUT_MS,
        'Hazi Hinam screenshot timed out',
      );
      logger.info(`Saved diagnostic screenshot: ${fullPath}`);
    } catch {
      // Ignore screenshot failures
    }
  }

  /**
   * Browser-backed login fallback matching ShufersalClient.performLogin():
   * launches headless Chromium, logs in via shop.hazi-hinam.co.il form,
   * extracts auth cookies + Bearer token, persists them, and closes the browser.
   */
  private async performBrowserLogin(
    username: string,
    password: string,
  ): Promise<void> {
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    const isRemote = Boolean(this.options.browserWsEndpoint);

    try {
      if (this.options.browserWsEndpoint) {
        browser = await withTimeout(
          puppeteer.connect({
            browserWSEndpoint: this.options.browserWsEndpoint,
            protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
          }),
          BROWSER_NAV_TIMEOUT_MS,
          'Timed out connecting to Chromium for Hazi Hinam login',
        );
      } else {
        const launchArgs = [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--lang=he-IL',
          '--window-size=1366,900',
        ];
        if (this.options.proxyUrl) {
          launchArgs.push(`--proxy-server=${this.options.proxyUrl}`);
        }
        browser = await withTimeout(
          puppeteer.launch({
            executablePath: this.options.chromePath,
            headless: this.options.headless ?? true,
            args: launchArgs,
            timeout: BROWSER_NAV_TIMEOUT_MS,
            protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
          }),
          BROWSER_NAV_TIMEOUT_MS + 5_000,
          'Timed out launching Chromium for Hazi Hinam login',
        );
      }

      context = await withTimeout(
        browser.createBrowserContext(),
        BROWSER_NAV_TIMEOUT_MS,
        'Timed out creating browser context for Hazi Hinam login',
      );
      const page = await withTimeout(
        context.newPage(),
        BROWSER_NAV_TIMEOUT_MS,
        'Timed out creating page for Hazi Hinam login',
      );
      page.setDefaultTimeout(BROWSER_NAV_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(BROWSER_NAV_TIMEOUT_MS);
      await page.setViewport({ width: 1366, height: 900 });

      await page.goto(`${this.baseUrl}/login`, {
        waitUntil: 'domcontentloaded',
        timeout: BROWSER_NAV_TIMEOUT_MS,
      });
      await this.detectBrowserSecurityGate(page);

      // If /login redirected to home, click a visible login trigger if present
      const userSelector =
        'input[type="email"], input[name*="email" i], input[name*="user" i], input[id*="email" i], input[id*="user" i], input[autocomplete="username"]';
      const passSelector = 'input[type="password"]';

      const hasLoginInputs = await page
        .waitForSelector(passSelector, { visible: true, timeout: 8_000 })
        .then(() => true)
        .catch(() => false);

      if (!hasLoginInputs) {
        await withTimeout(
          page.evaluate(() => {
            const triggers = Array.from(
              document.querySelectorAll<HTMLElement>('button, a, [role="button"]'),
            );
            const match = triggers.find((el) => {
              const t = (el.textContent ?? '').trim();
              return /התחבר|כניסה|login/i.test(t) && el.offsetParent !== null;
            });
            match?.click();
          }),
          5_000,
          'Timed out clicking Hazi Hinam login button',
        );
        await page.waitForSelector(passSelector, {
          visible: true,
          timeout: 12_000,
        });
      }

      await this.detectBrowserSecurityGate(page);

      const userInput = await page.$(userSelector);
      if (!userInput) {
        await this.captureBrowserScreenshot(page, 'hazi-login-selectors-missing');
        throw new Error('לא נמצא שדה שם משתמש/אימייל בטופס ההתחברות של חצי חינם');
      }

      await withTimeout(
        page.evaluate((uSel: string, pSel: string) => {
          const u = document.querySelector<HTMLInputElement>(uSel);
          const p = document.querySelector<HTMLInputElement>(pSel);
          if (u) u.value = '';
          if (p) p.value = '';
        }, userSelector, passSelector),
        5_000,
        'Timed out clearing Hazi Hinam login inputs',
      );

      await page.type(userSelector, username.trim());
      await page.type(passSelector, password);

      const submitted = await withTimeout(
        page.evaluate((pSel: string) => {
          const passEl = document.querySelector<HTMLInputElement>(pSel);
          const form = passEl?.closest('form');
          const btn =
            form?.querySelector<HTMLElement>('button[type="submit"], input[type="submit"]') ??
            Array.from(document.querySelectorAll<HTMLElement>('button')).find((b) =>
              /התחבר|כניסה|אישור/i.test(b.textContent ?? ''),
            );
          if (btn) {
            btn.click();
            return true;
          }
          if (form) {
            form.submit();
            return true;
          }
          return false;
        }, passSelector),
        5_000,
        'Timed out submitting Hazi Hinam login form',
      );

      if (!submitted) {
        await page.keyboard.press('Enter');
      }

      // Wait up to 15s for H_Authentication cookie or access_token in storage
      const authDeadline = Date.now() + 15_000;
      let extractedToken: string | null = null;
      let extractedCookies: PersistedCookie[] = [];

      while (Date.now() < authDeadline) {
        const rawCookies = await withTimeout(
          context.cookies(),
          5_000,
          'Timed out reading Hazi Hinam browser cookies',
        );
        const haziCookies: PersistedCookie[] = rawCookies
          .filter((c) => !c.domain || c.domain.includes('hazi-hinam'))
          .map((c) => ({ name: c.name, value: c.value, domain: c.domain }));

        const authCookie = haziCookies.find((c) => c.name === 'H_Authentication');
        if (authCookie) {
          try {
            const decoded = JSON.parse(
              decodeURIComponent(authCookie.value),
            ) as Record<string, unknown>;
            if (typeof decoded['access_token'] === 'string') {
              extractedToken = decoded['access_token'];
              extractedCookies = haziCookies;
              break;
            }
          } catch {
            // continue checking storage
          }
        }

        const storageToken = await withTimeout(
          page.evaluate(() => {
            const readStore = (s: Storage): string | null => {
              for (let i = 0; i < s.length; i++) {
                const k = s.key(i);
                if (!k) continue;
                const v = s.getItem(k) ?? '';
                if (v.includes('access_token')) {
                  try {
                    const parsed = JSON.parse(v) as Record<string, unknown>;
                    if (typeof parsed['access_token'] === 'string') {
                      return parsed['access_token'];
                    }
                  } catch {
                    const m = /"access_token"\s*:\s*"([^"]+)"/.exec(v);
                    if (m?.[1]) return m[1];
                  }
                }
              }
              return null;
            };
            return readStore(window.localStorage) ?? readStore(window.sessionStorage);
          }),
          5_000,
          'Timed out reading Hazi Hinam browser storage',
        ).catch(() => null);

        if (storageToken) {
          extractedToken = storageToken;
          extractedCookies = haziCookies;
          break;
        }

        await new Promise((r) => setTimeout(r, 500));
      }

      if (!extractedToken) {
        await this.detectBrowserSecurityGate(page);
        await this.captureBrowserScreenshot(page, 'hazi-login-failed');
        throw new StoreAuthError(
          'hazi_hinam',
          'התחברות לחצי חינם דרך הדפדפן לא הושלמה – בדקו את HAZI_HINAM_USERNAME ו-HAZI_HINAM_PASSWORD',
        );
      }

      this.accessToken = extractedToken;
      this.tokenExpiresAt = Date.now() + 12 * 60 * 60 * 1000;
      this.isGuestSession = false;
      this.persistedCookies = extractedCookies;
      this.cookieHeader =
        extractedCookies.length > 0
          ? extractedCookies.map((c) => `${c.name}=${c.value}`).join('; ')
          : null;
      this.saveSession();
      logger.info('Authenticated to Hazi Hinam via Chromium web login successfully');
    } finally {
      if (context) {
        await withTimeout(
          context.close(),
          BROWSER_CLOSE_TIMEOUT_MS,
          'Timed out closing Hazi Hinam browser context',
        ).catch(() => {});
      }
      if (browser && !isRemote) {
        await withTimeout(
          browser.close(),
          BROWSER_CLOSE_TIMEOUT_MS,
          'Timed out closing Hazi Hinam browser',
        ).catch(() => {});
      }
    }
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
      this.authRetryAfter = 0;
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
    await this.ensureAuthenticated();
    for (const attempt of [
      { method: 'POST' as const, path: '/proxy/api/delivery/getDeliveryDates', body: {} },
      { method: 'GET' as const, path: '/proxy/api/delivery/getDeliveryDates' },
      { method: 'POST' as const, path: '/proxy/api/shipment/getShipments', body: {} },
    ]) {
      try {
        const data = await this.apiFetchJson(attempt.path, {
          method: attempt.method,
          body: attempt.body,
        });
        const slots = parseHaziHinamDeliverySlots(data, this.defaultDeliveryFee);
        if (slots.length > 0) {
          return slots;
        }
      } catch (err) {
        if (isTimeoutError(err)) {
          logger.warn('Hazi Hinam delivery slots request timed out');
          break;
        }
        // try next endpoint shape
      }
    }
    return [];
  }

  async getSelectedTimeSlot(): Promise<DeliverySlot | null> {
    if (
      this.selectedSlot &&
      new Date(this.selectedSlot.startIso).getTime() <= Date.now()
    ) {
      this.selectedSlot = null;
    }
    return this.selectedSlot;
  }

  async selectTimeSlot(slotCode: string): Promise<DeliverySlot> {
    await this.ensureAuthenticated();
    const slots = await this.getAvailableTimeSlots();
    const match = slots.find((s) => s.code === slotCode);
    if (!match) {
      throw new Error(`חלון המשלוח המבוקש (${slotCode}) כבר אינו פנוי בחצי חינם`);
    }

    if (!this.isGuestSession) {
      const numericId = Number(match.code);
      const idVal =
        Number.isFinite(numericId) && numericId > 0 ? numericId : match.code;
      const bodyPayload = {
        Object: {
          ...match.rawSlot,
          Id: idVal,
          ShipmentId: idVal,
          DeliveryDate: match.startIso,
        },
      };

      let reservedOnServer = false;
      for (const endpoint of [
        '/proxy/api/delivery/setDeliveryDate',
        '/proxy/api/cart/setDeliveryDate',
      ]) {
        try {
          const resp = await this.apiFetchJson(endpoint, {
            method: 'POST',
            body: bodyPayload,
          });
          if (resp['IsOK'] !== false) {
            reservedOnServer = true;
            break;
          }
        } catch (err) {
          if (isTimeoutError(err)) break;
          // try fallback endpoint
        }
      }
      if (!reservedOnServer) {
        logger.warn(
          `Hazi Hinam server slot reservation fallback used for slot ${slotCode}; saved locally for cart/checkout`,
        );
      }
    }

    this.selectedSlot = match;
    this.saveSession();
    return match;
  }

  async getActiveOrders(): Promise<ActiveOrderSummary[]> {
    await this.ensureAuthenticated();
    if (this.isGuestSession) {
      return [];
    }
    for (const attempt of [
      { method: 'POST' as const, path: '/proxy/api/order/getOrders', body: {} },
      { method: 'GET' as const, path: '/proxy/api/order/getOrders' },
      { method: 'POST' as const, path: '/proxy/api/customer/getOrders', body: {} },
    ]) {
      try {
        const data = await this.apiFetchJson(attempt.path, {
          method: attempt.method,
          body: attempt.body,
        });
        const orders = parseHaziHinamOrders(data);
        if (orders.length > 0) {
          return orders;
        }
      } catch (err) {
        if (isTimeoutError(err)) {
          logger.warn('Hazi Hinam active orders request timed out');
          break;
        }
        // try next endpoint shape
      }
    }
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
    const slotNote = this.selectedSlot
      ? ` (חלון משלוח שנבחר: ${formatHebrewDateTime(this.selectedSlot.startIso, this.selectedSlot.endHourText)})`
      : '';

    if (this.isGuestSession) {
      throw new StoreManualVerificationRequiredError(
        'hazi_hinam',
        'MANUAL_CHECKOUT',
        `עגלת חצי חינם חושבה בסך ${total}${slotNote} (במצב אורח – לא הוגדרו פרטי התחברות HAZI_HINAM_USERNAME/PASSWORD או שההתחברות נכשלה). התחברו לאתר חצי חינם כדי להשלים את ההזמנה או הגדירו פרטי התחברות ב-.env.`,
        STORE_META.hazi_hinam.cartUrl,
      );
    }

    throw new StoreManualVerificationRequiredError(
      'hazi_hinam',
      'MANUAL_CHECKOUT',
      `העגלה שלכם בחצי חינם מוכנה עם ${cart.items.length} פריטים בסך ${total}${slotNote}! להשלמת התשלום המאובטח לחצו על הקישור הישיר לעגלה:`,
      STORE_META.hazi_hinam.cartUrl,
    );
  }

  async shutdown(): Promise<void> {
    // Browser instances are short-lived for login only; nothing persistent to tear down
  }
}
