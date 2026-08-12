import { describe, it, expect } from 'vitest';
import { createSqliteStore } from './sqlite/index.js';
import { createRepositories } from './repositories.js';
import { SecretCipher } from '../security/crypto.js';

const cipher = new SecretCipher({ key: 'b'.repeat(64) });
const makeStore = async () => {
  const s = await createSqliteStore({ path: ':memory:' });
  await s.migrate();
  return s;
};
const repos = async () => createRepositories(await makeStore(), cipher);
// Backdated timestamp in the store's canonical format (ISO-8601 UTC, `Z` suffix).
// Computed locally so fixtures do not depend on the kit's own cutoff helpers.
const isoDaysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

describe('InstallRepo', () => {
  it('upsert + find + COALESCE (a null does not overwrite) + external_account', async () => {
    const r = await repos();
    await r.installs.upsert({ installation_id: 'inst_1', shop_domain: 'a.myshop.com', shop_name: 'A', status: 'inactive' });
    await r.installs.upsert({ installation_id: 'inst_1', status: 'active' }); // no shop_name -> COALESCE keeps it
    await r.installs.setExternalAccount('inst_1', 'boutiquea', 'Boutique A');
    const row = await r.installs.find('inst_1');
    expect(row?.status).toBe('active');
    expect(row?.shop_name).toBe('A');
    expect(row?.external_account_ref).toBe('boutiquea');
    expect(row?.external_account_name).toBe('Boutique A');
  });

  it('setStatus + listActive', async () => {
    const r = await repos();
    await r.installs.upsert({ installation_id: 'a', status: 'active' });
    await r.installs.upsert({ installation_id: 'b', status: 'active' });
    await r.installs.setStatus('b', 'inactive', { deactivated_at: '2026-06-21' });
    expect((await r.installs.listActive()).map((a) => a.installation_id)).toEqual(['a']);
  });
});

describe('CursorRepo (per-source cursor)', () => {
  it('set/get scoped by source_key', async () => {
    const r = await repos();
    await r.cursors.set('inst', 'orders', '101', { last_synced_at: '2026-06-20', items: 5 });
    await r.cursors.set('inst', 'orders', '102', { last_synced_at: '2026-06-19', items: 3 });
    expect((await r.cursors.get('inst', 'orders', '101'))?.last_synced_at).toBe('2026-06-20');
    expect((await r.cursors.get('inst', 'orders', '102'))?.items).toBe(3);
    expect(await r.cursors.get('inst', 'orders', '999')).toBeUndefined();
  });
});

describe('CursorRepo - consecutive_failures & health helpers (E3/E5)', () => {
  it('defaults consecutive_failures to 0 and persists/keeps it via COALESCE', async () => {
    const r = await repos();
    await r.cursors.set('inst', 'orders', '', { last_synced_at: '2026-06-20' });
    expect((await r.cursors.get('inst', 'orders', ''))?.consecutive_failures).toBe(0);
    // Set a count explicitly.
    await r.cursors.set('inst', 'orders', '', { last_synced_at: null, last_status: 'error', consecutive_failures: 3 });
    expect((await r.cursors.get('inst', 'orders', ''))?.consecutive_failures).toBe(3);
    // Omitting it on a later write keeps the previous value (COALESCE).
    await r.cursors.set('inst', 'orders', '', { last_synced_at: '2026-06-21', last_status: 'ok' });
    expect((await r.cursors.get('inst', 'orders', ''))?.consecutive_failures).toBe(3);
  });

  it('countInError + listByInstallation', async () => {
    const r = await repos();
    await r.cursors.set('inst', 'orders', '', { last_synced_at: null, last_status: 'error' });
    await r.cursors.set('inst', 'products', '', { last_synced_at: '2026-06-21', last_status: 'ok' });
    expect(await r.cursors.countInError()).toBe(1);
    expect(await r.cursors.listByInstallation('inst')).toHaveLength(2);
  });
});

