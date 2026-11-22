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
const QUOTA_FALLBACK_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.0-flash-lite'];

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

export function extractRetryDelayMs(errorMessage: string): number | null {
  const secMatch = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i.exec(errorMessage);
  if (secMatch?.[1]) {
    const secs = Number(secMatch[1]);
    if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000);
  }
  const hmsMatch = /retry in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i.exec(
    errorMessage,
  );
  if (hmsMatch && (hmsMatch[1] || hmsMatch[2] || hmsMatch[3])) {
    const hours = Number(hmsMatch[1] ?? 0);
    const mins = Number(hmsMatch[2] ?? 0);
    const secs = Number(hmsMatch[3] ?? 0);
    const totalMs = Math.round((hours * 3600 + mins * 60 + secs) * 1000);
    if (totalMs > 0) return totalMs;
  }
  return null;
}

const HEBREW_MATCH_STOP_WORDS = new Set([
  'של',
  'עם',
  'ללא',
  'בלי',
  'טרי',
  'טריה',
  'טריים',
  'טריות',
  'ארוז',
  'ארוזה',
  'ארוזים',
  'מארז',
  'יחידה',
  'יחידות',
  'יח',
  'גרם',
  'קג',
  'קילו',
  'ליטר',
  'מל',
  'שופרסל',
  'רמי',
  'לוי',
  'חביב',
  'ויקטורי',
  'במשקל',
  'פיקוח',
  'בפיקוח',
  'ממשלתי',
  'מחיר',
]);

function tokenizeHebrewForMatch(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/["'״׳()[\],./\\|–—\-*+•:]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(
      (t) =>
        t.length >= 2 &&
        !/^\d+$/.test(t) &&
        !HEBREW_MATCH_STOP_WORDS.has(t),
    );
}

function tokenMatchesHaystack(token: string, hayTokens: string[], hayText: string): boolean {
  if (hayText.includes(token)) return true;
  // Handle Hebrew prefix letters (ה/ו/ב/ל/מ/כ) or plural suffix differences
  const stripped = token.replace(/^[הובלמכ](?=[\u0590-\u05ff]{2,})/, '');
  if (stripped.length >= 2 && hayText.includes(stripped)) return true;
  if (token.length >= 4) {
    const stem = stripped.slice(0, Math.max(3, stripped.length - 1));
    if (hayTokens.some((ht) => ht.startsWith(stem) || stem.startsWith(ht))) {
      return true;
    }
  }
  return false;
}

