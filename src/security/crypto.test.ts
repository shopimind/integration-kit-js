import { describe, it, expect } from 'vitest';
import { SecretCipher } from './crypto.js';

const KEY = 'a'.repeat(64); // 32 bytes in hex

describe('SecretCipher', () => {
  it('encrypts then decrypts (roundtrip) with a key', () => {
    const c = new SecretCipher({ key: KEY, production: true });
    const enc = c.encrypt('api-key-123');
    expect(enc.startsWith('gcm:')).toBe(true);
    expect(enc).not.toContain('api-key-123');
    expect(c.decrypt(enc)).toBe('api-key-123');
  });

  it('FAILS in production without a key', () => {
    expect(() => new SecretCipher({ production: true })).toThrowError(/CREDENTIALS_KEY/);
  });

  it('allows dev mode without a key (plain:)', () => {
    const c = new SecretCipher({ production: false });
    expect(c.encrypt('x')).toBe('plain:x');
    expect(c.decrypt('plain:x')).toBe('x');
  });

  it('rejects a key of the wrong length', () => {
    expect(() => new SecretCipher({ key: 'abcd' })).toThrowError(/32 bytes/);
  });

  it('detects ciphertext tampering (GCM auth tag)', () => {
    const c = new SecretCipher({ key: KEY });
    const enc = c.encrypt('secret');
    const parts = enc.split(':');
    const ct = parts[3] ?? '';
    parts[3] = ct.replace(/.$/, (ch) => (ch === 'a' ? 'b' : 'a'));
    expect(() => c.decrypt(parts.join(':'))).toThrow();
  });

  it('REJECTS a plain: blob when a key is configured (anti-downgrade)', () => {
    const c = new SecretCipher({ key: KEY });
    expect(() => c.decrypt('plain:attacker-chosen-token')).toThrowError(/plaintext secret rejected/);
  });

  it('binds the ciphertext to its location via AAD (anti-relocation)', () => {
    const c = new SecretCipher({ key: KEY });
    const enc = c.encrypt('balance:42', 'inst-1:__loyalty');
    expect(c.decrypt(enc, 'inst-1:__loyalty')).toBe('balance:42');
    // Same key, different AAD (other installation/slot) -> the auth tag fails.
    expect(() => c.decrypt(enc, 'inst-2:__loyalty')).toThrow();
    // AAD missing although it was present at encryption -> also fails.
    expect(() => c.decrypt(enc)).toThrow();
  });

  it('validates IV/tag length before decryption', () => {
    const c = new SecretCipher({ key: KEY });
    expect(() => c.decrypt('gcm:00:00:00')).toThrowError(/invalid GCM IV/);
  });
});
