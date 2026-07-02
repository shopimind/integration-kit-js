import { describe, it, expect } from 'vitest';
import { openDatabase } from './db.js';
import { createRepositories } from './repositories.js';
import { SecretCipher } from '../security/crypto.js';

const cipher = new SecretCipher({ key: 'b'.repeat(64) });
const repos = () => createRepositories(openDatabase(':memory:'), cipher);

describe('InstallRepo', () => {
  it('upsert + find + COALESCE (a null does not overwrite) + external_account', () => {
    const r = repos();
    r.installs.upsert({ installation_id: 'inst_1', shop_domain: 'a.myshop.com', shop_name: 'A', status: 'inactive' });
    r.installs.upsert({ installation_id: 'inst_1', status: 'active' }); // no shop_name -> COALESCE keeps it
    r.installs.setExternalAccount('inst_1', 'boutiquea', 'Boutique A');
    const row = r.installs.find('inst_1');
    expect(row?.status).toBe('active');
    expect(row?.shop_name).toBe('A');
    expect(row?.external_account_ref).toBe('boutiquea');
    expect(row?.external_account_name).toBe('Boutique A');
  });

  it('setStatus + listActive', () => {
    const r = repos();
    r.installs.upsert({ installation_id: 'a', status: 'active' });
    r.installs.upsert({ installation_id: 'b', status: 'active' });
    r.installs.setStatus('b', 'inactive', { deactivated_at: '2026-06-21' });
    expect(r.installs.listActive().map((a) => a.installation_id)).toEqual(['a']);
  });
});

describe('CursorRepo (per-source cursor)', () => {
  it('set/get scoped by source_key', () => {
    const r = repos();
    r.cursors.set('inst', 'orders', '101', { last_synced_at: '2026-06-20', items: 5 });
    r.cursors.set('inst', 'orders', '102', { last_synced_at: '2026-06-19', items: 3 });
    expect(r.cursors.get('inst', 'orders', '101')?.last_synced_at).toBe('2026-06-20');
    expect(r.cursors.get('inst', 'orders', '102')?.items).toBe(3);
    expect(r.cursors.get('inst', 'orders', '999')).toBeUndefined();
  });
});

describe('CursorRepo - consecutive_failures & health helpers (E3/E5)', () => {
  it('defaults consecutive_failures to 0 and persists/keeps it via COALESCE', () => {
    const r = repos();
    r.cursors.set('inst', 'orders', '', { last_synced_at: '2026-06-20' });
    expect(r.cursors.get('inst', 'orders', '')?.consecutive_failures).toBe(0);
    // Set a count explicitly.
    r.cursors.set('inst', 'orders', '', { last_synced_at: null, last_status: 'error', consecutive_failures: 3 });
    expect(r.cursors.get('inst', 'orders', '')?.consecutive_failures).toBe(3);
    // Omitting it on a later write keeps the previous value (COALESCE).
    r.cursors.set('inst', 'orders', '', { last_synced_at: '2026-06-21', last_status: 'ok' });
    expect(r.cursors.get('inst', 'orders', '')?.consecutive_failures).toBe(3);
  });

  it('countInError + listByInstallation', () => {
    const r = repos();
    r.cursors.set('inst', 'orders', '', { last_synced_at: null, last_status: 'error' });
    r.cursors.set('inst', 'products', '', { last_synced_at: '2026-06-21', last_status: 'ok' });
    expect(r.cursors.countInError()).toBe(1);
    expect(r.cursors.listByInstallation('inst')).toHaveLength(2);
  });
});

