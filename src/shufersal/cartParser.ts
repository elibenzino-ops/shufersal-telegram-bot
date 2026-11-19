import type { CartItem, CartModification, CartState } from './types.js';

export interface RawCartArticle {
  productCode: string;
  productName?: string;
  quantity: number;
  entryNumber: number;
  itemPrice: number;
  isOutOfStock: boolean;
  sellingMethod?: string;
}

export interface RawCartPage {
  articles: RawCartArticle[];
  bodyText: string;
  modificationsScript: string | null;
}

type ScriptValue = string | number | boolean;

const MODIFICATIONS_START = /miglog\.cart\.modifications\s*=\s*\[/;
const SCRIPT_TOKEN =
  /[{}\]]|(\w+)\s*:\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|[^,}\s]+)/;

function parseScriptValue(literal: string): ScriptValue {
  const quote = literal[0];
  if ((quote === "'" || quote === '"') && literal.endsWith(quote)) {
    return literal.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  if (literal === 'true' || literal === 'false') {
    return literal === 'true';
  }
  const num = Number(literal);
  return Number.isNaN(num) ? literal : num;
}

function parseScriptObjects(
  script: string,
  startIndex: number,
): Record<string, ScriptValue>[] {
  const objects: Record<string, ScriptValue>[] = [];
  let current: Record<string, ScriptValue> | null = null;
  const tokenPattern = new RegExp(SCRIPT_TOKEN.source, 'g');
  tokenPattern.lastIndex = startIndex;

  for (
    let match = tokenPattern.exec(script);
    match;
    match = tokenPattern.exec(script)
  ) {
    const [token, key, value] = match;
    if (key && value) {
      if (current) {
        current[key] = parseScriptValue(value);
      }
    } else if (token === '{') {
      current = {};
    } else if (token === '}') {
      if (current) {
        objects.push(current);
      }
      current = null;
    } else if (!current) {
      break;
    }
  }

  return objects;
}

export function parseCartModifications(script: string): CartModification[] {
  const start = MODIFICATIONS_START.exec(script);
  if (!start) {
    return [];
  }

  return parseScriptObjects(script, start.index + start[0].length).map((raw) => ({
    productCode: String(raw['productCode'] ?? ''),
    statusCode: String(raw['statusCode'] ?? 'unknown'),
    entryNumber: typeof raw['entry'] === 'number' ? raw['entry'] : null,
    quantity: typeof raw['quantity'] === 'number' ? raw['quantity'] : null,
  }));
}

export function parseOrderInUpdateMode(text: string): string | null {
  const match = /עדכון הזמנה מס[׳']?\s*(\d+)/.exec(text);
  return match?.[1] ?? null;
}

const CONFIRMATION_URL_ORDER_CODE_PATTERNS = [
  /\/orderConfirmation\/(\d{6,})/,
  /[?&]orderCode=(\d{6,})/,
];

const CONFIRMATION_HTML_ORDER_CODE_PATTERNS = [
  /\/my-account\/orders?\/(\d{6,})/,
  /\/orderConfirmation\/(\d{6,})/,
  /["']?(?:orderCode|orderNumber|transaction_?[iI]d)["']?\s*[:=]\s*["']?(\d{6,})/,
  /(?:מספר\s+(?:ה)?הזמנה|הזמנה\s+מס(?:פר|['׳.])?)\D{0,30}(\d{6,})/,
];

export function parseOrderCodeFromConfirmation(
  url: string,
  html: string,
): string | null {
  for (const pattern of CONFIRMATION_URL_ORDER_CODE_PATTERNS) {
    const match = pattern.exec(url);
    if (match?.[1]) {
      return match[1];
    }
  }
  for (const pattern of CONFIRMATION_HTML_ORDER_CODE_PATTERNS) {
    const match = pattern.exec(html);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export function rawCartPageToCartState(page: RawCartPage): CartState {
  const items: CartItem[] = page.articles.map((article) => ({
    entryNumber: article.entryNumber,
    productCode: article.productCode,
    productName: article.productName || undefined,
    quantity: article.quantity,
    itemPrice: article.itemPrice,
    inStock: !article.isOutOfStock,
    sellingMethod:
      article.sellingMethod === 'BY_WEIGHT' ||
      article.sellingMethod === 'BY_PACKAGE' ||
      article.sellingMethod === 'BY_UNIT'
        ? article.sellingMethod
        : undefined,
  }));

  const totalPrice = Number(
    items
      .filter((i) => i.inStock)
      .reduce((sum, item) => sum + item.itemPrice, 0)
      .toFixed(2),
  );

  return {
    items,
    totalPrice,
    orderInUpdateMode: parseOrderInUpdateMode(page.bodyText),
    modifications: page.modificationsScript
      ? parseCartModifications(page.modificationsScript)
      : [],
  };
}
