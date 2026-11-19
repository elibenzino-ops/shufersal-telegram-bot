export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const currentLevel: LogLevel =
  (process.env['LOG_LEVEL']?.toLowerCase() as LogLevel | undefined) ?? 'info';

function shouldLog(level: LogLevel): boolean {
  return (LEVEL_PRIORITY[level] ?? 20) >= (LEVEL_PRIORITY[currentLevel] ?? 20);
}

function formatMeta(meta?: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) {
    return ` | ${meta.name}: ${meta.message}${meta.stack ? `\n${meta.stack}` : ''}`;
  }
  try {
    return ` | ${JSON.stringify(meta)}`;
  } catch {
    return ` | ${String(meta)}`;
  }
}

export const logger = {
  debug(msg: string, meta?: unknown): void {
    if (shouldLog('debug')) {
      console.debug(`[${new Date().toISOString()}] [DEBUG] ${msg}${formatMeta(meta)}`);
    }
  },
  info(msg: string, meta?: unknown): void {
    if (shouldLog('info')) {
      console.info(`[${new Date().toISOString()}] [INFO]  ${msg}${formatMeta(meta)}`);
    }
  },
  warn(msg: string, meta?: unknown): void {
    if (shouldLog('warn')) {
      console.warn(`[${new Date().toISOString()}] [WARN]  ${msg}${formatMeta(meta)}`);
    }
  },
  error(msg: string, meta?: unknown): void {
    if (shouldLog('error')) {
      console.error(`[${new Date().toISOString()}] [ERROR] ${msg}${formatMeta(meta)}`);
    }
  },
};