function scoreCandidateMatch(query: string, candidate: CatalogProduct): number {
  const reqTokens = tokenizeHebrewForMatch(query);
  if (reqTokens.length === 0) return 0;

  const hayText = `${candidate.name} ${candidate.brandName ?? ''} ${candidate.unitDescription ?? ''}`
    .toLowerCase()
    .replace(/["'״׳]/g, '');
  const hayTokens = tokenizeHebrewForMatch(hayText);

  let matchedWeight = 0;
  let totalWeight = 0;
  for (const tok of reqTokens) {
    // Percentages (e.g. 5%, 3%) and longer core Hebrew nouns carry higher weight
    const weight = tok.includes('%') ? 1.5 : tok.length >= 4 ? 1.2 : 1.0;
    totalWeight += weight;
    if (tokenMatchesHaystack(tok, hayTokens, hayText)) {
      matchedWeight += weight;
    }
  }

  let score = totalWeight > 0 ? matchedWeight / totalWeight : 0;

  // Penalize mismatching fat percentage when query explicitly requested a percentage (e.g. 3% vs 1%)
  const queryPercents: string[] = query.match(/\d+(?:\.\d+)?%/g) ?? [];
  const candPercents: string[] = hayText.match(/\d+(?:\.\d+)?%/g) ?? [];
  if (queryPercents.length > 0 && candPercents.length > 0) {
    const hasExactPercent = queryPercents.some((p) => candPercents.includes(p));
    if (!hasExactPercent) {
      score *= 0.45;
    }
  }

  return score;
}

export class GroceryAiService {
  private readonly ai: GoogleGenAI;
  private activeModel: string;
  private readonly unavailableModels = new Set<string>();
  private quotaExhaustedUntil = 0;
  private quotaWarningLoggedUntil = 0;

  constructor(apiKey: string, model: string = DEFAULT_GEMINI_MODEL) {
    this.ai = new GoogleGenAI({ apiKey });
    this.activeModel = model.trim() || DEFAULT_GEMINI_MODEL;
  }

  get currentModel(): string {
    return this.activeModel;
  }

  isQuotaExhausted(): boolean {
    return Date.now() < this.quotaExhaustedUntil;
  }

  private async generateWithAutoFallback(params: {
    contents: string;
    config: Record<string, unknown>;
  }) {
    if (this.isQuotaExhausted()) {
      throw new Error('GEMINI_QUOTA_COOLDOWN');
    }

    const tryCall = (modelName: string) =>
      this.ai.models.generateContent({
        model: modelName,
        contents: params.contents,
        config: params.config,
      });

    try {
      return await tryCall(this.activeModel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isModelNotFound =
        msg.includes('NOT_FOUND') ||
        msg.includes('404') ||
        msg.includes('no longer available');

      if (isModelNotFound) {
        this.unavailableModels.add(this.activeModel);
        const suggested =
          extractRecommendedGeminiModel(msg) ?? DEFAULT_GEMINI_MODEL;
        if (suggested && suggested !== this.activeModel && !this.unavailableModels.has(suggested)) {
          logger.warn(
            `Gemini model "${this.activeModel}" returned 404/NOT_FOUND; automatically switching to "${suggested}"`,
          );
          this.activeModel = suggested;
          return await tryCall(this.activeModel);
        }
      }

      const isQuotaError =
        msg.includes('429') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.toLowerCase().includes('quota');

      if (isQuotaError) {
        // Try a lite model with its own Free Tier quota bucket before entering cooldown
        for (const liteModel of QUOTA_FALLBACK_MODELS) {
          if (liteModel === this.activeModel || this.unavailableModels.has(liteModel)) {
            continue;
          }
          try {
            logger.warn(
              `Gemini model "${this.activeModel}" hit 429 quota limit; switching to "${liteModel}"`,
            );
            const res = await tryCall(liteModel);
            this.activeModel = liteModel;
            return res;
          } catch (liteErr) {
            const liteMsg = liteErr instanceof Error ? liteErr.message : String(liteErr);
            if (liteMsg.includes('404') || liteMsg.includes('NOT_FOUND')) {
              this.unavailableModels.add(liteModel);
            }
          }
        }

        const parsedDelay = extractRetryDelayMs(msg);
        // Cap cooldown at 30 minutes so recovery happens promptly if user upgrades billing/tier
        const cooldownMs = Math.min(
          Math.max(parsedDelay ?? 15 * 60_000, 60_000),
          30 * 60_000,
        );
        this.quotaExhaustedUntil = Date.now() + cooldownMs;
        if (Date.now() >= this.quotaWarningLoggedUntil) {
          this.quotaWarningLoggedUntil = this.quotaExhaustedUntil;
          const mins = Math.ceil(cooldownMs / 60_000);
          logger.warn(
            `Gemini API quota exhausted (429 RESOURCE_EXHAUSTED); using fast local Hebrew matching for the next ~${mins} minutes`,
          );
        }
        throw new Error('GEMINI_QUOTA_COOLDOWN');
      }

      throw err;
    }
  }

  async parseGroupMessage(messageText: string): Promise<ParsedMessageResult> {
    const trimmed = messageText.trim();
    if (!trimmed || trimmed.startsWith('/')) {
      return { isGroceryRelated: false, items: [] };
    }

    if (this.isQuotaExhausted()) {
      return this.fallbackParse(trimmed);
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
      if (!(err instanceof Error && err.message === 'GEMINI_QUOTA_COOLDOWN')) {
        logger.error('Gemini parseGroupMessage failed; using fallback line parser', err);
      }
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

    // 1. Exact cross-store barcode match (0ms, 0 Gemini quota)
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

    // 2. Learned household favorite present in available candidates (0ms, 0 Gemini quota)
    if (params.learnedProductCode) {
      const learnedMatch = available.find(
        (c) => c.code === params.learnedProductCode,
      );
      if (learnedMatch) {
        return {
          selected: learnedMatch,
          adjustedQuantity: this.normalizeQuantityForProduct(
            params.request,
            learnedMatch,
          ),
          alternatives: available
            .filter((c) => c.code !== learnedMatch.code)
            .slice(0, 4),
          reason: 'העדפה משפחתית שמורה',
        };
      }
    }

    // 3. Single candidate in non-strict mode (0ms, 0 Gemini quota)
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

    // 4. Fast deterministic Hebrew token scoring (saves ~85% of Gemini calls & prevents 429 during /mirror!)
    const scored = available
      .slice(0, 12)
      .map((c, idx) => ({
        product: c,
        idx,
        score: scoreCandidateMatch(params.request.searchQuery, c),
      }))
      .sort((a, b) => b.score - a.score || a.idx - b.idx);

    const top = scored[0]!;
    const second = scored[1];

    // If strictMatch has a strong unambiguous local winner (score >= 0.85 and ahead of #2 or high rank),
    // accept it locally without spending Gemini quota!
    if (
      top.score >= 0.85 &&
      (!second || top.score - second.score >= 0.2 || (top.idx === 0 && top.score >= 0.95))
    ) {
      return {
        selected: top.product,
        adjustedQuantity: this.normalizeQuantityForProduct(
          params.request,
          top.product,
        ),
        alternatives: available
          .filter((c) => c.code !== top.product.code)
          .slice(0, 4),
        reason: 'התאמה מדויקת מהירה',
      };
    }

    // If Gemini is currently in 429 quota cooldown, resolve locally in 0ms without hitting network
    if (this.isQuotaExhausted()) {
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
        alternatives: available
          .filter((c) => c.code !== fallback.code)
          .slice(0, 4),
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
      if (!(err instanceof Error && err.message === 'GEMINI_QUOTA_COOLDOWN')) {
        logger.warn('Gemini selectBestProduct failed; using fallback candidate check', err);
      }
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

    let best: CatalogProduct | null = null;
    let bestScore = 0;
    for (const cand of available) {
      const score = scoreCandidateMatch(request.searchQuery, cand);
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }

    if (strictMatch) {
      return bestScore >= 0.45 ? best : null;
    }
    return best && bestScore >= 0.25 ? best : (available[0] ?? null);
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
    // Ignore obvious non-grocery chat / questions / greetings when Gemini is unavailable
    if (
      text.endsWith('?') ||
      /^(בוקר טוב|ערב טוב|לילה טוב|שלום|היי|הי|תודה|סבבה|אוקיי|אוקי|בסדר|מעולה|מצוין|כן|לא|אחלה|מה נשמע|מה קורה)/i.test(
        text,
      )
    ) {
      return { isGroceryRelated: false, items: [] };
    }

    const lines = text
      .split(/[\n,]+/)
      .map((l) => l.trim())
      .filter((l) => l.length >= 2 && l.length <= 60);

    if (lines.length === 0) {
      return { isGroceryRelated: false, items: [] };
    }

    const items: ParsedGroceryItem[] = [];
    for (const rawLine of lines) {
      let line = rawLine;
      let action: 'add' | 'set' | 'remove' = 'add';
      if (/^(?:תורידו|תוריד|להוריד|תסירו|לבטל|בלי|לא צריך)\s+/i.test(line)) {
        action = 'remove';
        line = line.replace(
          /^(?:תורידו|תוריד|להוריד|תסירו|לבטל|בלי|לא צריך)\s+(?:את\s+)?/i,
          '',
        );
      } else {
        line = line.replace(
          /^(?:תוסיפו|תוסיף|להוסיף|צריך|צריכים|תביא|תביאו|עוד|קנה|לקנות)\s+(?:לי\s+|לנו\s+)?/i,
          '',
        );
      }

      let quantity = 1;
      let unitPreference: 'UNIT' | 'WEIGHT' = 'UNIT';

      const halfKgMatch = /^(?:חצי\s+ק(?:ילו|"ג|״ג)?)\s+(.+)$/i.exec(line);
      const weightMatch =
        /^(\d+(?:\.\d+)?)\s*(?:קילו|ק"ג|ק״ג|קג)\s+(.+)$/i.exec(line);
      const qtyMatch = /^(\d+(?:\.\d+)?)\s+(.+)$/.exec(line);

      let searchQuery = line.trim();
      if (halfKgMatch?.[1]) {
        quantity = 0.5;
        unitPreference = 'WEIGHT';
        searchQuery = halfKgMatch[1].trim();
      } else if (weightMatch?.[1] && weightMatch[2]) {
        quantity = Number(weightMatch[1]);
        unitPreference = 'WEIGHT';
        searchQuery = weightMatch[2].trim();
      } else if (qtyMatch?.[1] && qtyMatch[2]) {
        quantity = Number(qtyMatch[1]);
        unitPreference = Number.isInteger(quantity) ? 'UNIT' : 'WEIGHT';
        searchQuery = qtyMatch[2].trim();
      }

      if (searchQuery.length >= 2) {
        items.push({
          rawText: rawLine,
          searchQuery,
          action,
          quantity: quantity > 0 ? quantity : 1,
          unitPreference,
        });
      }
    }

    return { isGroceryRelated: items.length > 0, items };
  }
}
