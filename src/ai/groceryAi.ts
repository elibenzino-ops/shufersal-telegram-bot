import { GoogleGenAI, Type } from '@google/genai';
import { logger } from '../logger.js';
import type { CatalogProduct } from '../shufersal/types.js';

export interface ParsedGroceryItem {
  rawText: string;
  searchQuery: string;
  action: 'add' | 'set' | 'remove';
  quantity: number;
  unitPreference: 'UNIT' | 'WEIGHT';
  pickerComment?: string;
}

export interface ParsedMessageResult {
  isGroceryRelated: boolean;
  items: ParsedGroceryItem[];
}

export interface ProductSelectionResult {
  selected: CatalogProduct | null;
  adjustedQuantity: number;
  alternatives: CatalogProduct[];
  reason?: string;
}

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

export function extractRecommendedGeminiModel(errorMessage: string): string | null {
  // Matches e.g. "Please update your code to use models/gemini-3.8-flash"
  const useMatch = /use\s+models\/([a-z0-9][a-z0-9._-]+)/i.exec(errorMessage);
  if (useMatch?.[1]) {
    return useMatch[1];
  }
  const allModels = [...errorMessage.matchAll(/models\/([a-z0-9][a-z0-9._-]+)/gi)];
  if (allModels.length >= 2) {
    return allModels[allModels.length - 1]?.[1] ?? null;
  }
  return null;
}

export class GroceryAiService {
  private readonly ai: GoogleGenAI;
  private activeModel: string;

  constructor(apiKey: string, model: string = DEFAULT_GEMINI_MODEL) {
    this.ai = new GoogleGenAI({ apiKey });
    this.activeModel = model.trim() || DEFAULT_GEMINI_MODEL;
  }

  get currentModel(): string {
    return this.activeModel;
  }

