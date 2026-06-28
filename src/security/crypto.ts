import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption of secrets at rest (partner API keys).
 *
 * In PRODUCTION, a missing key is FATAL. In dev, a `plain:` fallback is allowed
 * so a key is not required locally.
 */

const ALGO = 'aes-256-gcm';
const PLAIN_PREFIX = 'plain:';
const GCM_PREFIX = 'gcm:';

export interface CryptoOptions {
  /** 64-character hex key (32 bytes). */
  key?: string | null;
  /** `true` => a missing key throws at construction. */
  production?: boolean;
}

export class SecretCipher {
  private readonly key: Buffer | null;

  constructor(opts: CryptoOptions) {
    this.key = parseKey(opts.key);
    if ((opts.production ?? false) && !this.key) {
      throw new Error(
        'CREDENTIALS_KEY is required in production (64 hex characters / 32 bytes) to encrypt secrets at rest',
      );
    }
  }

  /** `true` when no key is configured -> secrets stored IN PLAINTEXT (dev only). */
  get insecure(): boolean {
    return this.key === null;
  }

  /**
   * Encrypts a secret. `aad` (Additional Authenticated Data) binds the ciphertext
   * to its location (e.g. `${installationId}:${key}`): a valid blob then cannot be
   * relocated/swapped from one row to another (the auth tag covers the AAD).
   */
  encrypt(plaintext: string, aad?: string): string {
    if (!this.key) {
      // Dev only -- in production the constructor has already thrown.
      return `${PLAIN_PREFIX}${plaintext}`;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${GCM_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
  }

  decrypt(stored: string, aad?: string): string {
    if (stored.startsWith(PLAIN_PREFIX)) {
      // The format prefix is part of the stored value (so it is forgeable).
      // Only accept plaintext if no key is configured (dev). If a key exists, a
      // `plain:` blob is tampering -> reject (GCM integrity takes precedence).
      if (this.key) throw new Error('plaintext secret rejected: a CREDENTIALS_KEY is configured');
      return stored.slice(PLAIN_PREFIX.length);
    }
    if (!stored.startsWith(GCM_PREFIX)) throw new Error('unrecognized ciphertext format');
    if (!this.key) throw new Error('CREDENTIALS_KEY is required to decrypt a stored secret');

    const parts = stored.slice(GCM_PREFIX.length).split(':');
    if (parts.length !== 3) throw new Error('malformed GCM ciphertext');
    const [ivHex, tagHex, ctHex] = parts as [string, string, string];

    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    if (iv.length !== 12) throw new Error('invalid GCM IV (12 bytes expected)');
    if (tag.length !== 16) throw new Error('invalid GCM tag (16 bytes expected)');

    const decipher = createDecipheriv(ALGO, this.key, iv);
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(ctHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  }
}

function parseKey(key?: string | null): Buffer | null {
  if (!key) return null;
  const buf = Buffer.from(key, 'hex');
  if (buf.length !== 32) {
    throw new Error(`CREDENTIALS_KEY must be 32 bytes (64 hex), received ${buf.length} byte(s)`);
  }
  return buf;
}
