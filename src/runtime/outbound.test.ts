import { describe, it, expect } from 'vitest';
import {
  makeOutboundLimiter,
  fetchWithRetry,
  parseRetryAfterMs,
  backoffDelayMs,
  type RetriableResponse,
} from './outbound.js';

const resp = (status: number, retryAfter?: string): RetriableResponse => ({
  status,
  headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' && retryAfter != null ? retryAfter : null) },
});

describe('parseRetryAfterMs (E7)', () => {
  it('parses a seconds value', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
  });
  it('parses an HTTP date relative to now', () => {
    const now = Date.parse('2026-07-02T00:00:00.000Z');
    expect(parseRetryAfterMs('Thu, 02 Jul 2026 00:00:10 GMT', now)).toBe(10_000);
  });
  it('returns null for an absent/garbage value', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('not-a-date')).toBeNull();
  });
});

describe('backoffDelayMs (E7)', () => {
  it('honours Retry-After (capped) over the exponential schedule', () => {
    expect(backoffDelayMs(0, { retryAfterMs: 3000, maxDelayMs: 30_000 })).toBe(3000);
    expect(backoffDelayMs(0, { retryAfterMs: 99_999, maxDelayMs: 30_000 })).toBe(30_000);
  });
  it('applies full jitter within the exponential ceiling', () => {
    // random() = 1 (just under) -> close to the ceiling; random() = 0 -> 0.
    expect(backoffDelayMs(2, { baseDelayMs: 100, random: () => 0 })).toBe(0);
    const d = backoffDelayMs(2, { baseDelayMs: 100, random: () => 0.999 });
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(400); // 100 * 2^2 = 400
  });
});

describe('fetchWithRetry (E7)', () => {
  const noSleep = (): Promise<void> => Promise.resolve();

  it('returns immediately on a success', async () => {
    let calls = 0;
    const res = await fetchWithRetry(() => { calls += 1; return Promise.resolve(resp(200)); }, { sleep: noSleep });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  it('retries on 429 then succeeds, honouring Retry-After', async () => {
    let calls = 0;
    const slept: number[] = [];
    const res = await fetchWithRetry(
      () => {
        calls += 1;
        return Promise.resolve(calls === 1 ? resp(429, '2') : resp(200));
      },
      { sleep: async (ms) => { slept.push(ms); }, random: () => 0 },
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(slept[0]).toBe(2000); // Retry-After: 2s honoured
  });

  it('retries on 5xx and gives up after maxAttempts (returns the last response)', async () => {
    let calls = 0;
    const res = await fetchWithRetry(() => { calls += 1; return Promise.resolve(resp(503)); }, {
      maxAttempts: 3,
      sleep: noSleep,
      random: () => 0,
    });
    expect(res.status).toBe(503);
    expect(calls).toBe(3);
  });

  it('retries a network error then rethrows after the last attempt', async () => {
    let calls = 0;
    await expect(
      fetchWithRetry<RetriableResponse>(() => { calls += 1; return Promise.reject(new Error('ECONNRESET')); }, {
        maxAttempts: 2,
        sleep: noSleep,
        random: () => 0,
      }),
    ).rejects.toThrow('ECONNRESET');
    expect(calls).toBe(2);
  });
});

describe('makeOutboundLimiter (E7)', () => {
  it('resolves while tokens are available, then waits for a refill', async () => {
    let t = 0;
    const now = (): number => t;
    let waited = 0;
    const sleep = async (ms: number): Promise<void> => {
      waited += ms;
      t += ms; // advance the injected clock so the bucket refills
    };
    // capacity 2, refill 1/sec -> the 3rd immediate call must wait for a token.
    const limiter = makeOutboundLimiter({ capacity: 2, refillPerSec: 1, now, sleep, pollMs: 100 });
    await limiter();
    await limiter();
    await limiter(); // this one blocks until ~1s of refill has elapsed
    expect(waited).toBeGreaterThan(0);
  });
});