describe('RejectedItemRepo (E4 dead-letter)', () => {
  it('adds and lists rejected items (newest first, bounded)', async () => {
    const r = await repos();
    await r.rejectedItems.add({ installation_id: 'inst', run_id: 1, entity: 'orders', payload_json: '{"id":1}', reason: 'bad' });
    await r.rejectedItems.add({ installation_id: 'inst', run_id: 1, entity: 'orders', payload_json: '{"id":2}', reason: 'bad' });
    await r.rejectedItems.add({ installation_id: 'other', run_id: 1, entity: 'orders', payload_json: '{"id":3}' });
    const list = await r.rejectedItems.listByInstallation('inst');
    expect(list).toHaveLength(2);
    expect(JSON.parse(list[0]?.payload_json ?? '{}').id).toBe(2); // newest first
  });

  it('purgeOlderThan removes old rows, keeps recent', async () => {
    const store = await makeStore();
    const r = createRepositories(store, cipher);
    await r.rejectedItems.add({ installation_id: 'inst', payload_json: '{"id":1}' });
    store.db.prepare(`INSERT INTO rejected_item (installation_id, payload_json, created_at) VALUES ('inst','{}', ?)`).run(isoDaysAgo(100));
    expect(await r.rejectedItems.purgeOlderThan(30)).toBe(1);
    expect(await r.rejectedItems.listByInstallation('inst')).toHaveLength(1);
  });
});

describe('RunRepo', () => {
  it('start / finish / recent', async () => {
    const r = await repos();
    const id = await r.runs.start('inst');
    await r.runs.finish(id, 'partial', { errors: ['store 3'] });
    const recent = await r.runs.recent('inst');
    expect(recent[0]?.status).toBe('partial');
    expect(recent[0]?.summary_json).toContain('errors');
  });
});

describe('IntegrationStateRepo', () => {
  it('plaintext value', async () => {
    const r = await repos();
    await r.state.set('inst', 'pref_lang', 'fr');
    expect(await r.state.get('inst', 'pref_lang')).toBe('fr');
  });

  it('secret encrypted at rest, decrypted on read', async () => {
    const r = await repos();
    await r.state.setSecret('inst', 'hiboutik_api_key', 'topsecret');
    expect(await r.state.get('inst', 'hiboutik_api_key')).toBe('topsecret');
  });
});

describe('RunRepo.finish (unserializable summary)', () => {
  it('never leaves a run stuck in running and persists a safe fallback', async () => {
    const r = await repos();
    const id = await r.runs.start('inst');
    const circular: Record<string, unknown> = {};
    circular.self = circular; // circular reference -> JSON.stringify throws
    await expect(r.runs.finish(id, 'failed', circular)).resolves.toBeUndefined();
    const row = (await r.runs.recent('inst'))[0];
    expect(row?.status).toBe('failed');
    expect(row?.summary_json).toBe('{"error":"unserializable summary"}');
  });
});

