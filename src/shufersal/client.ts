import fs from 'node:fs';
import path from 'node:path';
import puppeteer, {
  type Browser,
  type BrowserContext,
  type Page,
} from 'puppeteer-core';
import { logger } from '../logger.js';
import {
  parseOrderCodeFromConfirmation,
  rawCartPageToCartState,
  type RawCartPage,
} from './cartParser.js';
import {
  STORE_META,
  type StoreClient,
} from '../stores/types.js';
import {
  ShufersalAuthError,
  ShufersalManualVerificationRequiredError,
  type ActiveOrderSummary,
  type AddCartItemInput,
  type CartState,
  type CatalogProduct,
  type CheckoutResult,
  type DeliverySlot,
  type SerializedSessionCookies,
  type ShufersalSellingMethodCode,
} from './types.js';
import { TimeoutError, withTimeout } from '../utils/timeout.js';

export const BASE_URL = 'https://www.shufersal.co.il';
export const WEBAPP_URL = `${BASE_URL}/online/he`;
const NAVIGATION_TIMEOUT = 35_000;
export const SHUFERSAL_REQUEST_TIMEOUT_MS = 20_000;
const HEALTHCHECK_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 5_000;
const PROTOCOL_TIMEOUT_MS = 45_000;

declare global {
  interface Window {
    ACC?: {
      config?: {
        CSRFToken?: string;
      };
    };
    PayMe?: {
      clientData: (isTestMode: boolean) => Promise<{ hash?: string }>;
    };
  }
}

export interface ShufersalClientOptions {
  username: string;
  password: string;
  chromePath?: string;
  browserWsEndpoint?: string;
  proxyUrl?: string;
  headless: boolean;
  sessionFilePath: string;
  screenshotsDir: string;
  requestTimeoutMs?: number;
}

interface ApiRequestOptions {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  form?: Record<string, string>;
}

type ResponseFormat = 'json' | 'cart' | 'page';

interface CheckoutAuthConfig {
  threeDSecureEnabled: boolean;
  threeDSecureTestMode: boolean;
  paymeScriptUrls: string[];
}

function normalizeSellingMethod(raw?: string | null): ShufersalSellingMethodCode {
  if (raw === 'BY_WEIGHT') return 'BY_WEIGHT';
  if (raw === 'BY_PACKAGE') return 'BY_PACKAGE';
  return 'BY_UNIT';
}

export class ShufersalClient implements StoreClient {
  readonly storeId = 'shufersal' as const;
  readonly meta = STORE_META.shufersal;

  private readonly requestTimeoutMs: number;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private csrfToken: string | undefined;

  constructor(private readonly options: ShufersalClientOptions) {
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? SHUFERSAL_REQUEST_TIMEOUT_MS;
  }

  private get outerEvaluateTimeoutMs(): number {
    return (
      this.requestTimeoutMs +
      Math.min(3_000, Math.max(25, Math.round(this.requestTimeoutMs * 0.25)))
    );
  }

  async ensureConnected(): Promise<void> {
    if (this.page && !this.page.isClosed()) {
      try {
        await withTimeout(
          this.page.evaluate(() => document.title),
          HEALTHCHECK_TIMEOUT_MS,
          'Shufersal browser healthcheck timed out',
        );
        return;
      } catch {
        logger.warn('Existing Shufersal browser page became unresponsive; recreating session');
        await this.closeSessionOnly();
      }
    }

    await this.initBrowser();
    if (!this.browser) {
      throw new Error('Failed to initialize Chromium browser');
    }

    this.context = await withTimeout(
      this.browser.createBrowserContext(),
      NAVIGATION_TIMEOUT,
      'Timed out creating Shufersal browser context',
    );
    this.page = await withTimeout(
      this.context.newPage(),
      NAVIGATION_TIMEOUT,
      'Timed out creating Shufersal browser page',
    );
    this.page.setDefaultTimeout(NAVIGATION_TIMEOUT);
    this.page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
    await this.page.setViewport({ width: 1366, height: 900 });
    try {
      await this.page.emulateTimezone('Asia/Jerusalem');
    } catch {
      // Ignore if remote browser does not support timezone override
    }

    this.page.on('framenavigated', (frame) => {
      if (this.page && frame === this.page.mainFrame()) {
        this.csrfToken = undefined;
      }
    });

    const restored = await this.tryRestoreSavedCookies();
    if (!restored) {
      await this.performLogin();
    }
  }

  private async initBrowser(): Promise<void> {
    if (this.browser && this.browser.connected) {
      return;
    }

    if (this.options.browserWsEndpoint) {
      logger.info(`Connecting to remote browser endpoint: ${this.options.browserWsEndpoint}`);
      this.browser = await withTimeout(
        puppeteer.connect({
          browserWSEndpoint: this.options.browserWsEndpoint,
          protocolTimeout: PROTOCOL_TIMEOUT_MS,
        }),
        NAVIGATION_TIMEOUT,
        'Timed out connecting to remote Chromium browser',
      );
      return;
    }

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

    logger.info(`Launching Chromium from: ${this.options.chromePath}`);
    this.browser = await withTimeout(
      puppeteer.launch({
        executablePath: this.options.chromePath,
        headless: this.options.headless,
        args: launchArgs,
        timeout: NAVIGATION_TIMEOUT,
        protocolTimeout: PROTOCOL_TIMEOUT_MS,
      }),
      NAVIGATION_TIMEOUT + 5_000,
      'Timed out launching Chromium browser',
    );
  }

