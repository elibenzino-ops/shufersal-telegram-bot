import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GEMINI_REQUEST_TIMEOUT_MS,
  GEMINI_TRANSIENT_COOLDOWN_MS,
  GroceryAiService,
  isGeminiTransientError,
} from '../src/ai/groceryAi.js';
import { createTelegramBot } from '../src/bot/telegramBot.js';
import type { AppConfig } from '../src/config.js';
import { ShufersalClient } from '../src/shufersal/client.js';
import { BotDatabase } from '../src/store/database.js';
import { HaziHinamClient } from '../src/stores/haziHinamClient.js';
import type { MultiStoreManager } from '../src/stores/multiStoreManager.js';
import { TimeoutError } from '../src/utils/timeout.js';

describe('Bot hang prevention & hard timeouts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shufersal-timeout-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GroceryAiService 12s timeout & 503 high-demand fallback/cooldown', () => {
    it('defaults to 12s request timeout and detects 503 UNAVAILABLE / high-demand errors', () => {
      expect(GEMINI_REQUEST_TIMEOUT_MS).toBe(12_000);
      expect(GEMINI_TRANSIENT_COOLDOWN_MS).toBe(60_000);
      expect(
        isGeminiTransientError(
          'ApiError: {"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}',
        ),
      ).toBe(true);
      expect(isGeminiTransientError('GEMINI_REQUEST_TIMEOUT: timed out')).toBe(
        true,
      );
      expect(isGeminiTransientError('invalid json')).toBe(false);
    });

    it('aborts hung Gemini calls at the timeout ceiling, falls back locally, and recovers after short cooldown', async () => {
      const ai = new GroceryAiService('dummy-key', 'gemini-3.8-flash', {
        requestTimeoutMs: 40,
        transientCooldownMs: 80,
      });

      let capturedSignal: AbortSignal | undefined;
      const mockGenerate = vi.fn(
        async (args: { config?: { abortSignal?: AbortSignal } }) => {
          capturedSignal = args.config?.abortSignal;
          return new Promise<never>(() => {
            // Intentionally never resolves to simulate hung Gemini HTTP socket
          });
        },
      );
      (
        ai as unknown as {
          ai: { models: { generateContent: typeof mockGenerate } };
        }
      ).ai = { models: { generateContent: mockGenerate } };

      const start = Date.now();
      const parsed = await ai.parseGroupMessage('תוסיפו 2 חלב תנובה');
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(400);
      expect(capturedSignal?.aborted).toBe(true);
      expect(ai.isTemporarilyUnavailable()).toBe(true);
      expect(ai.isInCooldown()).toBe(true);
      expect(ai.isQuotaExhausted()).toBe(false);
      expect(parsed.isGroceryRelated).toBe(true);
      expect(parsed.items[0]?.searchQuery).toBe('חלב תנובה');
      expect(parsed.items[0]?.quantity).toBe(2);

      // While in short cooldown, subsequent calls resolve locally in 0ms without hitting Gemini
      const callsAfterTimeout = mockGenerate.mock.calls.length;
      const duringCooldown = await ai.parseGroupMessage('לחם פרוס');
      expect(duringCooldown.isGroceryRelated).toBe(true);
      expect(mockGenerate.mock.calls.length).toBe(callsAfterTimeout);

      // After short cooldown expires, Gemini is retried and succeeds
      await new Promise((r) => setTimeout(r, 100));
      expect(ai.isTemporarilyUnavailable()).toBe(false);
      mockGenerate.mockResolvedValueOnce({
        text: JSON.stringify({
          isGroceryRelated: true,
          items: [
            {
              rawText: 'קוטג',
              searchQuery: 'קוטג 5%',
              action: 'add',
              quantity: 1,
              unitPreference: 'UNIT',
            },
          ],
        }),
      } as never);

      const recovered = await ai.parseGroupMessage('קוטג');
      expect(recovered.items[0]?.searchQuery).toBe('קוטג 5%');
      expect(mockGenerate.mock.calls.length).toBe(callsAfterTimeout + 1);
    });

    it('falls back to a lighter model on 503 UNAVAILABLE / high-demand and cools down the overloaded primary', async () => {
      const ai = new GroceryAiService('dummy-key', 'gemini-3.8-flash', {
        requestTimeoutMs: 500,
        transientCooldownMs: 5_000,
      });

      const calledModels: string[] = [];
      const mockGenerate = vi.fn(async (args: { model: string }) => {
        calledModels.push(args.model);
        if (args.model === 'gemini-3.8-flash') {
          throw new Error(
            '503 UNAVAILABLE: This model is currently experiencing high demand. Spikes in demand are usually temporary.',
          );
        }
        return {
          text: JSON.stringify({
            isGroceryRelated: true,
            items: [
              {
                rawText: 'חלב',
                searchQuery: 'חלב תנובה 3%',
                action: 'add',
                quantity: 1,
                unitPreference: 'UNIT',
              },
            ],
          }),
        };
      });
      (
        ai as unknown as {
          ai: { models: { generateContent: typeof mockGenerate } };
        }
      ).ai = { models: { generateContent: mockGenerate } };

      const first = await ai.parseGroupMessage('צריך חלב');
      expect(first.isGroceryRelated).toBe(true);
      expect(first.items[0]?.searchQuery).toBe('חלב תנובה 3%');
      expect(calledModels).toEqual(['gemini-3.8-flash', 'gemini-2.5-flash-lite']);
      expect(ai.isTemporarilyUnavailable()).toBe(false);

      // Next call skips the cooled-down primary model and goes straight to the healthy fallback
      const second = await ai.parseGroupMessage('עוד חלב');
      expect(second.isGroceryRelated).toBe(true);
      expect(calledModels).toEqual([
        'gemini-3.8-flash',
        'gemini-2.5-flash-lite',
        'gemini-2.5-flash-lite',
      ]);
    });

    it('activates short cooldown when all models return 503 UNAVAILABLE', async () => {
      const ai = new GroceryAiService('dummy-key', 'gemini-3.8-flash', {
        requestTimeoutMs: 500,
        transientCooldownMs: 5_000,
      });

      const mockGenerate = vi.fn(async () => {
        throw new Error('503 UNAVAILABLE: high demand');
      });
      (
        ai as unknown as {
          ai: { models: { generateContent: typeof mockGenerate } };
        }
      ).ai = { models: { generateContent: mockGenerate } };

      const res = await ai.parseGroupMessage('2 קוטג');
      expect(res.isGroceryRelated).toBe(true);
      expect(res.items[0]?.quantity).toBe(2);
      expect(ai.isTemporarilyUnavailable()).toBe(true);

      const callsAfterOutage = mockGenerate.mock.calls.length;
      await ai.parseGroupMessage('בוקר טוב');
      expect(mockGenerate.mock.calls.length).toBe(callsAfterOutage);
    });
  });

  describe('ShufersalClient.sendRequest hard timeouts', () => {
    it('rejects with TimeoutError and resets browser session when page.evaluate hangs', async () => {
      const client = new ShufersalClient({
        username: 'u',
        password: 'p',
        headless: true,
        sessionFilePath: path.join(tmpDir, 'shufersal-session.json'),
        screenshotsDir: tmpDir,
        requestTimeoutMs: 40,
      });

      const mockClose = vi.fn(async () => {});
      const mockPage = {
        isClosed: () => false,
        evaluate: vi.fn(() => new Promise(() => {})),
      };
      const mockContext = {
        close: mockClose,
      };

      const internal = client as unknown as {
        page: typeof mockPage | null;
        context: typeof mockContext | null;
        sendRequest: (
          opts: { method: 'GET' | 'POST'; path: string },
          format: 'json' | 'cart' | 'page',
        ) => Promise<unknown>;
      };
      internal.page = mockPage;
      internal.context = mockContext;

      const start = Date.now();
      await expect(
        internal.sendRequest({ method: 'GET', path: '/search/results?q=milk' }, 'json'),
      ).rejects.toBeInstanceOf(TimeoutError);
      expect(Date.now() - start).toBeLessThan(400);
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(internal.page).toBeNull();
      expect(internal.context).toBeNull();
    });

    it('converts in-page AbortController SHUFERSAL_REQUEST_TIMEOUT into TimeoutError without dropping session', async () => {
      const client = new ShufersalClient({
        username: 'u',
        password: 'p',
        headless: true,
        sessionFilePath: path.join(tmpDir, 'shufersal-session.json'),
        screenshotsDir: tmpDir,
        requestTimeoutMs: 100,
      });

      const mockClose = vi.fn(async () => {});
      const mockPage = {
        isClosed: () => false,
        evaluate: vi.fn(async () => {
          throw new Error('Error: SHUFERSAL_REQUEST_TIMEOUT');
        }),
      };

      const internal = client as unknown as {
        page: typeof mockPage | null;
        context: { close: typeof mockClose } | null;
        sendRequest: (
          opts: { method: 'GET' | 'POST'; path: string },
          format: 'json' | 'cart' | 'page',
        ) => Promise<unknown>;
      };
      internal.page = mockPage;
      internal.context = { close: mockClose };

      await expect(
        internal.sendRequest({ method: 'GET', path: '/cart/load' }, 'cart'),
      ).rejects.toBeInstanceOf(TimeoutError);
      // Browser itself stayed responsive (only fetch aborted), so context stays alive
      expect(mockClose).not.toHaveBeenCalled();
      expect(internal.page).not.toBeNull();
    });
  });

  describe('HaziHinamClient hard timeouts', () => {
    it('rejects promptly via Promise.race even if fetch ignores AbortSignal', async () => {
      const hungFetch = vi.fn(
        () =>
          new Promise<Response>(() => {
            // Never resolves and ignores init.signal
          }),
      ) as unknown as typeof fetch;

      const client = new HaziHinamClient({
        sessionFilePath: path.join(tmpDir, 'hazi-hung.json'),
        fetchFn: hungFetch,
        httpTimeoutMs: 40,
      });

      const start = Date.now();
      await expect(client.searchProducts('חלב')).rejects.toBeInstanceOf(
        TimeoutError,
      );
      expect(Date.now() - start).toBeLessThan(400);
    });

    it('aborts and rejects when response headers arrive but response.text() body hangs', async () => {
      let aborted = false;
      const hungBodyFetch = vi.fn(async (_url: string, init?: RequestInit) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          url: String(_url),
          text: () =>
            new Promise<string>(() => {
              // Stalled response body
            }),
        } as unknown as Response;
      }) as unknown as typeof fetch;

      const client = new HaziHinamClient({
        sessionFilePath: path.join(tmpDir, 'hazi-hung-body.json'),
        fetchFn: hungBodyFetch,
        httpTimeoutMs: 40,
      });

      const start = Date.now();
      await expect(client.searchProducts('קוטג')).rejects.toBeInstanceOf(
        TimeoutError,
      );
      expect(Date.now() - start).toBeLessThan(400);
      expect(aborted).toBe(true);
    });

    it('short-circuits guest batch setItemsInCart after consecutive timeouts instead of stalling for every item', async () => {
      let addCalls = 0;
      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('/proxy/init')) {
          return new Response(
            JSON.stringify({
              Results: {
                AnonymousToken: { access_token: 'anon-tok-12345', expires_in: 3600 },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('/proxy/api/item/addItemToCart')) {
          addCalls++;
          return new Promise<Response>(() => {});
        }
        throw new Error(`Unexpected URL ${url}`);
      }) as unknown as typeof fetch;

      const client = new HaziHinamClient({
        sessionFilePath: path.join(tmpDir, 'hazi-batch-timeout.json'),
        fetchFn,
        httpTimeoutMs: 35,
      });

      const items = Array.from({ length: 10 }, (_, idx) => ({
        productCode: String(1000 + idx),
        quantity: 1,
        sellingMethod: 'BY_UNIT' as const,
      }));

      const start = Date.now();
      const cart = await client.setItemsInCart(items);
      expect(Date.now() - start).toBeLessThan(500);
      // Stopped hitting the hung endpoint after 2 consecutive timeouts instead of 10
      expect(addCalls).toBe(2);
      expect(cart.items).toHaveLength(10);
    });
  });

  describe('Telegram update processing hard timeout', () => {
    it('bounds a hung handler so Grammy polling loop never freezes and processes subsequent updates', async () => {
      const db = new BotDatabase(path.join(tmpDir, 'bot-timeout.sqlite'));
      try {
        const sentMessages: Array<{ chat_id: number; text: string }> = [];

        const hungAi = {
          parseGroupMessage: vi.fn(
            () =>
              new Promise<never>(() => {
                // Simulate a completely hung AI/site operation
              }),
          ),
        } as unknown as GroceryAiService;

        const mockStores = {
          isMultiStore: () => false,
          getEnabledStores: () => [],
        } as unknown as MultiStoreManager;

        const config: AppConfig = {
          telegramBotToken: '123456:TEST_TOKEN',
          allowedChatIds: [-100555],
          adminUserIds: [42],
          geminiApiKey: 'test-key',
          geminiModel: 'gemini-3.8-flash',
          enabledStores: ['shufersal'],
          shufersalUsername: 'u',
          shufersalPassword: 'p',
          chromeHeadless: true,
          dbPath: path.join(tmpDir, 'bot-timeout.sqlite'),
          sessionFilePath: path.join(tmpDir, 's.json'),
          haziHinamSessionFilePath: path.join(tmpDir, 'h.json'),
          superHavivSessionFilePath: path.join(tmpDir, 'sh.json'),
          victorySessionFilePath: path.join(tmpDir, 'v.json'),
          screenshotsDir: tmpDir,
        };

        const bot = createTelegramBot({
          config,
          db,
          stores: mockStores,
          ai: hungAi,
          updateTimeoutMs: 60,
        });

        // Provide botInfo and stub outgoing Telegram API requests so handleUpdate runs fully offline
        bot.botInfo = {
          id: 999,
          is_bot: true,
          first_name: 'TestBot',
          username: 'test_grocery_bot',
          can_join_groups: true,
          can_read_all_group_messages: true,
          supports_inline_queries: false,
          can_connect_to_business: false,
          has_main_web_app: false,
          has_topics_enabled: false,
          allows_users_to_create_topics: false,
        };

        bot.api.config.use(async (_prev, method, payload) => {
          if (method === 'sendMessage') {
            const p = payload as { chat_id: number; text: string };
            sentMessages.push({ chat_id: p.chat_id, text: p.text });
            return {
              ok: true,
              result: {
                message_id: sentMessages.length,
                date: Math.floor(Date.now() / 1000),
                chat: { id: p.chat_id, type: 'supergroup' },
                text: p.text,
              },
            } as never;
          }
          return { ok: true, result: true } as never;
        });

        // 1. Send a free-text message that hits the hung handler
        const start = Date.now();
        await bot.handleUpdate({
          update_id: 1,
          message: {
            message_id: 10,
            date: Math.floor(Date.now() / 1000),
            chat: { id: -100555, type: 'supergroup', title: 'Test' },
            from: { id: 42, is_bot: false, first_name: 'Eli' },
            text: 'צריך 2 חלב',
          },
        });
        expect(Date.now() - start).toBeLessThan(500);
        expect(sentMessages.some((m) => m.text.includes('ארכה יותר מדי זמן'))).toBe(
          true,
        );

        // 2. Immediately send /id — polling loop is NOT frozen and responds cleanly!
        await bot.handleUpdate({
          update_id: 2,
          message: {
            message_id: 11,
            date: Math.floor(Date.now() / 1000),
            chat: { id: -100555, type: 'supergroup', title: 'Test' },
            from: { id: 42, is_bot: false, first_name: 'Eli' },
            text: '/id',
            entities: [{ offset: 0, length: 3, type: 'bot_command' }],
          },
        });
        expect(sentMessages.some((m) => m.text.includes('ALLOWED_CHAT_IDS'))).toBe(
          true,
        );
      } finally {
        db.close();
      }
    });
  });
});
