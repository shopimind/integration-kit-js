import { describe, it, expect } from 'vitest';
import { createSqliteStore } from '../store/sqlite/index.js';
import { createRepositories, type Repositories } from '../store/repositories.js';
import { SecretCipher } from '../security/crypto.js';
import { buildAdminData } from './admin-data.js';
import { describeIntegration } from '../integration/describe.js';
import { defineIntegration } from '../integration/define-integration.js';

const cipher = new SecretCipher({ key: 'c'.repeat(64) });
const DEMO = describeIntegration(
  defineIntegration({
    slug: 'demo',
    meta: { name: 'Demo', version: '1.0.0' },
    configSchema: { fields: [] },
    parseSettings: () => ({}),
    testConnection: async () => true,
    syncSteps: [],
  }),
);
const setup = async (): Promise<{ repos: Repositories; data: ReturnType<typeof buildAdminData> }> => {
  const store = await createSqliteStore({ path: ':memory:' });
  await store.migrate();
  const repos = createRepositories(store, cipher);
  const data = buildAdminData(repos, { kitVersion: '9.9.9', now: () => 1_700_000_000_000, integration: DEMO });
  return { repos, data };
};

describe('buildAdminData.meta', () => {
  it('summarizes installations, webhooks (24h) and rejected items', async () => {
    const { repos, data } = await setup();
    await repos.installs.upsert({ installation_id: 'a', status: 'active' });
    await repos.installs.upsert({ installation_id: 'b', status: 'inactive' });
    await repos.webhookLog.log({ event: 'x', installation_id: 'a', signature_ok: true, payload_json: '{}' });
    await repos.webhookLog.log({ event: 'x', installation_id: 'a', signature_ok: false, payload_json: '{}' });
    await repos.rejectedItems.add({ installation_id: 'a', entity: 'orders', payload_json: '{}' });

    const meta = await data.meta();
    expect(meta.kitVersion).toBe('9.9.9');
    expect(meta.generatedAt).toBe('2023-11-14T22:13:20.000Z');
    expect(meta.installations.total).toBe(2);
    expect(meta.installations.byStatus).toEqual({ active: 1, inactive: 1 });
    expect(meta.webhooks24h).toEqual({ total: 2, refused: 1 });
    expect(meta.rejected.total).toBe(1);
    expect(meta.rejected.byEntity).toEqual([{ entity: 'orders', n: 1 }]);
  });
});

describe('buildAdminData.installation', () => {
  it('returns null for an unknown installation', async () => {
    const { data } = await setup();
    expect(await data.installation('nope')).toBeNull();
  });

  it('aggregates an installation without leaking secrets in state', async () => {
    const { repos, data } = await setup();
    await repos.installs.upsert({ installation_id: 'a', shop_name: 'Alpha', status: 'active' });
    await repos.state.set('a', 'pref', 'fr');
    await repos.state.setSecret('a', 'api_key', 'super-secret-value');
    const detail = await data.installation('a');
    expect(detail?.install.shop_name).toBe('Alpha');
    // The secret value must never surface through the state metadata.
    expect(JSON.stringify(detail?.state)).not.toContain('super-secret-value');
    const secretMeta = detail?.state.find((s) => s.key === 'api_key');
    expect(secretMeta?.encrypted).toBe(1);
    expect(secretMeta?.value_preview).toBeNull();
  });
});

describe('buildAdminData — PII masking on read', () => {
  it('masks emails/phones in webhook payloads', async () => {
    const { repos, data } = await setup();
    await repos.webhookLog.log({
      event: 'installed',
      installation_id: 'a',
      signature_ok: true,
      payload_json: '{"email":"buyer@shop.com","phone":"+33612345678"}',
    });
    const page = await data.webhooks('a', { limit: 50, offset: 0 });
    const payload = page.items[0]?.payload_json ?? '';
    expect(payload).not.toContain('buyer@shop.com');
    expect(payload).toContain('b•••@•••.com');
  });

  it('masks PII in rejected-item payloads (global view)', async () => {
    const { repos, data } = await setup();
    await repos.rejectedItems.add({ installation_id: 'a', entity: 'customers', payload_json: '{"email":"leaky@corp.io"}' });
    const page = await data.rejected({ limit: 50, offset: 0 });
    const payload = page.items[0]?.payload_json ?? '';
    expect(payload).not.toContain('leaky@corp.io');
    expect(payload).toContain('l•••@•••.io');
  });
});
