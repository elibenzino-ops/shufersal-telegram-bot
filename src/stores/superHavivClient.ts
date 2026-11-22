import {
  SelfPointClient,
  STANDARD_SELFPOINT_FILTERS,
  parseSelfPointCart,
  parseSelfPointProduct,
  type SelfPointClientOptions,
} from './selfPointClient.js';

export {
  STANDARD_SELFPOINT_FILTERS,
  parseSelfPointCart,
  parseSelfPointProduct,
};

export const SUPER_HAVIV_BASE_URL = 'https://www.superhaviv.co.il';
export const SUPER_HAVIV_RETAILER_ID = 1579;
export const SUPER_HAVIV_DEFAULT_BRANCH_ID = 3507;

export type SuperHavivClientOptions = Omit<
  SelfPointClientOptions,
  'storeId' | 'envPrefix' | 'baseUrl' | 'retailerId' | 'branchId'
> & {
  baseUrl?: string;
  retailerId?: number;
  branchId?: number;
};

export class SuperHavivClient extends SelfPointClient {
  constructor(options: SuperHavivClientOptions) {
    super({
      ...options,
      storeId: 'super_haviv',
      envPrefix: 'SUPER_HAVIV',
      baseUrl: options.baseUrl ?? SUPER_HAVIV_BASE_URL,
      retailerId: options.retailerId ?? SUPER_HAVIV_RETAILER_ID,
      branchId: options.branchId ?? SUPER_HAVIV_DEFAULT_BRANCH_ID,
    });
  }
}
