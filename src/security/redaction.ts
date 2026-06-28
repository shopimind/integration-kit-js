/**
 * Masks secrets before logging.
 *
 * Run values through this function before writing them to logs so that no API key
 * appears in plaintext.
 */

const SENSITIVE =
  /(secret|password|passwd|api[_-]?key|token|access[_-]?token|client[_-]?secret|authorization|credential)/i;

/**
 * Maximum recursion depth. Beyond this level the value is truncated (replaced with a
 * sentinel) to guard against pathologically deep structures that could exhaust the
 * stack — and so a deeply-nested secret can never leak unredacted.
 */
const MAX_DEPTH = 8;

/**
 * Recursively replaces the values of sensitive keys with `[redacted]`.
 *
 * Guards against circular references (a node already on the current path is replaced
 * with `[Circular]`) and against excessive nesting (beyond {@link MAX_DEPTH} levels the
 * value is truncated). Plain JSON-shaped objects are unaffected by these guards.
 */
export function redact<T>(value: T): T {
  return redactInternal(value, new WeakSet<object>(), 0) as T;
}

function redactInternal(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  // Bound the recursion depth: beyond this level TRUNCATE rather than return the value
  // as-is, so a sensitive key nested very deep can never leak unredacted to logs (fail-closed).
  if (depth >= MAX_DEPTH) {
    return '[truncated: max depth]';
  }

  // Break cycles: if this object is already on the current traversal path, stop.
  if (seen.has(value as object)) {
    return '[Circular]';
  }
  seen.add(value as object);

  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((v) => redactInternal(v, seen, depth + 1));
  } else {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? '[redacted]' : redactInternal(v, seen, depth + 1);
    }
    result = out;
  }

  // Allow the same object to reappear on sibling branches; we only forbid it on the
  // active path (true cycles), not on legitimate shared references.
  seen.delete(value as object);
  return result;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE.test(key);
}
