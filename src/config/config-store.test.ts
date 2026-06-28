import { describe, it, expect } from 'vitest';
import { openDatabase } from '../store/db.js';
import { createRepositories } from '../store/repositories.js';
import { SecretCipher } from '../security/crypto.js';
import { saveConfigs, loadConfigs, sensitiveKeys } from './config-store.js';
import type { ConfigSchema } from '../contracts/index.js';

const cipher = new SecretCipher({ key: 'd'.repeat(64) });
const schema: ConfigSchema = {
  steps: [
    {
      key: 'c',
      label: { fr: 'Connexion' },
      fields: [
        { key: 'account', type: 'text', label: { fr: 'Compte' } },
        { key: 'api_key', type: 'password', sensitive: true, label: { fr: 'Clé' } },
      ],
    },
    { key: 'd', label: { fr: 'Données' }, fields: [{ key: 'sync_orders', type: 'checkbox', label: { fr: 'Commandes' } }] },
  ],
};

const state = () => createRepositories(openDatabase(':memory:'), cipher).state;

describe('config-store', () => {
  it('sensitiveKeys identifies sensitive fields', () => {
    expect(sensitiveKeys(schema)).toEqual(['api_key']);
  });

  it('save/load roundtrip', () => {
    const s = state();
    saveConfigs(s, '1', schema, { account: 'demo', api_key: 'SECRET', sync_orders: true });
    expect(loadConfigs(s, '1', schema)).toEqual({ account: 'demo', sync_orders: true, api_key: 'SECRET' });
  });

  it('the secret is not stored in plaintext in the `cfg` blob, but stays readable (decrypted)', () => {
    const s = state();
    saveConfigs(s, '1', schema, { account: 'demo', api_key: 'SECRET' });
    expect(s.get('1', 'cfg')).not.toContain('SECRET');
    expect(loadConfigs(s, '1', schema).api_key).toBe('SECRET');
  });
});
