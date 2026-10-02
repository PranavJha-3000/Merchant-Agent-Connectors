import { redactValue } from './redact.ts';

/**
 * Minimal structured logger.
 *
 * Every field value is passed through redaction before serialization, so a
 * caller that accidentally includes a credential-bearing object cannot leak it.
 * Output is one JSON object per line (machine-parseable, grep-able in CI logs).
 *
 * Non-goal: no dashboard, no transport, no log shipping. See docs/reliability.md.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Derive a logger that merges `bound` into every future entry. */
  child(bound: LogFields): Logger;
}

export interface JsonLoggerOptions {
  minLevel?: LogLevel;
  /** Sink for one serialized line (without trailing newline). Defaults to stderr — stdout is reserved for the MCP stdio transport. */
  write?: (line: string) => void;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export function createJsonLogger(options: JsonLoggerOptions = {}): Logger {
  const minLevel = options.minLevel ?? 'info';
  const write = options.write ?? ((line: string) => process.stderr.write(line + '\n'));
  const now = options.now ?? (() => new Date());

  function make(bound: LogFields): Logger {
    const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
      if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
      const entry = redactValue({
        ts: now().toISOString(),
        level,
        msg: message,
        ...bound,
        ...(fields ?? {}),
      });
      try {
        write(JSON.stringify(entry));
      } catch {
        write(JSON.stringify({ ts: now().toISOString(), level, msg: message, logError: 'unserializable fields' }));
      }
    }
    return {
      debug: (m, f) => emit('debug', m, f),
      info: (m, f) => emit('info', m, f),
      warn: (m, f) => emit('warn', m, f),
      error: (m, f) => emit('error', m, f),
      child: (extra) => make({ ...bound, ...extra }),
    };
  }

  return make({});
}

/** In-memory logger for tests and the demo: records everything, writes nothing. */
export interface MemoryLogger extends Logger {
  entries: Array<{ level: LogLevel; message: string; fields: LogFields }>;
}

export function createMemoryLogger(minLevel: LogLevel = 'debug'): MemoryLogger {
  const entries: MemoryLogger['entries'] = [];
  const make = (bound: LogFields): MemoryLogger => {
    const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
      if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
      entries.push({ level, message, fields: redactValue({ ...bound, ...(fields ?? {}) }) as LogFields });
    };
    return {
      entries,
      debug: (m, f) => emit('debug', m, f),
      info: (m, f) => emit('info', m, f),
      warn: (m, f) => emit('warn', m, f),
      error: (m, f) => emit('error', m, f),
      child: (extra) => make({ ...bound, ...extra }),
    };
  };
  return make({});
}
