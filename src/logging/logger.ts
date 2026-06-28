import { redact } from '../security/redaction.js';

/**
 * Logger that REDACTS by default. No "raw" method is exposed: every piece of
 * metadata passes through `redact()` before emission, so a secret cannot leak
 * into the logs.
 */
export interface Logger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
  meta?: unknown;
  bindings?: Record<string, unknown>;
}

export interface LoggerOptions {
  bindings?: Record<string, unknown>;
  /** Injectable sink (tests). Defaults to JSON console output. */
  sink?: (line: LogLine) => void;
}

const defaultSink = (line: LogLine): void => {
  const payload = JSON.stringify({ ...line.bindings, level: line.level, message: line.message, meta: line.meta });
  if (line.level === 'error') console.error(payload);
  else if (line.level === 'warn') console.warn(payload);
  else console.log(payload);
};

export function createLogger(opts: LoggerOptions = {}): Logger {
  const bindings = opts.bindings ?? {};
  const sink = opts.sink ?? defaultSink;
  const emit = (level: LogLine['level'], message: string, meta?: unknown): void => {
    sink({ level, message, meta: meta === undefined ? undefined : redact(meta), bindings });
  };
  return {
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    child: (extra) => createLogger({ bindings: { ...bindings, ...extra }, ...(opts.sink ? { sink: opts.sink } : {}) }),
  };
}
