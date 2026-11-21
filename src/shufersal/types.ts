import {
  StoreAuthError,
  StoreManualVerificationRequiredError,
  type SellingMethodCode,
} from '../stores/types.js';

export type ShufersalSellingMethodCode = SellingMethodCode;

export type {
  ActiveOrderSummary,
  AddCartItemInput,
  CartItem,
  CartModification,
  CartState,
  CatalogProduct,
  CheckoutResult,
  DeliverySlot,
  SerializedSessionCookies,
} from '../stores/types.js';

export class ShufersalAuthError extends StoreAuthError {
  constructor(message = 'פרטי ההתחברות לשופרסל שגויים (אימייל/ת.ז. או סיסמה)') {
    super('shufersal', message);
    this.name = 'ShufersalAuthError';
  }
}

export class ShufersalManualVerificationRequiredError extends StoreManualVerificationRequiredError {
  constructor(
    reason: 'OTP' | '3DS' | 'SECURITY_GATE',
    message: string,
    actionUrl = 'https://www.shufersal.co.il/online/he/cart',
  ) {
    super('shufersal', reason, message, actionUrl);
    this.name = 'ShufersalManualVerificationRequiredError';
  }
}