  private async generateWithAutoFallback(params: {
    contents: string;
    config: Record<string, unknown>;
  }) {
    try {
      return await this.ai.models.generateContent({
        model: this.activeModel,
        contents: params.contents,
        config: params.config,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isModelNotFound =
        msg.includes('NOT_FOUND') ||
        msg.includes('404') ||
        msg.includes('no longer available');
      if (isModelNotFound) {
        const suggested =
          extractRecommendedGeminiModel(msg) ?? DEFAULT_GEMINI_MODEL;
        if (suggested && suggested !== this.activeModel) {
          logger.warn(
            `Gemini model "${this.activeModel}" returned 404/NOT_FOUND; automatically switching to "${suggested}"`,
          );
          this.activeModel = suggested;
          return await this.ai.models.generateContent({
            model: this.activeModel,
            contents: params.contents,
            config: params.config,
          });
        }
      }
      throw err;
    }
  }

  async parseGroupMessage(messageText: string): Promise<ParsedMessageResult> {
    const trimmed = messageText.trim();
    if (!trimmed || trimmed.startsWith('/')) {
      return { isGroceryRelated: false, items: [] };
    }

    const systemInstruction = `אתה עוזר קניות חכם בקבוצת טלגרם משפחתית המחוברת לרשתות הסופרמרקטים בישראל (שופרסל, חצי חינם, סופר חביב וויקטורי).
תפקידך לנתח הודעות בעברית של משתתפי הקבוצה ולהחליט:
1. האם ההודעה היא בקשה להוסיף, לעדכן או להסיר מצרכים מרשימת הקניות (isGroceryRelated = true), או סתם שיחה כללית בקבוצה כמו "בוקר טוב", "תודה", "מתי המשלוח מגיע?" (isGroceryRelated = false).
2. עבור כל מצרך שמוזכר בהודעה:
   - searchQuery: שאילתת חיפוש נקייה ומדויקת לקטלוג סופרמרקט בעברית (למשל: "חלב תנובה 3%", "קוטג 5%", "עגבניות", "לחם פרוס אחיד"). אל תכלול בשאילתה מילות בקשה כמו "תביא", "צריך", "עוד" או את הכמות של מספר היחידות.
   - הבחנה חשובה בין גודל אריזה לבין משקל שקילה:
     • מוצר ארוז שמצוין משקל האריזה שלו (למשל "גבינה לבנה 500 גרם" או "חומוס אחלה 400 גרם"): השאר את המשקל כחלק מ-searchQuery, קבע unitPreference="UNIT" ו-quantity=1 (או מספר האריזות המבוקש).
     • ירקות/פירות/בשר במשקל (למשל "חצי קילו עגבניות", "1.5 קילו תפוחי אדמה", "300 גרם גבינה צהובה במעדנייה"): קבע searchQuery לשם המוצר בלבד ("עגבניות"), unitPreference="WEIGHT", ו-quantity בקילוגרמים (למשל 0.5 עבור חצי קילו / 500 גרם).
   - action:
     • "add" – ברירת מחדל להוספת מצרך (כולל "צריך חלב", "תוסיפו 2 חלב", "עוד חלב").
     • "set" – רק כשמבקשים לקבוע כמות סופית מוחלטת ("שיהיה סה״כ 3 חלב", "תשנו ל-2 קוטג'").
     • "remove" – כשמבקשים להוריד/לבטל מוצר מהעגלה ("תורידו את החלב", "לבטל לחם", "בסוף לא צריך ביצים").
   - pickerComment: הערה למלקט אם צוינה (למשל "ירוקות", "בשלות", "פרוס דק"), אחרת מחרוזת ריקה.`;

    try {
      const response = await this.generateWithAutoFallback({
        contents: trimmed,
        config: {
          systemInstruction,
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              isGroceryRelated: { type: Type.BOOLEAN },
              items: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    rawText: { type: Type.STRING },
                    searchQuery: { type: Type.STRING },
                    action: {
                      type: Type.STRING,
                      enum: ['add', 'set', 'remove'],
                    },
                    quantity: { type: Type.NUMBER },
                    unitPreference: {
                      type: Type.STRING,
                      enum: ['UNIT', 'WEIGHT'],
                    },
                    pickerComment: { type: Type.STRING },
                  },
                  required: [
                    'rawText',
                    'searchQuery',
                    'action',
                    'quantity',
                    'unitPreference',
                  ],
                },
              },
            },
            required: ['isGroceryRelated', 'items'],
          },
        },
      });

      const rawJson = response.text;
      if (!rawJson) {
        return { isGroceryRelated: false, items: [] };
      }

      const parsed = JSON.parse(rawJson) as ParsedMessageResult;
      const sanitizedItems = (parsed.items ?? [])
        .filter((i) => i.searchQuery && i.searchQuery.trim().length > 0)
        .map((i) => ({
          ...i,
          searchQuery: i.searchQuery.trim(),
          quantity: i.quantity > 0 ? i.quantity : 1,
          pickerComment: i.pickerComment?.trim() || undefined,
        }));

      return {
        isGroceryRelated: Boolean(parsed.isGroceryRelated && sanitizedItems.length > 0),
        items: sanitizedItems,
      };
    } catch (err) {
      logger.error('Gemini parseGroupMessage failed; using fallback line parser', err);
      return this.fallbackParse(trimmed);
    }
  }

  async selectBestProduct(params: {
    request: ParsedGroceryItem;
    candidates: CatalogProduct[];
    learnedProductCode?: string | null;
    preferredBarcode?: string | null;
    storeName?: string;
    strictMatch?: boolean;
  }): Promise<ProductSelectionResult> {
    const available = params.candidates.filter(
      (c) => c.inStock && c.purchasable,
    );

    if (available.length === 0) {
      return {
        selected: null,
        adjustedQuantity: params.request.quantity,
        alternatives: [],
      };
    }

    // If a store already matched a specific SKU barcode, prefer the exact same barcode across stores
    // (unless the user explicitly trained a different learned preference for this store)
    if (params.preferredBarcode && !params.learnedProductCode) {
      const exactBarcodeMatch = available.find(
        (c) => c.barcode && c.barcode === params.preferredBarcode,
      );
      if (exactBarcodeMatch) {
        return {
          selected: exactBarcodeMatch,
          adjustedQuantity: this.normalizeQuantityForProduct(
            params.request,
            exactBarcodeMatch,
          ),
          alternatives: available
            .filter((c) => c.code !== exactBarcodeMatch.code)
            .slice(0, 4),
          reason: `התאמת ברקוד זהה (${params.preferredBarcode}) להשוואה מדויקת בין הרשתות`,
        };
      }
    }

    // In non-strict interactive mode, a single candidate can be accepted directly;
    // in strictMatch mode (mirroring), always verify relevance so unrelated single hits are rejected.
    if (available.length === 1 && !params.strictMatch) {
      const only = available[0]!;
      return {
        selected: only,
        adjustedQuantity: this.normalizeQuantityForProduct(
          params.request,
          only,
        ),
        alternatives: [],
      };
    }

    const compactCandidates = available.slice(0, 12).map((c, idx) => ({
      historyRank: idx + 1,
      code: c.code,
      barcode: c.barcode ?? null,
      name: c.name,
      brand: c.brandName,
      unitDescription: c.unitDescription,
      sellingMethod: c.sellingMethod,
      price: c.price,
      category: c.categoryName,
      isLearnedHouseholdFavorite: c.code === params.learnedProductCode,
      matchesCrossStoreBarcode:
        Boolean(params.preferredBarcode && c.barcode === params.preferredBarcode),
    }));

    const prompt = JSON.stringify(
      {
        store: params.storeName ?? 'סופרמרקט אונליין',
        strictMatchMode: Boolean(params.strictMatch),
        userRequest: {
          rawText: params.request.rawText,
          searchQuery: params.request.searchQuery,
          requestedQuantity: params.request.quantity,
          unitPreference: params.request.unitPreference,
        },
        candidatesSortedByRelevance: compactCandidates,
      },
      null,
      2,
    );

    const storeLabel = params.storeName ?? 'הסופרמרקט';
    const strictRule = params.strictMatch
      ? `5. חשוב מאוד (מצב התאמה מדויקת להשוואת סלים): אם אף אחד מהמוצרים ברשימה אינו באמת אותו סוג מוצר שביקש המשתמש (למשל תוצאה מקטגוריה אחרת, מוצר מעובד במקום ירק טרי, או תוצאת חיפוש לא קשורה), החזר selectedCode="NO_MATCH"! עדיף לסמן מוצר כחסר מאשר להוסיף מוצר לא רלוונטי לעגלה.`
      : `5. אם אף אחד מהמוצרים ברשימה אינו קשור כלל למה שהמשתמש ביקש, החזר selectedCode="NO_MATCH".`;

    const systemInstruction = `אתה בוחר את המוצר המדויק ביותר מתוך תוצאות החיפוש של ${storeLabel}.
כללים:
1. אם מוצר מסומן ב-isLearnedHouseholdFavorite=true והוא מתאים לבקשה (למשל המשפחה לא ביקשה מותג אחר במפורש), העדף אותו!
2. אם מוצר מסומן ב-matchesCrossStoreBarcode=true והוא תואם לבקשה, העדף אותו כדי שההשוואה בין הרשתות תהיה על מוצר זהה לחלוטין.
3. אחרת, העדף את המוצר בעל historyRank נמוך שבאמת תואם למה שהמשתמש ביקש (למשל אם ביקשו "חלב", בחר חלב רגיל 3% ולא משקה שוקו או חלב שקדים, אלא אם כן זה מה שביקשו).
4. התאמת כמות (adjustedQuantity):
   - אם המשתמש ביקש משקל (למשל 0.5 ק"ג עגבניות שרי, unitPreference="WEIGHT"), אבל המוצר הנבחר נמכר לפי יחידה/מארז ארוז של ~500 גרם (sellingMethod="BY_UNIT"), המר את הכמות למספר שלם של יחידות מתאים (למשל 1).
   - אם המוצר נמכר ב-BY_UNIT או BY_PACKAGE, adjustedQuantity חייב להיות מספר שלם >= 1.
   - אם המוצר נמכר ב-BY_WEIGHT והמשתמש ביקש למשל "4 מלפפונים" (unitPreference="UNIT"), הערך משקל הגיוני בק"ג (למשל 0.5 ק"ג).
${strictRule}`;

    try {
      const response = await this.generateWithAutoFallback({
        contents: prompt,
        config: {
          systemInstruction,
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              selectedCode: { type: Type.STRING },
              adjustedQuantity: { type: Type.NUMBER },
              reason: { type: Type.STRING },
            },
            required: ['selectedCode', 'adjustedQuantity'],
          },
        },
      });

      const parsed = response.text
        ? (JSON.parse(response.text) as {
            selectedCode: string;
            adjustedQuantity: number;
            reason?: string;
          })
        : null;

      const rawCode = (parsed?.selectedCode ?? '').trim();
      if (
        !rawCode ||
        rawCode.toUpperCase() === 'NO_MATCH' ||
        rawCode.toUpperCase() === 'NONE' ||
        rawCode.toLowerCase() === 'null'
      ) {
        return {
          selected: null,
          adjustedQuantity: params.request.quantity,
          alternatives: available.slice(0, 4),
          reason: parsed?.reason ?? 'לא נמצא מוצר תואם ברשת זו',
        };
      }

      const chosen =
        available.find((c) => c.code === rawCode) ??
        (params.strictMatch
          ? undefined
          : available.find((c) => c.code === params.learnedProductCode) ??
            available[0]);

      if (!chosen) {
        return {
          selected: null,
          adjustedQuantity: params.request.quantity,
          alternatives: available.slice(0, 4),
          reason: parsed?.reason ?? 'לא נמצא מוצר תואם ברשת זו',
        };
      }

      const rawAdjQty =
        parsed?.adjustedQuantity && parsed.adjustedQuantity > 0
          ? parsed.adjustedQuantity
          : this.normalizeQuantityForProduct(params.request, chosen);

      const finalQty =
        chosen.sellingMethod === 'BY_WEIGHT'
          ? Math.max(0.1, Number(rawAdjQty.toFixed(2)))
          : Math.max(1, Math.round(rawAdjQty));

      const alternatives = available
        .filter((c) => c.code !== chosen.code)
        .slice(0, 4);

      return {
        selected: chosen,
        adjustedQuantity: finalQty,
        alternatives,
        reason: parsed?.reason,
      };
    } catch (err) {
      logger.warn('Gemini selectBestProduct failed; using fallback candidate check', err);
      const fallback = this.pickFallbackCandidate(
        params.request,
        available,
        params.learnedProductCode,
        Boolean(params.strictMatch),
      );
      if (!fallback) {
        return {
          selected: null,
          adjustedQuantity: params.request.quantity,
          alternatives: available.slice(0, 4),
        };
      }
      return {
        selected: fallback,
        adjustedQuantity: this.normalizeQuantityForProduct(
          params.request,
          fallback,
        ),
        alternatives: available.filter((c) => c.code !== fallback.code).slice(0, 4),
      };
    }
  }

  private pickFallbackCandidate(
    request: ParsedGroceryItem,
    available: CatalogProduct[],
    learnedProductCode?: string | null,
    strictMatch = false,
  ): CatalogProduct | null {
    const learned = available.find((c) => c.code === learnedProductCode);
    if (learned) return learned;
    if (!strictMatch) return available[0] ?? null;

    // In strict fallback (when AI is unavailable), require meaningful token overlap
    const reqTokens = request.searchQuery
      .toLowerCase()
      .replace(/[^\p{L}\p{N}%]+/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3);
    if (reqTokens.length === 0) return available[0] ?? null;

    let best: CatalogProduct | null = null;
    let bestScore = 0;
    for (const cand of available) {
      const hay = `${cand.name} ${cand.brandName ?? ''}`.toLowerCase();
      const hits = reqTokens.filter((t) => hay.includes(t)).length;
      const ratio = hits / reqTokens.length;
      if (hits > 0 && ratio > bestScore) {
        bestScore = ratio;
        best = cand;
      }
    }
    return bestScore >= 0.4 ? best : null;
  }

  private normalizeQuantityForProduct(
    request: ParsedGroceryItem,
    product: CatalogProduct,
  ): number {
    if (product.sellingMethod === 'BY_WEIGHT') {
      return Math.max(0.2, Number(request.quantity.toFixed(2)));
    }
    return Math.max(1, Math.round(request.quantity));
  }

  private fallbackParse(text: string): ParsedMessageResult {
    const lines = text
      .split(/[\n,]+/)
      .map((l) => l.trim())
      .filter((l) => l.length >= 2 && l.length <= 60);

    if (lines.length === 0) {
      return { isGroceryRelated: false, items: [] };
    }

    const items: ParsedGroceryItem[] = lines.map((line) => {
      const qtyMatch = /^(\d+(?:\.\d+)?)\s+(.+)$/.exec(line);
      const quantity = qtyMatch?.[1] ? Number(qtyMatch[1]) : 1;
      const searchQuery = qtyMatch?.[2] ? qtyMatch[2].trim() : line;
      return {
        rawText: line,
        searchQuery,
        action: 'add',
        quantity: quantity > 0 ? quantity : 1,
        unitPreference: Number.isInteger(quantity) ? 'UNIT' : 'WEIGHT',
      };
    });

    return { isGroceryRelated: true, items };
  }
}
