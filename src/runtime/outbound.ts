import { createRateLimiter } from './rate-limiter.js';

/**
 * Outbound-call helpers — for a connector talking to its PARTNER's API
 * (a POS or e-commerce partner such as Hiboutik), not to ShopiMind. They are the
 * outbound counterparts of the
 * inbound rate-limiter the runtime already uses for its own routes.
 *
 *  - `makeOutboundLimiter` wraps the kit's token-bucket into an async gate that
 *    RESOLVES when a token is free (instead of returning a boolean), so a caller
 *    just `await limiter()` before each partner request — bounding request rate to
 *    stay under the partner's quota.
 *  - `fetchWithRetry` retries transient failures (429 / 5xx / network) with
 *    EXPONENTIAL BACKOFF + JITTER and honours a `Retry-After` header when present —
 *    the correct, server-directed way to back off, instead of a fixed linear sleep.
 */

export interface OutboundLimiterOptions {
  /** Max burst (tokens). Default 20. */
  capacity?: number;
  /** Sustained rate (tokens/second). Default 5. */
  refillPerSec?: number;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable sleep (ms). Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Poll interval (ms) while waiting for a token. Default 25. */
  pollMs?: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Builds an async rate gate keyed by an optional string (default a single shared
 * key). `await limiter()` resolves once a token is available. Reuses the kit's
 * token-bucket so behaviour matches the inbound limiter.
 */
export function makeOutboundLimiter(opts: OutboundLimiterOptions = {}): (key?: string) => Promise<void> {
  const tryTake = createRateLimiter({
    capacity: opts.capacity ?? 20,
    refillPerSec: opts.refillPerSec ?? 5,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const sleep = opts.sleep ?? realSleep;
  const pollMs = opts.pollMs ?? 25;
  return async (key = 'default'): Promise<void> => {
    // Spin-wait with a short sleep: the bucket refills over time, so a blocked call
    // eventually gets a token. Cheap and dependency-free (no queue bookkeeping).
    while (!tryTake(key)) {
      await sleep(pollMs);
    }
  };
}

export interface FetchRetryOptions {
  /** Max attempts (including the first). Default 4. */
  maxAttempts?: number;
  /** Base backoff (ms) for the exponential schedule. Default 500. */
  baseDelayMs?: number;
  /** Cap on any single backoff (ms). Default 30_000. */
  maxDelayMs?: number;
  /** Injectable sleep (ms). Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter in [0,1). Defaults to `Math.random`. */
  random?: () => number;
  /** Predicate: should this HTTP status be retried? Default 429 or >=500. */
  retryOnStatus?: (status: number) => boolean;
}

/** Minimal response shape `fetchWithRetry` needs (compatible with the WHATWG `Response`). */
export interface RetriableResponse {
  status: number;
  headers: { get(name: string): string | null };
}

const defaultRetryOnStatus = (status: number): boolean => status === 429 || status >= 500;

/**
 * Parses a `Retry-After` header: either a delay in SECONDS, or an HTTP date. Returns
 * the delay in ms, or `null` if absent/unparseable. `nowMs` lets the date form be tested.
 */
export function parseRetryAfterMs(value: string | null, nowMs: number = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - nowMs);
  return null;
}

/** Exponential backoff with full jitter, capped — bounded by `Retry-After` when the server sent one. */
export function backoffDelayMs(
  attempt: number,
  opts: { baseDelayMs?: number; maxDelayMs?: number; random?: () => number; retryAfterMs?: number | null } = {},
): number {
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 30_000;
  const random = opts.random ?? Math.random;
  // Server-directed wait wins when present (respect its explicit instruction).
  if (opts.retryAfterMs != null) return Math.min(opts.retryAfterMs, max);
  const exp = Math.min(base * 2 ** attempt, max);
  return Math.floor(random() * exp); // full jitter
}

/**
 * Runs `doFetch` (returning any WHATWG-`Response`-like object) with retry on 429 /
 * 5xx / network errors, honouring `Retry-After` + exponential backoff with jitter.
 * The final response (or thrown error) after the last attempt is returned/rethrown.
 * `doFetch` is a thunk so the caller controls the URL/options/`fetch` implementation.
 */
export async function fetchWithRetry<R extends RetriableResponse>(
  doFetch: () => Promise<R>,
  opts: FetchRetryOptions = {},
): Promise<R> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  const sleep = opts.sleep ?? realSleep;
  const retryOn = opts.retryOnStatus ?? defaultRetryOnStatus;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const isLast = attempt === maxAttempts - 1;
    try {
      const res = await doFetch();
      if (!retryOn(res.status) || isLast) return res;
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
      await sleep(
        backoffDelayMs(attempt, {
          ...(opts.baseDelayMs != null ? { baseDelayMs: opts.baseDelayMs } : {}),
          ...(opts.maxDelayMs != null ? { maxDelayMs: opts.maxDelayMs } : {}),
          ...(opts.random ? { random: opts.random } : {}),
          retryAfterMs,
        }),
      );
    } catch (e) {
      // Network-level error (no response): retry unless this was the last attempt.
      lastError = e;
      if (isLast) throw e;
      await sleep(
        backoffDelayMs(attempt, {
          ...(opts.baseDelayMs != null ? { baseDelayMs: opts.baseDelayMs } : {}),
          ...(opts.maxDelayMs != null ? { maxDelayMs: opts.maxDelayMs } : {}),
          ...(opts.random ? { random: opts.random } : {}),
        }),
      );
    }
  }
  // Unreachable (the loop returns or throws), but satisfies the type checker.
  throw lastError ?? new Error('fetchWithRetry: exhausted attempts');
}
