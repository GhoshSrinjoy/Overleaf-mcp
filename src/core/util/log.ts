export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, ...details: unknown[]): void;
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function formatDetails(details: unknown[]): string {
  return details
    .map((detail) => {
      if (detail instanceof Error) return detail.stack || detail.message;
      if (typeof detail === 'string') return detail;
      try {
        return JSON.stringify(detail);
      } catch {
        return String(detail);
      }
    })
    .join(' ');
}

/**
 * Logs to stderr. The stdio MCP transport owns stdout, so nothing else may write there.
 */
export function createStderrLogger(minLevel: LogLevel = 'info'): Logger {
  const write = (level: LogLevel, message: string, details: unknown[]) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const suffix = details.length ? ` ${formatDetails(details)}` : '';
    process.stderr.write(`[overleaf-mcp] ${level.toUpperCase()} ${message}${suffix}\n`);
  };
  return {
    debug: (message, ...details) => write('debug', message, details),
    info: (message, ...details) => write('info', message, details),
    warn: (message, ...details) => write('warn', message, details),
    error: (message, ...details) => write('error', message, details),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