  private async tryRestoreSavedCookies(): Promise<boolean> {
    if (!this.context || !this.page) return false;
    if (!fs.existsSync(this.options.sessionFilePath)) return false;

    try {
      const raw = fs.readFileSync(this.options.sessionFilePath, 'utf8');
      const parsed = JSON.parse(raw) as SerializedSessionCookies;
      if (!Array.isArray(parsed.cookies) || parsed.cookies.length === 0) {
        return false;
      }

      await this.context.setCookie(
        ...(parsed.cookies as Parameters<BrowserContext['setCookie']>),
      );
      await this.page.goto(`${WEBAPP_URL}/wish-lists/main`, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT,
      });

      await this.detectSecurityGate(this.page);

      const isLoggedIn =
        !this.page.url().includes('/login') &&
        (await this.page.evaluate(
          () => document.querySelector('.title-notAnonymous') !== null,
        ));

      if (isLoggedIn) {
        logger.info('Restored saved Shufersal session cookies successfully');
        return true;
      }
      logger.info('Saved Shufersal session expired; performing fresh login');
      return false;
    } catch (err) {
      if (err instanceof ShufersalManualVerificationRequiredError) {
        throw err;
      }
      logger.warn('Could not restore saved Shufersal session; falling back to login', err);
      return false;
    }
  }

  private async saveSessionCookies(): Promise<void> {
    if (!this.context) return;
    try {
      const cookies = await this.context.cookies();
      const payload: SerializedSessionCookies = {
        savedAt: new Date().toISOString(),
        cookies,
      };
      fs.writeFileSync(
        this.options.sessionFilePath,
        JSON.stringify(payload, null, 2),
        'utf8',
      );
    } catch (err) {
      logger.warn('Failed to persist Shufersal session cookies', err);
    }
  }

  private async detectSecurityGate(page: Page): Promise<void> {
    const gateDetected = await withTimeout(
      page.evaluate(() => {
        const html = document.documentElement?.innerHTML?.toLowerCase() ?? '';
        const title = document.title?.toLowerCase() ?? '';
        if (
          title.includes('just a moment') ||
          title.includes('attention required') ||
          html.includes('cf-turnstile') ||
          html.includes('g-recaptcha') ||
          html.includes('hcaptcha')
        ) {
          return true;
        }
        return false;
      }),
      10_000,
      'Shufersal security gate check timed out',
    );

    if (gateDetected) {
      await this.captureErrorScreenshot('security-gate');
      throw new ShufersalManualVerificationRequiredError(
        'SECURITY_GATE',
        'אתר שופרסל מציג כרגע בדיקת אבטחה/אנושיות (CAPTCHA). המערכת אינה עוקפת בדיקות אבטחה אוטומטית – מומלץ להתחבר ידנית בדפדפן או להשלים את ההזמנה ישירות באתר.',
      );
    }
  }

  async performLogin(): Promise<void> {
    if (!this.page) {
      throw new Error('Browser page is not initialized');
    }

    logger.info('Logging in to Shufersal Online...');
    await this.page.goto(`${WEBAPP_URL}/login`, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT,
    });

    await this.detectSecurityGate(this.page);

    try {
      await this.page.waitForSelector('#j_username', {
        visible: true,
        timeout: NAVIGATION_TIMEOUT,
      });
      await this.page.waitForSelector('#j_password', {
        visible: true,
        timeout: NAVIGATION_TIMEOUT,
      });
      await this.page.waitForSelector('.btn-login', {
        visible: true,
        timeout: NAVIGATION_TIMEOUT,
      });
    } catch (err) {
      await this.detectSecurityGate(this.page);
      await this.captureErrorScreenshot('login-selectors-missing');
      throw new Error(
        `טופס ההתחברות של שופרסל לא נטען בזמן (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    // Clear inputs before typing in case of re-login
    await this.page.evaluate(() => {
      const u = document.querySelector<HTMLInputElement>('#j_username');
      const p = document.querySelector<HTMLInputElement>('#j_password');
      if (u) u.value = '';
      if (p) p.value = '';
    });

    await this.page.type('#j_username', this.options.username);
    await this.page.type('#j_password', this.options.password);
    await this.page.click('.btn-login');

    const outcome = await Promise.race([
      this.page
        .waitForSelector('.modal.message-modal.error.in', {
          visible: true,
          timeout: NAVIGATION_TIMEOUT,
        })
        .then(() => 'error' as const)
        .catch(() => null),
      this.page
        .waitForFunction(
          (loginSubstr) => !window.location.href.includes(loginSubstr),
          { timeout: NAVIGATION_TIMEOUT },
          '/login',
        )
        .then(() => 'navigation' as const)
        .catch(() => null),
    ]);

    if (outcome === 'error') {
      await this.captureErrorScreenshot('invalid-credentials');
      throw new ShufersalAuthError();
    }

    if (outcome === null) {
      await this.detectSecurityGate(this.page);
      await this.captureErrorScreenshot('login-timeout');
      throw new Error('תם הזמן להמתנה להתחברות לשופרסל (Login Timeout)');
    }

    // Reload once after login so CSRFToken & POST endpoints work cleanly (avoids HTTP 405)
    await this.page.reload({
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT,
    });

    await this.saveSessionCookies();
    logger.info('Logged in to Shufersal Online successfully');
  }

  async searchProducts(query: string, limit = 16): Promise<CatalogProduct[]> {
    await this.ensureConnected();

    // Using q=<query> (without :relevance) lets Shufersal prioritize the user's past purchases
    const encoded = encodeURIComponent(query.trim());
    const data = await this.apiRequest<{
      results?: Array<Record<string, unknown>>;
    }>({
      method: 'GET',
      path: `/search/results?q=${encoded}&limit=${String(limit)}`,
    });

    const results = data?.results ?? [];
    return results.map((item) => this.mapSearchResultToCatalogProduct(item));
  }

  private mapSearchResultToCatalogProduct(
    raw: Record<string, unknown>,
  ): CatalogProduct {
    const priceObj = (raw['price'] as Record<string, unknown> | undefined) ?? {};
    const effectivePrice =
      typeof raw['effectivePrice'] === 'number'
        ? raw['effectivePrice']
        : Number(priceObj['value'] ?? 0);

    const formattedPrice =
      typeof priceObj['formattedValue'] === 'string'
        ? priceObj['formattedValue']
        : `₪${effectivePrice.toFixed(2)}`;

    const brandObj = raw['brand'] as Record<string, unknown> | null | undefined;
    const brandName =
      typeof brandObj?.['name'] === 'string'
        ? brandObj['name']
        : typeof raw['brandName'] === 'string'
          ? raw['brandName']
          : null;

    const sellingMethodObj = raw['sellingMethod'] as
      | Record<string, unknown>
      | string
      | undefined;
    const sellingMethodCode =
      typeof sellingMethodObj === 'string'
        ? normalizeSellingMethod(sellingMethodObj)
        : normalizeSellingMethod(
            sellingMethodObj?.['code'] as string | undefined,
          );

    const stockObj = raw['stock'] as
      | { stockLevelStatus?: { code?: string } }
      | undefined;
    const inStock =
      stockObj?.stockLevelStatus?.code !== undefined
        ? stockObj.stockLevelStatus.code === 'inStock'
        : true;

    const pricePerUnitObj = raw['pricePerUnit'] as
      | { formattedValue?: string }
      | undefined;
    const unitForComparison =
      typeof raw['unitForComparison'] === 'string'
        ? raw['unitForComparison']
        : null;
    const pricePerUnitText =
      pricePerUnitObj?.formattedValue && unitForComparison
        ? `${pricePerUnitObj.formattedValue} ל-${unitForComparison}`
        : pricePerUnitObj?.formattedValue ?? null;

    const images = Array.isArray(raw['images'])
      ? (raw['images'] as Array<Record<string, unknown>>)
      : [];
    const primaryImage =
      images.find((img) => img['format'] === 'large') ?? images[0];
    const imageUrl =
      typeof primaryImage?.['url'] === 'string' ? primaryImage['url'] : null;

    const categoryGroup = raw['commercialCategorySubGroup'] as
      | { name?: string }
      | null
      | undefined;
    const categoryName =
      typeof raw['secondLevelCategory'] === 'string'
        ? raw['secondLevelCategory']
        : typeof categoryGroup?.name === 'string'
          ? categoryGroup.name.replace(/^\d+-/, '')
          : null;

    const code = String(raw['code'] ?? '');
    const strippedCode = code.replace(/^P_/i, '').trim();
    const barcode = /^\d{6,14}$/.test(strippedCode) ? strippedCode : null;

    return {
      code,
      storeId: 'shufersal',
      barcode,
      name: String(raw['name'] ?? ''),
      brandName,
      unitDescription:
        typeof raw['unitDescription'] === 'string'
          ? raw['unitDescription']
          : null,
      sellingMethod: sellingMethodCode,
      price: effectivePrice,
      formattedPrice,
      pricePerUnitText,
      promotionMsg:
        typeof raw['promotionMsg'] === 'string' ? raw['promotionMsg'] : null,
      inStock,
      purchasable: raw['purchasable'] !== false,
      categoryName,
      imageUrl,
    };
  }

  async getCartState(): Promise<CartState> {
    await this.ensureConnected();
    return this.cartRequest({
      method: 'GET',
      path: '/cart/load?restoreCart=true',
    });
  }

  /**
   * Sets exact quantities for products in the cart (or adds them if not present)
   * via Shufersal's `/cart/addGrid` endpoint.
   */
  async setItemsInCart(items: AddCartItemInput[]): Promise<CartState> {
    await this.ensureConnected();
    const payload = items.map((item) => ({
      productCode: item.productCode,
      quantity: item.quantity,
      frontQuantity: item.quantity,
      sellingMethod: item.sellingMethod,
      comment: item.comment ?? '',
      longTail: false,
    }));

    return this.cartRequest({
      method: 'POST',
      path: '/cart/addGrid',
      body: payload,
    });
  }

  async updateCartItemQuantity(
    productCode: string,
    quantity: number,
    entryNumber?: number,
  ): Promise<CartState> {
    await this.ensureConnected();
    let resolvedEntry = entryNumber;
    if (resolvedEntry === undefined) {
      const current = await this.getCartState();
      const found = current.items.find((i) => i.productCode === productCode);
      if (!found) {
        return current;
      }
      resolvedEntry = found.entryNumber;
    }

    const cleanQty = Math.max(0, Number(quantity.toFixed(2)));
    const query = new URLSearchParams({
      entryNumber: String(resolvedEntry),
      qty: String(cleanQty),
      'cartContext[openFrom]': 'CART',
      'cartContext[recommendationType]': 'REGULAR',
    });
    if (cleanQty === 0) {
      query.set('cartContext[action]', 'remove');
    }

    return this.cartRequest({
      method: 'POST',
      path: `/cart/update?${query.toString()}`,
      body: { quantity: cleanQty },
    });
  }

  async removeFromCart(productCode: string, entryNumber?: number): Promise<CartState> {
    return this.updateCartItemQuantity(productCode, 0, entryNumber);
  }

  async clearCart(): Promise<void> {
    await this.ensureConnected();
    await this.apiRequest({
      method: 'POST',
      path: '/cart/remove',
    });
  }

  async getActiveOrders(): Promise<ActiveOrderSummary[]> {
    await this.ensureConnected();
    const [ordersResp, cartState] = await Promise.all([
      this.apiRequest<{
        activeOrders?: Array<Record<string, unknown>>;
      }>({
        method: 'GET',
        path: '/my-account/orders',
      }),
      this.getCartState(),
    ]);

    const activeOrders = ordersResp?.activeOrders ?? [];
    return activeOrders.map((order) => {
      const consignments = Array.isArray(order['consignments'])
        ? (order['consignments'] as Array<Record<string, unknown>>)
        : [];
      const firstConsignment = consignments[0] ?? {};
      const startMs = Number(firstConsignment['timeSlotStartTime'] ?? Date.now());
      const startHours =
        typeof firstConsignment['timeSlotStartHoursString'] === 'string'
          ? firstConsignment['timeSlotStartHoursString']
          : null;
      const endHours =
        typeof firstConsignment['timeSlotEndHoursString'] === 'string'
          ? firstConsignment['timeSlotEndHoursString']
          : null;

      const totalPriceObj = order['totalPrice'] as
        | { value?: number }
        | undefined;
      const statusObj = order['status'] as { code?: string } | undefined;

      const updateDate =
        typeof order['updateToDateString'] === 'string'
          ? order['updateToDateString']
          : null;
      const updateHour =
        typeof order['updateToHourString'] === 'string'
          ? order['updateToHourString']
          : null;

      const code = String(order['code'] ?? '');
      return {
        code,
        deliveryIso: new Date(startMs).toISOString(),
        deliveryHoursText:
          startHours && endHours ? `${startHours}–${endHours}` : startHours,
        updatableUntilText:
          updateDate && updateHour ? `${updateDate} בשעה ${updateHour}` : null,
        totalPrice: Number(totalPriceObj?.value ?? 0),
        totalItems: Number(order['totalItems'] ?? 0),
        statusCode: String(statusObj?.code ?? 'RECEIVED'),
        isUpdatable: Boolean(order['isUpdatable']),
        isBeingUpdated: cartState.orderInUpdateMode === code,
      };
    });
  }

  async putOrderInUpdateMode(orderCode: string): Promise<CartState> {
    await this.ensureConnected();
    await this.apiRequest({
      method: 'GET',
      path: `/cart/cartFromOrder/${encodeURIComponent(orderCode)}`,
    });
    return this.getCartState();
  }

  async getAvailableTimeSlots(): Promise<DeliverySlot[]> {
    await this.ensureConnected();
    const response = await this.apiRequest<
      Record<string, Array<Record<string, unknown>>>
    >({
      method: 'GET',
      path: '/timeSlot/preselection/getHomeDeliverySlots',
    });

    if (!response) return [];
    const slots: DeliverySlot[] = [];

    for (const dateKey of Object.keys(response)) {
      const daySlots = response[dateKey] ?? [];
      for (const raw of daySlots) {
        const slot = this.mapRawSlot(raw);
        if (slot && slot.selectable) {
          slots.push(slot);
        }
      }
    }

    slots.sort(
      (a, b) => new Date(a.startIso).getTime() - new Date(b.startIso).getTime(),
    );
    return slots;
  }

  async getSelectedTimeSlot(): Promise<DeliverySlot | null> {
    await this.ensureConnected();
    const raw = await this.apiRequest<Record<string, unknown>>({
      method: 'GET',
      path: '/timeSlot/preselection/getSelectedTimeslot',
    });
    if (!raw || !raw['code']) return null;
    return this.mapRawSlot(raw);
  }

  private mapRawSlot(raw: Record<string, unknown>): DeliverySlot | null {
    const code = typeof raw['code'] === 'string' ? raw['code'] : null;
    const fromHour = typeof raw['fromHour'] === 'number' ? raw['fromHour'] : null;
    if (!code || !fromHour) return null;

    const toHour = typeof raw['toHour'] === 'number' ? raw['toHour'] : null;
    const startDt = new Date(fromHour);
    const endDt = toHour ? new Date(toHour) : null;

    const formatHm = (d: Date) =>
      d.toLocaleTimeString('he-IL', {
        timeZone: 'Asia/Jerusalem',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });

    const priceObj = raw['price'] as { value?: number } | null | undefined;

    return {
      code,
      startIso: startDt.toISOString(),
      endIso: endDt ? endDt.toISOString() : null,
      startHourText:
        typeof raw['fromHourString'] === 'string' && raw['fromHourString']
          ? raw['fromHourString']
          : formatHm(startDt),
      endHourText: endDt ? formatHm(endDt) : null,
      deliveryFee:
        typeof priceObj?.value === 'number' ? priceObj.value : null,
      selectable: raw['selectable'] !== false,
      isToday: Boolean(raw['isToday']),
      rawSlot: raw,
    };
  }

  async selectTimeSlot(slotCode: string): Promise<DeliverySlot> {
    await this.ensureConnected();
    const slots = await this.getAvailableTimeSlots();
    const target = slots.find((s) => s.code === slotCode);
    if (!target) {
      throw new Error(`חלון המשלוח המבוקש (${slotCode}) כבר אינו פנוי בשופרסל`);
    }

    await this.apiRequest({
      method: 'POST',
      path: '/timeSlot/preselection/postHomeDeliverySlot',
      body: {
        homeDeliveryTimeSlot: target.rawSlot,
      },
    });
    return target;
  }

  async placeOrder(options: {
    removeMissingItems: boolean;
  }): Promise<CheckoutResult> {
    await this.ensureConnected();
    const preCart = await this.getCartState();
    const wasOrderUpdate = Boolean(preCart.orderInUpdateMode);

    logger.info('Authenticating Shufersal checkout...');
    const checkoutAuth = await this.authenticateCheckout();

    let composed = await this.getComposedCheckout();
    const slotStartMs =
      composed.directCart.consignments?.[0]?.timeSlotStartTime ?? null;
    if (!slotStartMs) {
      throw new Error(
        'לא נבחר חלון משלוח פעיל. יש לבחור משלוח בפקודה /slots לפני ביצוע ההזמנה.',
      );
    }

    const removedOutOfStockCodes: string[] = [];
    const missingEntries = composed.directCart.entries.filter(
      (entry) =>
        entry.outOfStock === true ||
        entry.product?.stock?.stockLevelStatus?.code === 'outOfStock',
    );

    if (missingEntries.length > 0) {
      const missingCodes = missingEntries.map((e) => e.product.code);
      if (!options.removeMissingItems) {
        throw new Error(
          `בעגלה קיימים מוצרים שאזלו מהמלאי (${missingCodes.join(', ')}). ניתן לאשר הסרה אוטומטית או להסירם ידנית.`,
        );
      }

      logger.info(`Removing ${missingCodes.length} out-of-stock items prior to checkout`);
      let currentItems = await this.getCartState().then((s) => s.items);
      for (const code of missingCodes) {
        const match = currentItems.find((i) => i.productCode === code);
        if (match) {
          const updated = await this.removeFromCart(code, match.entryNumber);
          currentItems = updated.items;
          removedOutOfStockCodes.push(code);
        }
      }
      composed = await this.getComposedCheckout();
    }

    const shouldCheckAdult = await this.apiRequest<boolean>({
      method: 'GET',
      path: '/checkout/adultCheck/shouldCheckIfAdult',
    });
    if (shouldCheckAdult) {
      await this.apiRequest({
        method: 'POST',
        path: '/checkout/adultCheck/setAdultsOnlyAllowed',
        form: { load: 'true' },
      });
    }

    const jwtPayme = await this.getPaymeClientHash(checkoutAuth);

    logger.info('Submitting placeOrder request to Shufersal...');
    const response = await this.apiRequest<
      | {
          success?: boolean;
          redirect?: string;
          allocationTimeout?: boolean;
          otherCreditCard3DSLink?: string;
          directCreditCard3DSLink?: string;
        }
      | Array<{ errorCode?: string; code?: string; message?: string }>
    >({
      method: 'GET',
      path: `/checkout/placeOrder?jwtPayme=${jwtPayme}&after3ds=false`,
    });

    if (!response) {
      throw new Error('לא התקבלה תשובה משופרסל בעת שליחת ההזמנה');
    }

    if (Array.isArray(response)) {
      const msg = response
        .map((e) => e.message ?? e.errorCode ?? e.code ?? 'שגיאה לא ידועה')
        .join(', ');
      throw new Error(`שופרסל דחה את השלמת ההזמנה: ${msg}`);
    }

    if (response.otherCreditCard3DSLink || response.directCreditCard3DSLink) {
      throw new ShufersalManualVerificationRequiredError(
        '3DS',
        'חברת האשראי דורשת אימות 3D-Secure חד-פעמי עבור כרטיס האשראי. העגלה וחלון המשלוח מוכנים – השלם את האישור באתר שופרסל.',
        `${WEBAPP_URL}/checkout`,
      );
    }

    if (response.allocationTimeout) {
      throw new Error('תם הזמן לשמירת חלון המשלוח בשופרסל. אנא בחר חלון משלוח מחדש (/slots).');
    }

    if (!response.success || !response.redirect) {
      throw new Error(`תשובה לא צפויה משופרסל בעת סגירת ההזמנה: ${JSON.stringify(response)}`);
    }

    const deliveryIso = new Date(slotStartMs).toISOString();
    let confirmedCode: string | null = null;

    try {
      const confPage = await this.pageRequest(response.redirect);
      if (confPage) {
        confirmedCode = parseOrderCodeFromConfirmation(
          confPage.url,
          confPage.html,
        );
      }
    } catch (err) {
      logger.warn('Could not parse confirmation page directly; checking active orders', err);
    }

    const activeOrders = await this.getActiveOrders();
    const matchedOrder =
      (confirmedCode
        ? activeOrders.find((o) => o.code === confirmedCode)
        : undefined) ??
      activeOrders.find((o) => o.deliveryIso === deliveryIso) ??
      activeOrders[0];

    await this.saveSessionCookies();

    return {
      orderCode: confirmedCode ?? matchedOrder?.code ?? 'אושרה',
      deliveryIso: matchedOrder?.deliveryIso ?? deliveryIso,
      totalPrice: matchedOrder?.totalPrice ?? preCart.totalPrice,
      wasOrderUpdate,
      removedOutOfStockCodes,
    };
  }

  private async authenticateCheckout(): Promise<CheckoutAuthConfig> {
    if (!this.page) throw new Error('Browser page not initialized');
    const fetchTimeoutMs = this.requestTimeoutMs;
    const outerTimeoutMs = this.outerEvaluateTimeoutMs;

    const authForm = await withTimeout(
      this.page.evaluate(
        async (url, timeoutMs) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const response = await fetch(url, {
              credentials: 'include',
              signal: controller.signal,
            });
            if (!response.ok) {
              throw new Error(`Failed loading checkout auth (${String(response.status)})`);
            }
            const doc = new DOMParser().parseFromString(
              await response.text(),
              'text/html',
            );
            const form = doc.querySelector('form#checkoutPwd');
            if (!form) return null;
            const fields: Record<string, string> = {};
            form.querySelectorAll('input').forEach((input) => {
              if (input.name) fields[input.name] = input.value;
            });
            return {
              fields,
              verifyPath: form.getAttribute('action'),
              submitPath: form.getAttribute('data-action2'),
            };
          } catch (err) {
            if (
              controller.signal.aborted ||
              (err instanceof Error && err.name === 'AbortError')
            ) {
              throw new Error('SHUFERSAL_REQUEST_TIMEOUT');
            }
            throw err;
          } finally {
            clearTimeout(timer);
          }
        },
        `${WEBAPP_URL}/cart/checkout/auth?redirect_url=%2Fcheckout&checkout_flow=true`,
        fetchTimeoutMs,
      ),
      outerTimeoutMs,
      `שופרסל לא הגיב בטעינת אימות הקופה תוך ${Math.ceil(fetchTimeoutMs / 1000)} שניות`,
    );

    if (!authForm?.verifyPath || !authForm.submitPath) {
      throw new Error(
        'לא נמצא טופס אימות לתשלום בשופרסל (וודא שבחשבון מוגדרים כתובת וכרטיס אשראי שמור).',
      );
    }

    if (authForm.fields['strongAuth'] === 'true') {
      throw new ShufersalManualVerificationRequiredError(
        'OTP',
        'שופרסל דורש אימות קוד SMS חד-פעמי (OTP) לפני חיוב ההזמנה. כל המוצרים וחלון המשלוח כבר שמורים בעגלה שלך – ניתן להשלים בלחיצה באתר/אפליקציה.',
        `${WEBAPP_URL}/cart`,
      );
    }

    const fields = {
      ...authForm.fields,
      j_password: this.options.password,
    };

    const verifyResult = await withTimeout(
      this.page.evaluate(
        async (url, formFields, timeoutMs) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const res = await fetch(url, {
              method: 'POST',
              credentials: 'include',
              headers: {
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'x-requested-with': 'XMLHttpRequest',
              },
              body: new URLSearchParams(formFields).toString(),
              signal: controller.signal,
            });
            if (!res.ok) {
              throw new Error(`Checkout password verification HTTP ${String(res.status)}`);
            }
            return (await res.json()) as { success: boolean; message?: string | null };
          } catch (err) {
            if (
              controller.signal.aborted ||
              (err instanceof Error && err.name === 'AbortError')
            ) {
              throw new Error('SHUFERSAL_REQUEST_TIMEOUT');
            }
            throw err;
          } finally {
            clearTimeout(timer);
          }
        },
        `${BASE_URL}${authForm.verifyPath}`,
        fields,
        fetchTimeoutMs,
      ),
      outerTimeoutMs,
      `שופרסל לא הגיב באימות הסיסמה בקופה תוך ${Math.ceil(fetchTimeoutMs / 1000)} שניות`,
    );

    if (!verifyResult.success) {
      throw new ShufersalAuthError(
        `אימות הסיסמה בקופה נכשל: ${verifyResult.message ?? 'סיסמה שגויה'}`,
      );
    }

    const checkoutPage = await withTimeout(
      this.page.evaluate(
        async (url, formFields, timeoutMs) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const res = await fetch(url, {
              method: 'POST',
              credentials: 'include',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams(formFields).toString(),
              signal: controller.signal,
            });
            const html = await res.text();
            const csrfToken = html.match(/CSRFToken\s*[:=]\s*["']([^"']+)["']/)?.[1];
            if (csrfToken && window.ACC?.config) {
              window.ACC.config.CSRFToken = csrfToken;
            }
            const doc = new DOMParser().parseFromString(html, 'text/html');
            return {
              url: res.url,
              csrfToken,
              threeDSecureEnabled: html.match(
                /miglog\.threeDSecure\.enabled\s*=\s*(true|false)/,
              )?.[1],
              threeDSecureTestMode: html.match(
                /miglog\.threeDSecure\.isTestMode\s*=\s*(true|false)/,
              )?.[1],
              paymeScriptUrls: Array.from(doc.querySelectorAll('script[src]'))
                .map((s) => s.getAttribute('src') ?? '')
                .filter((src) => src.includes('paymeservice.com')),
            };
          } catch (err) {
            if (
              controller.signal.aborted ||
              (err instanceof Error && err.name === 'AbortError')
            ) {
              throw new Error('SHUFERSAL_REQUEST_TIMEOUT');
            }
            throw err;
          } finally {
            clearTimeout(timer);
          }
        },
        `${BASE_URL}${authForm.submitPath}`,
        fields,
        fetchTimeoutMs,
      ),
      outerTimeoutMs,
      `שופרסל לא הגיב בטעינת דף הקופה תוך ${Math.ceil(fetchTimeoutMs / 1000)} שניות`,
    );

    if (!checkoutPage.url.includes('/miglog-checkout')) {
      throw new Error(
        `מעבר לקופה נעצר בכתובת לא צפויה (${checkoutPage.url}). ודא שקיימים כתובת משלוח ואמצעי תשלום שמור בחשבון שופרסל.`,
      );
    }

    if (!checkoutPage.csrfToken) {
      throw new Error('לא נמצא אסימון CSRF בדף הקופה של שופרסל');
    }
    this.csrfToken = checkoutPage.csrfToken;

    return {
      threeDSecureEnabled:
        checkoutPage.threeDSecureEnabled === undefined
          ? checkoutPage.paymeScriptUrls.length > 0
          : checkoutPage.threeDSecureEnabled === 'true',
      threeDSecureTestMode: checkoutPage.threeDSecureTestMode === 'true',
      paymeScriptUrls: checkoutPage.paymeScriptUrls,
    };
  }

  private async getPaymeClientHash(config: CheckoutAuthConfig): Promise<string> {
    if (!config.threeDSecureEnabled || !this.page) return '';
    if (config.paymeScriptUrls.length === 0) return '';

    const hash = await withTimeout(
      this.page.evaluate(
        async (scriptUrls, isTestMode) => {
          if (!window.PayMe) {
            for (const src of scriptUrls) {
              await new Promise<void>((resolve, reject) => {
                const script = document.createElement('script');
                script.src = src;
                script.onload = () => resolve();
                script.onerror = () => reject(new Error(`Failed loading ${src}`));
                document.head.appendChild(script);
              });
            }
          }
          const data = await window.PayMe?.clientData(isTestMode);
          return data?.hash ?? '';
        },
        config.paymeScriptUrls,
        config.threeDSecureTestMode,
      ),
      this.outerEvaluateTimeoutMs,
      'טעינת אימות PayMe בשופרסל ארכה יותר מדי זמן',
    );

    return encodeURIComponent(hash);
  }

  private async getComposedCheckout(): Promise<{
    directCart: {
      entries: Array<{
        entryNumber: number;
        outOfStock?: boolean;
        product: {
          code: string;
          stock?: { stockLevelStatus?: { code?: string } };
        };
      }>;
      consignments?: Array<{ timeSlotStartTime: number | null }>;
    };
  }> {
    const data = await this.apiRequest<{
      directCart?: {
        entries: Array<{
          entryNumber: number;
          outOfStock?: boolean;
          product: {
            code: string;
            stock?: { stockLevelStatus?: { code?: string } };
          };
        }>;
        consignments?: Array<{ timeSlotStartTime: number | null }>;
      };
    }>({
      method: 'GET',
      path: '/checkout/composed',
    });

    if (!data?.directCart) {
      throw new Error('לא ניתן היה לטעון את נתוני הקופה משופרסל (/checkout/composed)');
    }
    return { directCart: data.directCart };
  }

  private async getCSRFToken(): Promise<string> {
    if (this.csrfToken) return this.csrfToken;
    if (!this.page) throw new Error('Browser page not initialized');

    const handle = await withTimeout(
      this.page.waitForFunction(
        () => window.ACC?.config?.CSRFToken,
        { timeout: 10_000 },
      ),
      12_000,
      'Shufersal CSRFToken wait timed out',
    );
    const token = await withTimeout(
      handle.jsonValue(),
      5_000,
      'Shufersal CSRFToken read timed out',
    );
    await handle.dispose().catch(() => {});
    if (!token) {
      throw new Error('CSRFToken not found on Shufersal page');
    }
    this.csrfToken = token;
    return token;
  }

  private async apiRequest<T>(options: ApiRequestOptions): Promise<T | undefined> {
    return (await this.sendRequest(options, 'json')) as T | undefined;
  }

  private async pageRequest(
    relOrFullPath: string,
  ): Promise<{ url: string; html: string } | undefined> {
    const normalizedPath = relOrFullPath.startsWith('/online/he')
      ? relOrFullPath.slice('/online/he'.length)
      : relOrFullPath;
    return (await this.sendRequest(
      { method: 'GET', path: normalizedPath },
      'page',
    )) as { url: string; html: string } | undefined;
  }

  private async cartRequest(options: ApiRequestOptions): Promise<CartState> {
    const rawPage = (await this.sendRequest(options, 'cart')) as
      | RawCartPage
      | undefined;
    if (!rawPage) {
      throw new Error(
        `שופרסל לא החזיר את תוכן העגלה עבור ${options.method} ${options.path.split('?')[0]}`,
      );
    }
    return rawCartPageToCartState(rawPage);
  }

  private async sendRequest(
    options: ApiRequestOptions,
    format: ResponseFormat,
  ): Promise<unknown> {
    const fetchTimeoutMs = this.requestTimeoutMs;
    const outerTimeoutMs = this.outerEvaluateTimeoutMs;
    const shortPath = options.path.split('?')[0];

    const executeOnce = async (): Promise<unknown> => {
      if (!this.page) throw new Error('Browser page not initialized');
      const csrfToken =
        options.method === 'POST' ? await this.getCSRFToken() : undefined;

      const fullUrl = options.path.startsWith('http')
        ? options.path
        : `${WEBAPP_URL}${options.path}`;

      try {
        const result = await withTimeout(
          this.page.evaluate(
            async (url, method, body, form, csrf, responseFormat, timeoutMs) => {
              const headers: Record<string, string> = {
                accept:
                  responseFormat === 'json'
                    ? 'application/json, text/plain, */*'
                    : 'text/html, */*; q=0.01',
                'x-requested-with': 'XMLHttpRequest',
              };

              if (form) {
                headers['content-type'] =
                  'application/x-www-form-urlencoded; charset=UTF-8';
              } else if (body !== undefined) {
                headers['content-type'] = 'application/json';
              }

              if (csrf) {
                headers['csrftoken'] = csrf;
              }

              let requestBody: string | undefined;
              if (form) {
                requestBody = new URLSearchParams(form).toString();
              } else if (body !== undefined) {
                requestBody = JSON.stringify(body);
              }

              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), timeoutMs);

              try {
                const response = await fetch(url, {
                  method,
                  headers,
                  body: requestBody,
                  mode: 'cors',
                  credentials: 'include',
                  redirect: responseFormat === 'page' ? 'follow' : 'manual',
                  signal: controller.signal,
                });

                if (
                  response.type === 'opaqueredirect' ||
                  (response.status >= 300 && response.status < 400)
                ) {
                  const loc = response.headers.get('location') ?? '';
                  if (loc.includes('/login') || response.type === 'opaqueredirect') {
                    throw new Error('REDIRECT_TO_LOGIN');
                  }
                }

                if (!response.ok) {
                  const errText = (await response.text().catch(() => '')).slice(0, 300);
                  throw new Error(
                    `HTTP ${String(response.status)} ${response.statusText}: ${errText}`,
                  );
                }

                const contentType = response.headers.get('content-type') ?? '';

                if (responseFormat === 'cart') {
                  const html = await response.text();
                  const doc = new DOMParser().parseFromString(html, 'text/html');
                  const articles = Array.from(
                    doc.querySelectorAll('article[data-product-code]'),
                  ).map((el) => {
                    const priceText =
                      (
                        el.querySelector('.miglog-prod-totalPrize')?.textContent ?? ''
                      ).trim() || '0';

                    const nameFromDom =
                      el.querySelector('.miglog-prod-name, .text.description, h3, h4')
                        ?.textContent?.trim() ||
                      el.querySelector('img')?.getAttribute('alt')?.trim() ||
                      undefined;

                    return {
                      productCode: el.getAttribute('data-product-code') ?? '',
                      productName: nameFromDom,
                      quantity: parseFloat(el.getAttribute('data-entry-qty') ?? '0'),
                      entryNumber: parseInt(
                        el.getAttribute('data-entry-number') ?? '0',
                        10,
                      ),
                      itemPrice: parseFloat(priceText.replace(/[^\d.]/g, '')) || 0,
                      isOutOfStock: el.classList.contains(
                        'miglog-cart-prod-notInStock',
                      ),
                      sellingMethod:
                        el.getAttribute('data-selling-method') ?? undefined,
                    };
                  });

                  const modificationsScript =
                    Array.from(doc.querySelectorAll('script'))
                      .map((s) => s.textContent ?? '')
                      .find((t) => t.includes('miglog.cart.modifications')) ?? null;

                  return {
                    articles,
                    bodyText: doc.body?.textContent ?? '',
                    modificationsScript,
                  };
                }

                if (responseFormat === 'page') {
                  return {
                    url: response.url,
                    html: await response.text(),
                  };
                }

                if (contentType.includes('application/json')) {
                  return (await response.json()) as unknown;
                }
                const rawText = await response.text();
                try {
                  return JSON.parse(rawText) as unknown;
                } catch {
                  return undefined;
                }
              } catch (fetchErr) {
                if (
                  controller.signal.aborted ||
                  (fetchErr instanceof Error && fetchErr.name === 'AbortError')
                ) {
                  throw new Error('SHUFERSAL_REQUEST_TIMEOUT');
                }
                throw fetchErr;
              } finally {
                clearTimeout(timer);
              }
            },
            fullUrl,
            options.method,
            options.body,
            options.form,
            csrfToken,
            format,
            fetchTimeoutMs,
          ),
          outerTimeoutMs,
          `שופרסל לא הגיב תוך ${Math.ceil(fetchTimeoutMs / 1000)} שניות (${options.method} ${shortPath})`,
        );

        return result;
      } catch (err) {
        if (err instanceof TimeoutError) {
          logger.warn(
            `Shufersal Chromium page.evaluate hung on ${options.method} ${shortPath} (${outerTimeoutMs}ms); resetting browser session`,
          );
          await this.closeSessionOnly();
          throw err;
        }
        if (err instanceof Error && err.message.includes('SHUFERSAL_REQUEST_TIMEOUT')) {
          throw new TimeoutError(
            `שופרסל לא הגיב תוך ${Math.ceil(fetchTimeoutMs / 1000)} שניות (${options.method} ${shortPath})`,
            fetchTimeoutMs,
          );
        }
        throw err;
      }
    };

    try {
      return await executeOnce();
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes('REDIRECT_TO_LOGIN') ||
          err.message.includes('HTTP 401') ||
          err.message.includes('HTTP 403'))
      ) {
        logger.info('Shufersal session expired mid-request; re-authenticating...');
        await this.performLogin();
        return await executeOnce();
      }
      throw err;
    }
  }

  private async captureErrorScreenshot(tag: string): Promise<string | null> {
    if (!this.page) return null;
    try {
      const filename = `${tag}-${Date.now()}.png`;
      const fullPath = path.join(this.options.screenshotsDir, filename);
      await withTimeout(
        this.page.screenshot({ path: fullPath }),
        CLOSE_TIMEOUT_MS,
        'Shufersal error screenshot timed out',
      );
      logger.info(`Saved diagnostic screenshot: ${fullPath}`);
      return fullPath;
    } catch {
      return null;
    }
  }

  private async closeSessionOnly(): Promise<void> {
    const ctx = this.context;
    this.context = null;
    this.page = null;
    this.csrfToken = undefined;
    if (ctx) {
      try {
        await withTimeout(
          ctx.close(),
          CLOSE_TIMEOUT_MS,
          'Timed out closing Shufersal browser context',
        );
      } catch {
        // Ignore disconnect or close timeout errors
      }
    }
  }

  async shutdown(): Promise<void> {
    await this.closeSessionOnly();
    const browser = this.browser;
    this.browser = null;
    if (browser && !this.options.browserWsEndpoint) {
      try {
        await withTimeout(
          browser.close(),
          CLOSE_TIMEOUT_MS,
          'Timed out closing Shufersal browser process',
        );
      } catch {
        // Ignore browser shutdown errors
      }
    }
  }
}
