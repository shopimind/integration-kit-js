import { describe, it, expect } from 'vitest';
import { createRateLimiter } from './rate-limiter.js';

describe('createRateLimiter', () => {
  it('allows up to capacity then blocks (no refill)', () => {
    const allow = createRateLimiter({ capacity: 3, refillPerSec: 0, now: () => 0 });
    expect(allow('a')).toBe(true);
    expect(allow('a')).toBe(true);
    expect(allow('a')).toBe(true);
    expect(allow('a')).toBe(false); // bucket drained
    expect(allow('b')).toBe(true); // independent key
  });

  it('refills over time', () => {
    let t = 0;
    const allow = createRateLimiter({ capacity: 1, refillPerSec: 1, now: () => t });
    expect(allow('a')).toBe(true);
    expect(allow('a')).toBe(false);
    t = 1000; // one second later -> +1 token
    expect(allow('a')).toBe(true);
  });

  it('does not grow the bucket Map without bound (eviction is enforced)', () => {
    // Frozen clock + no refill: a drained bucket stays drained unless it is EVICTED
    // and recreated at full capacity. We exploit that to prove the Map is bounded.
    const maxKeys = 8;
    const allow = createRateLimiter({ capacity: 1, refillPerSec: 0, maxKeys, now: () => 0 });

    // Drain the victim's single token: subsequent calls are blocked while it lives.
    expect(allow('victim')).toBe(true);
    expect(allow('victim')).toBe(false);

    // Flood with far more distinct keys than maxKeys. If the Map were unbounded, every
    // bucket (including 'victim') would persist and 'victim' would stay blocked forever.
    // With eviction, 'victim' is dropped and recreated fresh -> allowed again.
    for (let i = 0; i < maxKeys * 50; i += 1) allow(`flood-${i}`);

    // Proof of eviction: the victim bucket was forgotten and reset to full capacity.
    expect(allow('victim')).toBe(true);
  });

  it('stays bounded under a large flood of distinct keys', () => {
    // Smoke check: a huge flood must not throw / blow up; behavior stays consistent
    // (each brand-new full bucket immediately yields one allowed call).
    const allow = createRateLimiter({ capacity: 1, refillPerSec: 0, maxKeys: 100, now: () => 0 });
    let allowed = 0;
    for (let i = 0; i < 100000; i += 1) if (allow(`ip-${i}`)) allowed += 1;
    expect(allowed).toBe(100000); // every distinct, freshly-created bucket allows its first call
  });
});
