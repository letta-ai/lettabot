/**
 * Structured logging for LettaBot.
 *
 * Uses pino for structured JSON in production and pino-pretty for
 * human-readable output during local development.
 *
 * The Logger interface accepts console-style calling conventions:
 *   log.info('message')           - simple message
 *   log.info('message:', data)    - message with extra context
 *   log.error('failed:', err)     - errors are serialized properly
 *
 * Environment variables:
 *   LOG_LEVEL            - Set log level (fatal|error|warn|info|debug|trace)
 *   LETTABOT_LOG_LEVEL   - Alias for LOG_LEVEL
 *   LOG_FORMAT=json      - Force structured JSON output (for Railway/production)
 *
 * Config (lettabot.yaml):
 *   server.logLevel      - Set log level from config (env vars take precedence)
 */

import pino from 'pino';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Resolve initial log level from environment
const envLevel = process.env.LOG_LEVEL || process.env.LETTABOT_LOG_LEVEL;
const initialLevel = envLevel || 'info';

// Determine transport: JSON for production, pretty for local dev
function resolveTransport(): pino.TransportSingleOptions | undefined {
  // Explicit JSON mode -- no transport (raw pino JSON)
  if (process.env.LOG_FORMAT === 'json') return undefined;

  // Try pino-pretty; fall back to raw JSON if not installed (e.g. production)
  try {
    require.resolve('pino-pretty');
    return {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname,service,module',
        messageFormat: '[{module}] {msg}',
        singleLine: true,
      },
    };
  } catch {
    return undefined;
  }
}

export const rootLogger = pino({
  level: initialLevel,
  transport: resolveTransport(),
  base: { service: 'lettabot' },
});

/**
 * Logger interface that accepts console-style calling conventions.
 *
 * Wraps pino child loggers to handle:
 *   log.info('message')            -> pino.info('message')
 *   log.info('message:', extra)    -> pino.info({ extra }, 'message:')
 *   log.error('failed:', err)      -> pino.error({ err }, 'failed:')
 *   log.info({ key: 1 }, 'msg')   -> pino.info({ key: 1 }, 'msg')  (native pino style also works)
 */
export interface Logger {
  fatal(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  trace(msg: string, ...args: unknown[]): void;
  /** Access the underlying pino child logger for advanced use */
  pino: pino.Logger;
}

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/**
 * Wrap a pino child logger to accept console-style arguments.
 *
 * When extra arguments follow the message string, they are folded into
 * a structured object:
 *   - Error instances go under `err` (pino convention for serialization)
 *   - Single non-error values go under `data`
 *   - Multiple values go under `data` as an array
 *
 * If the first argument is already an object (native pino style), it
 * passes through unchanged.
 */
function wrapChild(child: pino.Logger): Logger {
  const wrapper: Record<string, unknown> = { pino: child };

  for (const level of LEVELS) {
    wrapper[level] = (first: unknown, ...rest: unknown[]) => {
      // Native pino style: log.info({ key: 1 }, 'message')
      if (typeof first === 'object' && first !== null && !(first instanceof Error)) {
        (child[level] as Function)(first, ...rest);
        return;
      }

      // Console style with no extra args: log.info('message')
      if (rest.length === 0) {
        (child[level] as Function)(String(first));
        return;
      }

      // Console style with extra args: log.info('message:', data)
      // Build a merge object for structured output
      const merge: Record<string, unknown> = {};
      const extras: unknown[] = [];

      for (const arg of rest) {
        if (arg instanceof Error) {
          merge.err = arg;
        } else {
          extras.push(arg);
        }
      }

      if (extras.length === 1) {
        merge.data = extras[0];
      } else if (extras.length > 1) {
        merge.data = extras;
      }

      if (Object.keys(merge).length > 0) {
        (child[level] as Function)(merge, String(first));
      } else {
        (child[level] as Function)(String(first));
      }
    };
  }

  return wrapper as unknown as Logger;
}

/**
 * Create a child logger scoped to a module.
 *
 * The module name appears in pretty output as a prefix and is a
 * searchable field in JSON output.
 *
 * @example
 *   const log = createLogger('Bot');
 *   log.info('Initialized');                // [INFO] [Bot] Initialized
 *   log.error('Failed:', err);              // [ERROR] [Bot] Failed: { err: ... }
 *   log.debug({ key: 'abc' }, 'Queue tick'); // native pino style also works
 */
export function createLogger(module: string): Logger {
  return wrapChild(rootLogger.child({ module }));
}

/**
 * Update the root log level at runtime.
 *
 * Called from main.ts after config is loaded so that server.logLevel
 * from lettabot.yaml takes effect (env vars still win).
 */
export function setLogLevel(level: string): void {
  rootLogger.level = level;
}
