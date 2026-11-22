export type StoreId = 'shufersal' | 'hazi_hinam' | 'super_haviv' | 'victory';

export const ALL_STORE_IDS: readonly StoreId[] = [
  'shufersal',
  'hazi_hinam',
  'super_haviv',
  'victory',
] as const;

export interface StoreMeta {
  id: StoreId;
  displayName: string;
  shortName: string;
  emoji: string;
  baseUrl: string;
  cartUrl: string;
  defaultDeliveryFee: number | null;
  minimumOrderAmount: number | null;
  supportsAutoCheckout: boolean;
  supportsOrderUpdate: boolean;
}

export const STORE_META: Record<StoreId, StoreMeta> = {
  shufersal: {
    id: 'shufersal',
    displayName: 'שופרסל אונליין',
    shortName: 'שופרסל',
    emoji: '🔴',
    baseUrl: 'https://www.shufersal.co.il/online/he',
    cartUrl: 'https://www.shufersal.co.il/online/he/cart',
    defaultDeliveryFee: 29.9,
    minimumOrderAmount: null,
    supportsAutoCheckout: true,
    supportsOrderUpdate: true,
  },
  hazi_hinam: {
    id: 'hazi_hinam',
    displayName: 'חצי חינם אונליין',
    shortName: 'חצי חינם',
    emoji: '🟢',
    baseUrl: 'https://shop.hazi-hinam.co.il',
    cartUrl: 'https://shop.hazi-hinam.co.il/cart',
    defaultDeliveryFee: 29.9,
    minimumOrderAmount: 200,
    supportsAutoCheckout: false,
    supportsOrderUpdate: false,
  },
  super_haviv: {
    id: 'super_haviv',
    displayName: 'סופר חביב אונליין',
    shortName: 'סופר חביב',
    emoji: '🔵',
    baseUrl: 'https://www.superhaviv.co.il',
    cartUrl: 'https://www.superhaviv.co.il/cart',
    defaultDeliveryFee: 34,
    minimumOrderAmount: 200,
    supportsAutoCheckout: false,
    supportsOrderUpdate: false,
  },
  victory: {
    id: 'victory',
    displayName: 'ויקטורי אונליין',
    shortName: 'ויקטורי',
    emoji: '🟠',
    baseUrl: 'https://www.victoryonline.co.il',
    cartUrl: 'https://www.victoryonline.co.il/cart',
    defaultDeliveryFee: 35.9,
    minimumOrderAmount: 250,
    supportsAutoCheckout: false,
    supportsOrderUpdate: false,
  },
};

export function isStoreId(value: string): value is StoreId {
  return (
    value === 'shufersal' ||
    value === 'hazi_hinam' ||
    value === 'super_haviv' ||
    value === 'victory'
  );
}

export type SellingMethodCode = 'BY_UNIT' | 'BY_WEIGHT' | 'BY_PACKAGE';

export interface CatalogProduct {
  code: string;
  storeId?: StoreId;
  barcode?: string | null;
  name: string;
  brandName: string | null;
  unitDescription: string | null;
  sellingMethod: SellingMethodCode;
  price: number;
  formattedPrice: string;
  pricePerUnitText: string | null;
  promotionMsg: string | null;
  inStock: boolean;
  purchasable: boolean;
  categoryName: string | null;
  imageUrl: string | null;
}

export interface CartItem {
  entryNumber: number;
  productCode: string;
  productName?: string;
  quantity: number;
  itemPrice: number;
  inStock: boolean;
  sellingMethod?: SellingMethodCode;
  unitDescription?: string | null;
  requestedBy?: string[];
}

export interface CartModification {
  productCode: string;
  statusCode: string;
  entryNumber: number | null;
  quantity: number | null;
}

export interface CartState {
  storeId?: StoreId;
  items: CartItem[];
  totalPrice: number;
  deliveryFee?: number | null;
  orderInUpdateMode: string | null;
  modifications?: CartModification[];
  isGuestSession?: boolean;
}

