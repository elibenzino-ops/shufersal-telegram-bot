import {
  SelfPointClient,
  type SelfPointClientOptions,
} from './selfPointClient.js';

export const VICTORY_BASE_URL = 'https://www.victoryonline.co.il';
export const VICTORY_RETAILER_ID = 1470;
// Default online fulfillment branch: Lod / Central Israel (covers Tel Aviv, Gush Dan, Petah Tikva, etc.)
export const VICTORY_DEFAULT_BRANCH_ID = 2427;

export type VictoryClientOptions = Omit<
  SelfPointClientOptions,
  'storeId' | 'envPrefix' | 'baseUrl' | 'retailerId' | 'branchId'
> & {
  baseUrl?: string;
  retailerId?: number;
  branchId?: number;
};

export class VictoryClient extends SelfPointClient {
  constructor(options: VictoryClientOptions) {
    super({
      ...options,
      storeId: 'victory',
      envPrefix: 'VICTORY',
      baseUrl: options.baseUrl ?? VICTORY_BASE_URL,
      retailerId: options.retailerId ?? VICTORY_RETAILER_ID,
      branchId: options.branchId ?? VICTORY_DEFAULT_BRANCH_ID,
    });
  }
}
