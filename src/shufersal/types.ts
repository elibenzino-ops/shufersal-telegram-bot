export type ShufersalSellingMethodCode = 'BY_UNIT' | 'BY_WEIGHT' | 'BY_PACKAGE';

export interface CatalogProduct {
  code: string;
  name: string;
  brandName: string | null;
  unitDescription: string | null;
  sellingMethod: ShufersalSellingMethodCode;
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
  sellingMethod?: ShufersalSellingMethodCode;
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
  items: CartItem[];
  totalPrice: number;
  orderInUpdateMode: string | null;
  modifications?: CartModification[];
}

export interface AddCartItemInput {
  productCode: string;
  quantity: number;
  sellingMethod: ShufersalSellingMethodCode;
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

export class ShufersalAuthError extends Error {
  constructor(message = 'פרטי ההתחברות לשופרסל שגויים (אימייל/ת.ז. או סיסמה)') {
    super(message);
    this.name = 'ShufersalAuthError';
  }
}

export class ShufersalManualVerificationRequiredError extends Error {
  public readonly reason: 'OTP' | '3DS' | 'SECURITY_GATE';
  public readonly actionUrl: string;

  constructor(
    reason: 'OTP' | '3DS' | 'SECURITY_GATE',
    message: string,
    actionUrl = 'https://www.shufersal.co.il/online/he/cart',
  ) {
    super(message);
    this.name = 'ShufersalManualVerificationRequiredError';
    this.reason = reason;
    this.actionUrl = actionUrl;
  }
}