export interface AddCartItemInput {
  productCode: string;
  quantity: number;
  sellingMethod: SellingMethodCode;
  comment?: string;
}

export interface DeliverySlot {
  code: string;
  startIso: string;
  endIso: string | null;
  startHourText: string;
  endHourText: string | null;
  deliveryFee: number | null;
  selectable: boolean;
  isToday: boolean;
  rawSlot: Record<string, unknown>;
}

export interface ActiveOrderSummary {
  code: string;
  deliveryIso: string;
  deliveryHoursText: string | null;
  updatableUntilText: string | null;
  totalPrice: number;
  totalItems: number;
  statusCode: string;
  isUpdatable: boolean;
  isBeingUpdated: boolean;
}

export interface CheckoutResult {
  storeId?: StoreId;
  orderCode: string;
  deliveryIso: string;
  totalPrice: number;
  wasOrderUpdate: boolean;
  removedOutOfStockCodes: string[];
}

export interface SerializedSessionCookies {
  savedAt: string;
  cookies: unknown[];
}

export class StoreAuthError extends Error {
  public readonly storeId: StoreId;

  constructor(
    storeId: StoreId,
    message = 'פרטי ההתחברות לחנות שגויים',
  ) {
    super(message);
    this.name = 'StoreAuthError';
    this.storeId = storeId;
  }
}

export class StoreManualVerificationRequiredError extends Error {
  public readonly storeId: StoreId;
  public readonly reason: 'OTP' | '3DS' | 'SECURITY_GATE' | 'MANUAL_CHECKOUT';
  public readonly actionUrl: string;

  constructor(
    storeId: StoreId,
    reason: 'OTP' | '3DS' | 'SECURITY_GATE' | 'MANUAL_CHECKOUT',
    message: string,
    actionUrl?: string,
  ) {
    super(message);
    this.name = 'StoreManualVerificationRequiredError';
    this.storeId = storeId;
    this.reason = reason;
    this.actionUrl = actionUrl ?? STORE_META[storeId].cartUrl;
  }
}

export interface StoreClient {
  readonly storeId: StoreId;
  readonly meta: StoreMeta;

  searchProducts(query: string, limit?: number): Promise<CatalogProduct[]>;
  getCartState(): Promise<CartState>;
  setItemsInCart(items: AddCartItemInput[]): Promise<CartState>;
  updateCartItemQuantity(
    productCode: string,
    quantity: number,
    entryNumber?: number,
  ): Promise<CartState>;
  removeFromCart(productCode: string, entryNumber?: number): Promise<CartState>;
  clearCart(): Promise<void>;
  getAvailableTimeSlots(): Promise<DeliverySlot[]>;
  getSelectedTimeSlot(): Promise<DeliverySlot | null>;
  selectTimeSlot(slotCode: string): Promise<DeliverySlot>;
  getActiveOrders(): Promise<ActiveOrderSummary[]>;
  putOrderInUpdateMode(orderCode: string): Promise<CartState>;
  placeOrder(options: { removeMissingItems: boolean }): Promise<CheckoutResult>;
  getAuthWarning?(): string | null;
  shutdown(): Promise<void>;
}

export interface StoreCartQuote {
  storeId: StoreId;
  meta: StoreMeta;
  cart: CartState | null;
  selectedSlot: DeliverySlot | null;
  inStockCount: number;
  outOfStockCount: number;
  expectedItemsCount: number;
  missingItemsCount: number;
  subtotal: number;
  deliveryFee: number;
  estimatedTotal: number;
  belowMinimum: boolean;
  minimumOrderAmount: number | null;
  isGuestSession: boolean;
  error: string | null;
}

export interface CartComparisonResult {
  quotes: StoreCartQuote[];
  cheapestStoreId: StoreId | null;
  cheapestCompleteStoreId: StoreId | null;
  savingsVsSecondCheapest: number;
  savingsVsMostExpensive: number;
}