describe('InstallRepo.list + countByStatus (admin)', () => {
  it('paginates, filters by status and by free-text q, and counts per status', async () => {
    const r = await repos();
    await r.installs.upsert({ installation_id: 'inst_1', shop_domain: 'alpha.myshop.com', shop_name: 'Alpha', status: 'active' });
    await r.installs.upsert({ installation_id: 'inst_2', shop_domain: 'beta.myshop.com', shop_name: 'Beta', status: 'active' });
    await r.installs.upsert({ installation_id: 'inst_3', shop_domain: 'gamma.other.com', shop_name: 'Gamma', status: 'inactive' });

    const all = await r.installs.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(3);
    expect(all.items).toHaveLength(3);

    const active = await r.installs.list({ status: 'active', limit: 50, offset: 0 });
    expect(active.total).toBe(2);
    expect(active.items.every((i) => i.status === 'active')).toBe(true);

    const byQ = await r.installs.list({ q: 'beta', limit: 50, offset: 0 });
    expect(byQ.total).toBe(1);
    expect(byQ.items[0]?.installation_id).toBe('inst_2');

    const page = await r.installs.list({ limit: 2, offset: 0 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3); // total ignores the page window

    expect(await r.installs.countByStatus()).toEqual({ active: 2, inactive: 1 });
  });

  it('treats LIKE wildcards in the search term literally (escapes % and _)', async () => {
    const r = await repos();
    await r.installs.upsert({ installation_id: 'has_underscore', shop_name: 'X', status: 'active' });
    await r.installs.upsert({ installation_id: 'plain', shop_name: 'Y', status: 'active' });
    // Unescaped, q='_' would match every row (`_` = any char); escaped, only the literal underscore.
    const res = await r.installs.list({ q: '_', limit: 50, offset: 0 });
    expect(res.total).toBe(1);
    expect(res.items[0]?.installation_id).toBe('has_underscore');
  });
});

describe('WebhookLogRepo (admin views)', () => {
  it('listByInstallation paginates + filters by event/signature; counters + last event', async () => {
    const r = await repos();
    await r.webhookLog.log({ event: 'installed', installation_id: 'inst', signature_ok: true, payload_json: '{"a":1}' });
    await r.webhookLog.log({ event: 'activated', installation_id: 'inst', signature_ok: true, payload_json: '{"a":2}' });
    await r.webhookLog.log({ event: 'activated', installation_id: 'inst', signature_ok: false, payload_json: '{"a":3}' });
    await r.webhookLog.log({ event: 'installed', installation_id: 'other', signature_ok: true, payload_json: '{}' });

    const scoped = await r.webhookLog.listByInstallation('inst', { limit: 50, offset: 0 });
    expect(scoped.total).toBe(3); // 'other' excluded
    expect(scoped.items[0]?.event).toBe('activated'); // newest first

    const refusedOnly = await r.webhookLog.listByInstallation('inst', { signatureOk: false, limit: 50, offset: 0 });
    expect(refusedOnly.total).toBe(1);

    const byEvent = await r.webhookLog.listByInstallation('inst', { event: 'activated', limit: 50, offset: 0 });
    expect(byEvent.total).toBe(2);

    const since = await r.webhookLog.countSince(24);
    expect(since.total).toBe(4);
    expect(since.refused).toBe(1);

    expect((await r.webhookLog.lastForInstallation('inst'))?.event).toBe('activated');
    expect(await r.webhookLog.lastForInstallation('nobody')).toBeUndefined();
  });
});

describe('WebhookSeenRepo.countByInstallationSince', () => {
  it('counts retained signatures for an installation within the window', async () => {
    const store = await makeStore();
    const r = createRepositories(store, cipher);
    await r.webhookSeen.claim('inst', 'k1');
    await r.webhookSeen.claim('inst', 'k2');
    await r.webhookSeen.claim('other', 'k3');
    store.db.prepare(`INSERT INTO webhook_seen (installation_id, dedup_key, created_at) VALUES ('inst','k-old', ?)`).run(isoDaysAgo(30));
    expect(await r.webhookSeen.countByInstallationSince('inst', 7)).toBe(2); // old one outside window
    expect(await r.webhookSeen.countByInstallationSince('other', 7)).toBe(1);
  });
});

describe('RunRepo.list (admin)', () => {
  it('paginates runs newest first with a total', async () => {
    const r = await repos();
    for (let i = 0; i < 5; i++) {
      const id = await r.runs.start('inst');
      await r.runs.finish(id, 'ok', { i });
    }
    const page = await r.runs.list('inst', { limit: 2, offset: 0 });
    expect(page.total).toBe(5);
    expect(page.items).toHaveLength(2);
    expect(JSON.parse(page.items[0]?.summary_json ?? '{}').i).toBe(4); // newest first
  });
});

describe('RunRepo — clamp & retention', () => {
  it('recent() clamps the caller limit to at most 200', async () => {
    const r = await repos();
    for (let i = 0; i < 205; i++) {
      const id = await r.runs.start('inst');
      await r.runs.finish(id, 'ok', { i });
    }
    expect(await r.runs.recent('inst', 100000)).toHaveLength(200);
  });

  it('purgeOlderThan removes old runs, keeps recent', async () => {
    const store = await makeStore();
    const r = createRepositories(store, cipher);
    const id = await r.runs.start('inst');
    await r.runs.finish(id, 'ok', {});
    store.db.prepare(`INSERT INTO sync_run (installation_id, status, started_at) VALUES ('inst','ok', ?)`).run(isoDaysAgo(100));
    expect(await r.runs.purgeOlderThan(30)).toBe(1);
    expect(await r.runs.recent('inst')).toHaveLength(1);
  });
});

describe('IntegrationStateRepo.listMeta — SECURITY INVARIANT', () => {
  it('never materializes the value of an ENCRYPTED row (preview NULL for secrets)', async () => {
    const r = await repos();
    await r.state.set('inst', 'pref_lang', 'fr');
    await r.state.setSecret('inst', 'hiboutik_api_key', 'topsecret-должно-never-leak');

    const meta = await r.state.listMeta('inst');
    const secret = meta.find((m) => m.key === 'hiboutik_api_key');
    const plain = meta.find((m) => m.key === 'pref_lang');

    // The encrypted secret: flagged, length exposed, but the VALUE never surfaces.
    expect(secret?.encrypted).toBe(1);
    expect(secret?.value_preview).toBeNull();
    expect(secret?.value_length).toBeGreaterThan(0);
    // Belt-and-suspenders: the plaintext secret must appear NOWHERE in the serialized meta.
    expect(JSON.stringify(meta)).not.toContain('topsecret');

    // A non-encrypted value is previewable.
    expect(plain?.encrypted).toBe(0);
    expect(plain?.value_preview).toBe('fr');
  });

  it('truncates a long PLAINTEXT preview to 200 chars while reporting the full length', async () => {
    const r = await repos();
    await r.state.set('inst', 'big', 'x'.repeat(500));
    const meta = (await r.state.listMeta('inst')).find((m) => m.key === 'big');
    expect(meta?.value_preview).toBe('x'.repeat(200));
    expect(meta?.value_preview?.length).toBe(200);
    expect(meta?.value_length).toBe(500);
  });
});

describe('InboundEventRepo.listByInstallation (admin)', () => {
  it('paginates inbound events scoped to the installation', async () => {
    const r = await repos();
    await r.inboundEvents.claim('inst', 'idem-1', 'sync');
    await r.inboundEvents.claim('inst', 'idem-2', 'sync');
    await r.inboundEvents.claim('other', 'idem-3', 'sync');
    const page = await r.inboundEvents.listByInstallation('inst', { limit: 50, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.items.every((e) => e.installation_id === 'inst')).toBe(true);
  });
});

describe('RejectedItemRepo (admin filters + scoped delete)', () => {
  it('list/count/countByEntity across installations and filters', async () => {
    const r = await repos();
    await r.rejectedItems.add({ installation_id: 'inst', entity: 'orders', payload_json: '{"id":1}', reason: 'schema' });
    await r.rejectedItems.add({ installation_id: 'inst', entity: 'orders', payload_json: '{"id":2}', reason: 'schema' });
    await r.rejectedItems.add({ installation_id: 'inst', entity: 'customers', payload_json: '{"id":3}', reason: 'dup' });
    await r.rejectedItems.add({ installation_id: 'other', entity: 'orders', payload_json: '{"id":4}', reason: 'schema' });

    expect(await r.rejectedItems.count({})).toBe(4);
    expect(await r.rejectedItems.count({ installationId: 'inst' })).toBe(3);
    expect(await r.rejectedItems.count({ entity: 'orders' })).toBe(3);
    expect((await r.rejectedItems.list({ installationId: 'inst', entity: 'orders', limit: 50, offset: 0 })).total).toBe(2);
    expect(await r.rejectedItems.countByEntity('inst')).toEqual([
      { entity: 'orders', n: 2 },
      { entity: 'customers', n: 1 },
    ]);
  });

  it('deleteByIds is SCOPED to the installation (never deletes another tenant rows)', async () => {
    const r = await repos();
    await r.rejectedItems.add({ installation_id: 'inst', entity: 'orders', payload_json: '{"id":1}' });
    await r.rejectedItems.add({ installation_id: 'other', entity: 'orders', payload_json: '{"id":2}' });
    const instRows = (await r.rejectedItems.list({ installationId: 'inst', limit: 50, offset: 0 })).items;
    const otherRows = (await r.rejectedItems.list({ installationId: 'other', limit: 50, offset: 0 })).items;
    const otherId = otherRows[0]!.id;

    // Attempt to delete the OTHER tenant's row via inst's scope -> no-op.
    expect(await r.rejectedItems.deleteByIds('inst', [otherId])).toBe(0);
    expect(await r.rejectedItems.count({ installationId: 'other' })).toBe(1); // untouched

    // Deleting inst's own row works.
    expect(await r.rejectedItems.deleteByIds('inst', [instRows[0]!.id])).toBe(1);
    expect(await r.rejectedItems.count({ installationId: 'inst' })).toBe(0);

    // Empty / non-integer id lists are safe no-ops.
    expect(await r.rejectedItems.deleteByIds('other', [])).toBe(0);
  });
});

describe('AuditRepo (append-only trail)', () => {
  it('adds entries (metadata only) and lists newest first; purge by age', async () => {
    const store = await makeStore();
    const r = createRepositories(store, cipher);
    await r.audit.add({ action: 'login', ip: '10.0.0.1' });
    await r.audit.add({ action: 'sync', installation_id: 'inst', target: 'inst', details: { full: true } });
    const page = await r.audit.list({ limit: 50, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.items[0]?.action).toBe('sync'); // newest first
    expect(JSON.parse(page.items[0]?.details_json ?? '{}').full).toBe(true);

    // Backdate one row and purge older than 30 days.
    store.db.prepare(`UPDATE audit_log SET at = ? WHERE action = 'login'`).run(isoDaysAgo(100));
    expect(await r.audit.purgeOlderThan(30)).toBe(1);
    expect((await r.audit.list({ limit: 50, offset: 0 })).total).toBe(1);
  });

  it('never throws on an unserializable details payload', async () => {
    const r = await repos();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(r.audit.add({ action: 'x', details: circular })).resolves.toBeUndefined();
    expect((await r.audit.list({ limit: 10, offset: 0 })).items[0]?.details_json).toBeNull();
  });
});

describe('Retention (purgeOlderThan)', () => {
  it('purges webhook_log / webhook_seen / inbound_event rows older than N days, keeps recent ones', async () => {
    const store = await makeStore();
    const r2 = createRepositories(store, cipher);

    // Fresh rows (created_at/received_at stamped now) must survive a 30-day purge.
    await r2.webhookLog.log({ event: 'install', installation_id: 'inst', signature_ok: true, payload_json: '{}' });
    await r2.webhookSeen.claim('inst', 'k-fresh');
    await r2.inboundEvents.claim('inst', 'idem-fresh', 'sync');

    // Backdate one row per table to ~100 days ago so the purge removes them.
    store.db.prepare(`UPDATE webhook_log SET created_at = ?`).run(isoDaysAgo(100));
    store.db.prepare(`INSERT INTO webhook_seen (installation_id, dedup_key, created_at) VALUES ('inst','k-old', ?)`).run(isoDaysAgo(100));
    store.db.prepare(`UPDATE inbound_event SET received_at = ? WHERE idempotency_key = 'idem-fresh'`).run(isoDaysAgo(100));

    expect(await r2.webhookLog.purgeOlderThan(30)).toBe(1);
    expect(await r2.webhookSeen.purgeOlderThan(30)).toBe(1); // old one gone, fresh one kept
    expect(await r2.inboundEvents.purgeOlderThan(30)).toBe(1);

    // The remaining fresh webhook_seen row survives.
    expect(await r2.webhookSeen.claim('inst', 'k-fresh')).toBe(false); // still present -> replay blocked
  });
});