describe('RejectedItemRepo (E4 dead-letter)', () => {
  it('adds and lists rejected items (newest first, bounded)', () => {
    const r = repos();
    r.rejectedItems.add({ installation_id: 'inst', run_id: 1, entity: 'orders', payload_json: '{"id":1}', reason: 'bad' });
    r.rejectedItems.add({ installation_id: 'inst', run_id: 1, entity: 'orders', payload_json: '{"id":2}', reason: 'bad' });
    r.rejectedItems.add({ installation_id: 'other', run_id: 1, entity: 'orders', payload_json: '{"id":3}' });
    const list = r.rejectedItems.listByInstallation('inst');
    expect(list).toHaveLength(2);
    expect(JSON.parse(list[0]?.payload_json ?? '{}').id).toBe(2); // newest first
  });

  it('purgeOlderThan removes old rows, keeps recent', () => {
    const db = openDatabase(':memory:');
    const r = createRepositories(db, cipher);
    r.rejectedItems.add({ installation_id: 'inst', payload_json: '{"id":1}' });
    db.prepare(`INSERT INTO rejected_item (installation_id, payload_json, created_at) VALUES ('inst','{}', datetime('now','-100 days'))`).run();
    expect(r.rejectedItems.purgeOlderThan(30)).toBe(1);
    expect(r.rejectedItems.listByInstallation('inst')).toHaveLength(1);
  });
});

describe('RunRepo', () => {
  it('start / finish / recent', () => {
    const r = repos();
    const id = r.runs.start('inst');
    r.runs.finish(id, 'partial', { errors: ['store 3'] });
    const recent = r.runs.recent('inst');
    expect(recent[0]?.status).toBe('partial');
    expect(recent[0]?.summary_json).toContain('errors');
  });
});

describe('IntegrationStateRepo', () => {
  it('plaintext value', () => {
    const r = repos();
    r.state.set('inst', 'pref_lang', 'fr');
    expect(r.state.get('inst', 'pref_lang')).toBe('fr');
  });

  it('secret encrypted at rest, decrypted on read', () => {
    const r = repos();
    r.state.setSecret('inst', 'hiboutik_api_key', 'topsecret');
    expect(r.state.get('inst', 'hiboutik_api_key')).toBe('topsecret');
  });
});

describe('RunRepo.finish (unserializable summary)', () => {
  it('never leaves a run stuck in running and persists a safe fallback', () => {
    const r = repos();
    const id = r.runs.start('inst');
    const circular: Record<string, unknown> = {};
    circular.self = circular; // circular reference -> JSON.stringify throws
    expect(() => r.runs.finish(id, 'failed', circular)).not.toThrow();
    const row = r.runs.recent('inst')[0];
    expect(row?.status).toBe('failed');
    expect(row?.summary_json).toBe('{"error":"unserializable summary"}');
  });
});

describe('Retention (purgeOlderThan)', () => {
  it('purges webhook_log / webhook_seen / inbound_event rows older than N days, keeps recent ones', () => {
    const r = repos();
    const db = openDatabase(':memory:');
    const r2 = createRepositories(db, cipher);

    // Fresh rows (created_at/received_at default to now) must survive a 30-day purge.
    r2.webhookLog.log({ event: 'install', installation_id: 'inst', signature_ok: true, payload_json: '{}' });
    r2.webhookSeen.claim('inst', 'k-fresh');
    r2.inboundEvents.claim('inst', 'idem-fresh', 'sync');

    // Backdate one row per table to ~100 days ago so the purge removes them.
    db.prepare(`UPDATE webhook_log SET created_at = datetime('now','-100 days')`).run();
    db.prepare(`INSERT INTO webhook_seen (installation_id, dedup_key, created_at) VALUES ('inst','k-old', datetime('now','-100 days'))`).run();
    db.prepare(`UPDATE inbound_event SET received_at = datetime('now','-100 days') WHERE idempotency_key = 'idem-fresh'`).run();

    expect(r2.webhookLog.purgeOlderThan(30)).toBe(1);
    expect(r2.webhookSeen.purgeOlderThan(30)).toBe(1); // old one gone, fresh one kept
    expect(r2.inboundEvents.purgeOlderThan(30)).toBe(1);

    // The remaining fresh webhook_seen row survives.
    expect(r2.webhookSeen.claim('inst', 'k-fresh')).toBe(false); // still present -> replay blocked
  });
});
