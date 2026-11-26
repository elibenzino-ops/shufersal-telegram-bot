export class TimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export function isTimeoutError(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const msg = err.message.toUpperCase();
  return (
    msg.includes('TIMEOUT') ||
    msg.includes('TIMED OUT') ||
    msg.includes('לא הגיב תוך')
  );
}

/**
 * Races `promise` against a hard timer. If the timer fires first, invokes the
 * optional `onTimeout` callback (e.g. `controller.abort()`) and rejects with a
 * `TimeoutError`, swallowing any late rejection from `promise` so Node never
 * crashes with an unhandled promise rejection.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  const safeMs = Math.max(1, Math.round(timeoutMs));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      if (onTimeout) {
        try {
          onTimeout();
        } catch {
          // Ignore cleanup errors during timeout abort
        }
      }
      reject(new TimeoutError(message, safeMs));
    }, safeMs);
  });

  // Prevent unhandled rejection if the underlying promise rejects after timeout
  promise.catch(() => {});

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (timedOut) {
      promise.catch(() => {});
    }
  }
}

export interface TimedTextResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  url: string;
  text: string;
}

/**
 * Executes `fetchFn` AND reads the full response body (`res.text()`) under a
 * single hard AbortController + Promise.race deadline so neither stalled
 * headers nor stalled response bodies can hang indefinitely.
 */
export async function fetchTextWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<TimedTextResponse> {
  const controller = new AbortController();
  const signal = init?.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;

  const work = (async (): Promise<TimedTextResponse> => {
    try {
      const res = await fetchFn(url, {
        ...init,
        signal,
      });
      const text = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        url: res.url,
        text,
      };
    } catch (err) {
      if (
        controller.signal.aborted ||
        (err instanceof Error && err.name === 'AbortError')
      ) {
        throw new TimeoutError(timeoutMessage, timeoutMs);
      }
      throw err;
    }
  })();

  return withTimeout(work, timeoutMs, timeoutMessage, () => controller.abort());
}
