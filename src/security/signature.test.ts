import { describe, it, expect } from 'vitest';
import { verifyShopimindSignature, verifyShopimindSignatureMulti, signShopimindBody } from './signature.js';

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

describe('verifyShopimindSignatureMulti (E6 rotation window)', () => {
  it('accepts a signature made with a single string secret (backward compatible)', () => {
    const sig = signShopimindBody(body, SECRET, ts);
    expect(verifyShopimindSignatureMulti(body, headers(ts, sig), SECRET, { now })).toEqual({ ok: true });
  });

  it('accepts a signature made with EITHER secret in the rotation window', () => {
    const sigCurrent = signShopimindBody(body, 'current_secret', ts);
    const sigNext = signShopimindBody(body, 'next_secret', ts);
    const secrets = ['current_secret', 'next_secret'];
    expect(verifyShopimindSignatureMulti(body, headers(ts, sigCurrent), secrets, { now }).ok).toBe(true);
    expect(verifyShopimindSignatureMulti(body, headers(ts, sigNext), secrets, { now }).ok).toBe(true);
  });

  it('rejects a signature made with a secret NOT in the list', () => {
    const sig = signShopimindBody(body, 'unknown', ts);
    expect(verifyShopimindSignatureMulti(body, headers(ts, sig), ['a', 'b'], { now }).ok).toBe(false);
  });

  it('rejects when no secret is configured', () => {
    const sig = signShopimindBody(body, SECRET, ts);
    expect(verifyShopimindSignatureMulti(body, headers(ts, sig), [], { now })).toEqual({ ok: false, reason: 'no_secret_configured' });
  });
});
