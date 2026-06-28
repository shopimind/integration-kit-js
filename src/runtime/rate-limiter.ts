/**
 * Token-bucket limiter, keyed (e.g. per installation). In-memory -- sufficient for
 * a single instance. `capacity` max tokens, refilled at `refillPerSec` tokens/second.
 * Returns a function `(key) => boolean`: true if the call is allowed.
 *
 * Eviction: keys are tracked in a Map. To avoid an unbounded memory leak (and a slow
 * DoS via a flood of distinct keys, e.g. one per spoofed IP), the Map is capped at
 * `maxKeys` entries. When the cap is reached, fully-refilled (idle) buckets are pruned
 * first, then -- if still over the cap -- the least-recently-seen buckets are evicted.
 * Evicting a full bucket is harmless: a re-created bucket also starts at `capacity`.
 */
export interface RateLimiterOptions {
  capacity?: number;
  refillPerSec?: number;
  now?: () => number;
  /** Upper bound on the number of tracked keys before eviction kicks in (default 10000). */
  maxKeys?: number;
}

export function createRateLimiter(opts: RateLimiterOptions = {}): (key: string) => boolean {
  const capacity = opts.capacity ?? 20;
  const refillPerSec = opts.refillPerSec ?? 5;
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10000;
  const buckets = new Map<string, { tokens: number; last: number }>();

  /**
   * Keep the Map bounded. Called when a brand-new key would push the Map over `maxKeys`.
   * First drop buckets that are fully refilled (idle -- safe to forget, they reset to
   * `capacity` on recreation); if that is not enough, evict in least-recently-seen order.
   * Map preserves insertion order, but `last` is the authoritative recency, so we sort.
   */
  const evict = (): void => {
    // Pass 1: prune idle (fully-refilled) buckets -- losing them changes nothing.
    for (const [k, b] of buckets) {
      if (b.tokens >= capacity) buckets.delete(k);
      if (buckets.size < maxKeys) return;
    }
    if (buckets.size < maxKeys) return;
    // Pass 2: still full of active buckets -- evict the least-recently-seen ones.
    const entries = [...buckets.entries()].sort((a, b) => a[1].last - b[1].last);
    const toRemove = buckets.size - maxKeys + 1;
    for (let i = 0; i < toRemove && i < entries.length; i += 1) {
      buckets.delete(entries[i]![0]);
    }
  };

  return (key: string): boolean => {
    const t = now();
    const existing = buckets.get(key);
    if (!existing && buckets.size >= maxKeys) evict();
    const b = existing ?? { tokens: capacity, last: t };
    b.tokens = Math.min(capacity, b.tokens + ((t - b.last) / 1000) * refillPerSec);
    b.last = t;
    if (b.tokens < 1) {
      buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    buckets.set(key, b);
    return true;
  };
}
