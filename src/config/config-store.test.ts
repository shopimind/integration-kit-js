import { describe, it, expect } from 'vitest';
import { createSqliteStore } from '../store/sqlite/index.js';
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

const makeStore = async () => {
  const s = await createSqliteStore({ path: ':memory:' });
  await s.migrate();
  return s;
};
const state = async () => createRepositories(await makeStore(), cipher).state;

describe('config-store', () => {
  it('sensitiveKeys identifies sensitive fields', () => {
    expect(sensitiveKeys(schema)).toEqual(['api_key']);
  });

  it('save/load roundtrip', async () => {
    const s = await state();
    await saveConfigs(s, '1', schema, { account: 'demo', api_key: 'SECRET', sync_orders: true });
    expect(await loadConfigs(s, '1', schema)).toEqual({ account: 'demo', sync_orders: true, api_key: 'SECRET' });
  });

  it('the secret is not stored in plaintext in the `cfg` blob, but stays readable (decrypted)', async () => {
    const s = await state();
    await saveConfigs(s, '1', schema, { account: 'demo', api_key: 'SECRET' });
    expect(await s.get('1', 'cfg')).not.toContain('SECRET');
    expect((await loadConfigs(s, '1', schema)).api_key).toBe('SECRET');
  });
});
