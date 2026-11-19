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

export class GroceryAiService {
  private readonly ai: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model: string = 'gemini-2.5-flash',
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async parseGroupMessage(messageText: string): Promise<ParsedMessageResult> {
    const trimmed = messageText.trim();
    if (!trimmed || trimmed.startsWith('/')) {
      return { isGroceryRelated: false, items: [] };
    }

    const systemInstruction = `אתה עוזר קניות חכם בקבוצת טלגרם משפחתית המחוברת לשופרסל אונליין.
תפקידך לנתח הודעות בעברית של משתתפי הקבוצה ולהחליט:
1. האם ההודעה היא בקשה להוסיף, לעדכן או להסיר מצרכים מרשימת הקניות (isGroceryRelated = true), או סתם שיחה כללית בקבוצה כמו "בוקר טוב", "תודה", "מתי המשלוח מגיע?" (isGroceryRelated = false).
2. עבור כל מצרך שמוזכר בהודעה:
   - searchQuery: שאילתת חיפוש נקייה ומדויקת לקטלוג שופרסל בעברית (למשל: "חלב תנובה 3%", "קוטג 5%", "עגבניות", "לחם פרוס אחיד"). אל תכלול בשאילתה מילות בקשה כמו "תביא", "צריך", "עוד" או את הכמות של מספר היחידות.
   - הבחנה חשובה בין גודל אריזה לבין משקל שקילה:
     • מוצר ארוז שמצוין משקל האריזה שלו (למשל "גבינה לבנה 500 גרם" או "חומוס אחלה 400 גרם"): השאר את המשקל כחלק מ-searchQuery, קבע unitPreference="UNIT" ו-quantity=1 (או מספר האריזות המבוקש).
     • ירקות/פירות/בשר במשקל (למשל "חצי קילו עגבניות", "1.5 קילו תפוחי אדמה", "300 גרם גבינה צהובה במעדנייה"): קבע searchQuery לשם המוצר בלבד ("עגבניות"), unitPreference="WEIGHT", ו-quantity בקילוגרמים (למשל 0.5 עבור חצי קילו / 500 גרם).
   - action:
     • "add" – ברירת מחדל להוספת מצרך (כולל "צריך חלב", "תוסיפו 2 חלב", "עוד חלב").
     • "set" – רק כשמבקשים לקבוע כמות סופית מוחלטת ("שיהיה סה״כ 3 חלב", "תשנו ל-2 קוטג'").
     • "remove" – כשמבקשים להוריד/לבטל מוצר מהעגלה ("תורידו את החלב", "לבטל לחם", "בסוף לא צריך ביצים").
   - pickerComment: הערה למלקט אם צוינה (למשל "ירוקות", "בשלות", "פרוס דק"), אחרת מחרוזת ריקה.`;

    try {
      const response = await this.ai.models.generateContent({
        model: this.model,
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

    if (available.length === 1) {
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
      name: c.name,
      brand: c.brandName,
      unitDescription: c.unitDescription,
      sellingMethod: c.sellingMethod,
      price: c.price,
      category: c.categoryName,
      isLearnedHouseholdFavorite: c.code === params.learnedProductCode,
    }));

    const prompt = JSON.stringify(
      {
        userRequest: {
          rawText: params.request.rawText,
          searchQuery: params.request.searchQuery,
          requestedQuantity: params.request.quantity,
          unitPreference: params.request.unitPreference,
        },
        candidatesSortedByPurchaseHistory: compactCandidates,
      },
      null,
      2,
    );

    const systemInstruction = `אתה בוחר את המוצר המדויק ביותר מתוך תוצאות החיפוש של שופרסל אונליין.
כללים:
1. הרשימה מסודרת כבר לפי היסטוריית הרכישות של המשפחה בשופרסל (historyRank=1 נקנה הכי הרבה בעבר).
2. אם מוצר מסומן ב-isLearnedHouseholdFavorite=true והוא מתאים לבקשה (למשל המשפחה לא ביקשה מותג אחר במפורש), העדף אותו!
3. אחרת, העדף את המוצר בעל historyRank נמוך שבאמת תואם למה שהמשתמש ביקש (למשל אם ביקשו "חלב", בחר חלב רגיל 3% ולא משקה שוקו או חלב שקדים, אלא אם כן זה מה שביקשו).
4. התאמת כמות (adjustedQuantity):
   - אם המשתמש ביקש משקל (למשל 0.5 ק"ג עגבניות שרי, unitPreference="WEIGHT"), אבל המוצר הנבחר נמכר לפי יחידה/מארז ארוז של ~500 גרם (sellingMethod="BY_UNIT"), המר את הכמות למספר שלם של יחידות מתאים (למשל 1).
   - אם המוצר נמכר ב-BY_UNIT או BY_PACKAGE, adjustedQuantity חייב להיות מספר שלם >= 1.
   - אם המוצר נמכר ב-BY_WEIGHT והמשתמש ביקש למשל "4 מלפפונים" (unitPreference="UNIT"), הערך משקל הגיוני בק"ג (למשל 0.5 ק"ג).`;

    try {
      const response = await this.ai.models.generateContent({
        model: this.model,
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

      const chosen =
        available.find((c) => c.code === parsed?.selectedCode) ??
        available.find((c) => c.code === params.learnedProductCode) ??
        available[0]!;

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
      logger.warn('Gemini selectBestProduct failed; using top ranked candidate', err);
      const fallback =
        available.find((c) => c.code === params.learnedProductCode) ??
        available[0]!;
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
