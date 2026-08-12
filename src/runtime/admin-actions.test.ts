import { describe, it, expect } from 'vitest';
import { createSqliteStore } from '../store/sqlite/index.js';
import { createRepositories, type Repositories } from '../store/repositories.js';
import { SecretCipher } from '../security/crypto.js';
import { buildAdminActions, type ReprovisionOutcome } from './admin-actions.js';

const cipher = new SecretCipher({ key: 'd'.repeat(64) });
const setup = async (): Promise<{ repos: Repositories; actions: ReturnType<typeof buildAdminActions>; calls: () => string[] }> => {
  const store = await createSqliteStore({ path: ':memory:' });
  await store.migrate();
  const repos = createRepositories(store, cipher);
  const calls: string[] = [];
  const actions = buildAdminActions(repos, {
    reprovision: async (id): Promise<ReprovisionOutcome> => {
      calls.push(id);
      return { sources: 1, defs: 2, events: 0, orderStatuses: 0, errors: [] };
    },
  });
  return { repos, actions, calls: () => calls };
};
const firstRejectedId = async (repos: Repositories, installationId: string): Promise<number> =>
  (await repos.rejectedItems.list({ installationId, limit: 1, offset: 0 })).items[0]!.id;

describe('buildAdminActions', () => {
  it('purgeRejected only deletes within the named installation', async () => {
    const { repos, actions } = await setup();
    await repos.rejectedItems.add({ installation_id: 'a', entity: 'orders', payload_json: '{"id":1}' });
    await repos.rejectedItems.add({ installation_id: 'b', entity: 'orders', payload_json: '{"id":2}' });
    const bId = await firstRejectedId(repos, 'b');
    // Cross-tenant attempt is a no-op.
    expect(await actions.purgeRejected('a', [bId])).toBe(0);
    expect(await repos.rejectedItems.count({ installationId: 'b' })).toBe(1);
    // Own item deletes.
    expect(await actions.purgeRejected('a', [await firstRejectedId(repos, 'a')])).toBe(1);
    expect(await repos.rejectedItems.count({ installationId: 'a' })).toBe(0);
  });

  it('revealRejected returns the RAW (un-masked) payload; null for unknown id', async () => {
    const { repos, actions } = await setup();
    await repos.rejectedItems.add({ installation_id: 'a', entity: 'customers', payload_json: '{"email":"real@corp.io"}' });
    const id = await firstRejectedId(repos, 'a');
    const revealed = await actions.revealRejected(id);
    expect(revealed?.installation_id).toBe('a');
    expect(revealed?.payload_json).toContain('real@corp.io'); // un-masked on purpose (audited)
    expect(await actions.revealRejected(999999)).toBeNull();
  });

  it('revealWebhook enforces installation scope', async () => {
    const { repos, actions } = await setup();
    await repos.webhookLog.log({ event: 'installed', installation_id: 'a', signature_ok: true, payload_json: '{"x":1}' });
    const logId = (await repos.webhookLog.listByInstallation('a', { limit: 1, offset: 0 })).items[0]!.id;
    expect((await actions.revealWebhook('a', logId))?.payload_json).toContain('"x":1');
    expect(await actions.revealWebhook('b', logId)).toBeNull(); // wrong installation -> refused
    expect(await actions.revealWebhook('a', 999999)).toBeNull();
  });

  it('reprovision delegates to the injected closure', async () => {
    const { actions, calls } = await setup();
    const out = await actions.reprovision('inst_x');
    expect(out.defs).toBe(2);
    expect(calls()).toEqual(['inst_x']);
  });

  it('audit appends a metadata-only entry', async () => {
    const { repos, actions } = await setup();
    await actions.audit({ action: 'sync', installationId: 'a', target: 'a', details: { full: true }, ip: '1.2.3.4' });
    const row = (await repos.audit.list({ limit: 10, offset: 0 })).items[0];
    expect(row?.action).toBe('sync');
    expect(row?.installation_id).toBe('a');
    expect(JSON.parse(row?.details_json ?? '{}').full).toBe(true);
  });
});
