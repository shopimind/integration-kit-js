import { describe, it, expect } from 'vitest';
import { openDatabase } from '../store/db.js';
import { createRepositories, type Repositories } from '../store/repositories.js';
import { SecretCipher } from '../security/crypto.js';
import { buildAdminActions, type ReprovisionOutcome } from './admin-actions.js';

const cipher = new SecretCipher({ key: 'd'.repeat(64) });
const setup = (): { repos: Repositories; actions: ReturnType<typeof buildAdminActions>; calls: () => string[] } => {
  const repos = createRepositories(openDatabase(':memory:'), cipher);
  const calls: string[] = [];
  const actions = buildAdminActions(repos, {
    reprovision: async (id): Promise<ReprovisionOutcome> => {
      calls.push(id);
      return { sources: 1, defs: 2, events: 0, orderStatuses: 0, errors: [] };
    },
  });
  return { repos, actions, calls: () => calls };
};
const firstRejectedId = (repos: Repositories, installationId: string): number =>
  repos.rejectedItems.list({ installationId, limit: 1, offset: 0 }).items[0]!.id;

describe('buildAdminActions', () => {
  it('purgeRejected only deletes within the named installation', () => {
    const { repos, actions } = setup();
    repos.rejectedItems.add({ installation_id: 'a', entity: 'orders', payload_json: '{"id":1}' });
    repos.rejectedItems.add({ installation_id: 'b', entity: 'orders', payload_json: '{"id":2}' });
    const bId = firstRejectedId(repos, 'b');
    // Cross-tenant attempt is a no-op.
    expect(actions.purgeRejected('a', [bId])).toBe(0);
    expect(repos.rejectedItems.count({ installationId: 'b' })).toBe(1);
    // Own item deletes.
    expect(actions.purgeRejected('a', [firstRejectedId(repos, 'a')])).toBe(1);
    expect(repos.rejectedItems.count({ installationId: 'a' })).toBe(0);
  });

  it('revealRejected returns the RAW (un-masked) payload; null for unknown id', () => {
    const { repos, actions } = setup();
    repos.rejectedItems.add({ installation_id: 'a', entity: 'customers', payload_json: '{"email":"real@corp.io"}' });
    const id = firstRejectedId(repos, 'a');
    const revealed = actions.revealRejected(id);
    expect(revealed?.installation_id).toBe('a');
    expect(revealed?.payload_json).toContain('real@corp.io'); // un-masked on purpose (audited)
    expect(actions.revealRejected(999999)).toBeNull();
  });

  it('revealWebhook enforces installation scope', () => {
    const { repos, actions } = setup();
    repos.webhookLog.log({ event: 'installed', installation_id: 'a', signature_ok: true, payload_json: '{"x":1}' });
    const logId = repos.webhookLog.listByInstallation('a', { limit: 1, offset: 0 }).items[0]!.id;
    expect(actions.revealWebhook('a', logId)?.payload_json).toContain('"x":1');
    expect(actions.revealWebhook('b', logId)).toBeNull(); // wrong installation -> refused
    expect(actions.revealWebhook('a', 999999)).toBeNull();
  });

  it('reprovision delegates to the injected closure', async () => {
    const { actions, calls } = setup();
    const out = await actions.reprovision('inst_x');
    expect(out.defs).toBe(2);
    expect(calls()).toEqual(['inst_x']);
  });

  it('audit appends a metadata-only entry', () => {
    const { repos, actions } = setup();
    actions.audit({ action: 'sync', installationId: 'a', target: 'a', details: { full: true }, ip: '1.2.3.4' });
    const row = repos.audit.list({ limit: 10, offset: 0 }).items[0];
    expect(row?.action).toBe('sync');
    expect(row?.installation_id).toBe('a');
    expect(JSON.parse(row?.details_json ?? '{}').full).toBe(true);
  });
});
