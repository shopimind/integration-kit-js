import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from './concurrency.js';

describe('mapWithConcurrency (bounded, avoids 429s)', () => {
  it('preserves result order', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it('never exceeds the limit of promises in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return n;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('rejects an invalid limit', async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow();
  });
});
