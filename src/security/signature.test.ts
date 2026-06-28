import { describe, it, expect } from 'vitest';
import { verifyShopimindSignature, signShopimindBody } from './signature.js';

const SECRET = 'whsec_test';
const body = JSON.stringify({ event: 'integration.activated', id_shop_integration: 1 });
const ts = 1_700_000_000;
const now = (): number => ts * 1000;

const headers = (t: number, sig: string): Record<string, string> => ({
  'x-shopimind-timestamp': String(t),
  'x-shopimind-signature': sig,
});

describe('verifyShopimindSignature', () => {
  it('accepts a valid signature', () => {
    const sig = signShopimindBody(body, SECRET, ts);
    expect(verifyShopimindSignature(body, headers(ts, sig), { secret: SECRET, now })).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    const sig = signShopimindBody(body, SECRET, ts);
    const r = verifyShopimindSignature(`${body} `, headers(ts, sig), { secret: SECRET, now });
    expect(r).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a timestamp outside tolerance (anti-replay)', () => {
    const sig = signShopimindBody(body, SECRET, ts);
    const later = (): number => (ts + 10_000) * 1000;
    expect(verifyShopimindSignature(body, headers(ts, sig), { secret: SECRET, now: later }))
      .toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('rejects missing headers', () => {
    expect(verifyShopimindSignature(body, {}, { secret: SECRET, now }))
      .toEqual({ ok: false, reason: 'missing_signature_headers' });
  });

  it('rejects a wrong secret key', () => {
    const sig = signShopimindBody(body, 'other', ts);
    expect(verifyShopimindSignature(body, headers(ts, sig), { secret: SECRET, now }).ok).toBe(false);
  });
});
