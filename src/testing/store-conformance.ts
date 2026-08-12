/* eslint-disable @typescript-eslint/no-explicit-any */
import type { IntegrationStore } from '../store/port.js';
import { parseStoreTimestamp } from '../store/time.js';

/**
 * STORE CONFORMANCE SUITE — the executable contract of the persistence port.
 *
 * Both official adapters (SQLite, PostgreSQL) run this suite in CI, and a
 * THIRD-PARTY adapter should run it too before being used with the kit:
 *
 *   // my-store.conformance.test.ts (vitest or jest)
 *   import { describe, it, expect } from 'vitest';
 *   import { runStoreConformanceSuite } from '@shopimind/integration-kit-js/store-testing';
 *   runStoreConformanceSuite(() => makeMyStore(), { describe, it, expect });
 *
 * Contract points covered beyond plain CRUD:
 *   - `migrate()` is idempotent (safe to call twice);
 *   - `claim()` is ATOMIC: two concurrent claims of the same key resolve to
 *     exactly one `fresh` / one `true`;
 *   - `state.listMeta()` NEVER materializes an encrypted value (`value_preview`
 *     is null whenever `encrypted` is true);
 *   - upserts merge with COALESCE semantics (a null/omitted field never wipes
 *     a stored value);
 *   - purges honour their ISO cutoffs; searches match literally (`%`/`_` are
 *     not wildcards) and case-insensitively; pagination returns stable totals.
 *
 * The suite is framework-agnostic: pass your test runner's `describe`/`it`/
 * `expect` (vitest and jest are both compatible). `makeStore` must return a
 * FRESH, EMPTY, NOT-YET-MIGRATED store on every call; the suite migrates and
 * closes it itself.
 */

export interface ConformanceTestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void>): void;
  expect(actual: unknown, message?: string): any;
}

export function runStoreConformanceSuite(makeStore: () => Promise<IntegrationStore>, api: ConformanceTestApi): void {
  const { describe, it, expect } = api;

  /** Runs `fn` against a fresh migrated store, closing it afterwards. */
  const withStore = async (fn: (store: IntegrationStore) => Promise<void>): Promise<void> => {
    const store = await makeStore();
    try {
      await store.migrate();
      await fn(store);
    } finally {
      await store.close();
    }
  };

  const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
  const DISTANT_PAST = '2000-01-01T00:00:00.000Z';
  /** The ONE timestamp format the port allows: ISO-8601 UTC with milliseconds and `Z`. */
  const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  describe('store conformance — lifecycle', () => {
    it('migrate() is idempotent and ping() resolves', async () => {
      const store = await makeStore();
      try {
        await store.migrate();
        await store.migrate(); // second run must be a no-op, not an error
        await store.ping();
      } finally {
        await store.close();
      }
    });
  });

  describe('store conformance — timestamp format (the whole time contract rests on it)', () => {
    it('every stored timestamp is ISO-8601 UTC with milliseconds and Z', async () => {
      await withStore(async (s) => {
        // The port compares and orders timestamps as STRINGS. An adapter that lets
        // SQL stamp rows (`datetime('now')`, `now()`) produces a different shape
        // that does not compare against the kit's ISO cutoffs — purges then delete
        // the wrong rows and the dashboard counters silently under-count. Every
        // other test here would still pass, so this is the assertion that catches it.
        await s.installs.upsert({ installation_id: 'ts', shop_domain: 'a.com', status: 'active' });
        await s.installs.setStatus('ts', 'active', { activated_at: '2026-01-01T00:00:00.000Z' });
        await s.state.write('ts', 'k', 'v', false);
        await s.cursors.set('ts', 'e', '', { last_synced_at: '2026-01-01T00:00:00.000Z', last_status: 'ok' });
        const runId = await s.runs.start('ts');
        await s.runs.finish(runId, 'ok', '{}');
        await s.webhookLog.log({ event: 'e', installation_id: 'ts', signature_ok: true, payload_json: '{}' });
        await s.webhookSeen.claim('ts', 'sig');
        const claim = await s.inboundEvents.claim('ts', 'idem', 'a');
        await s.inboundEvents.finish(claim.rowId, 'done', null);
        await s.rejectedItems.add({ installation_id: 'ts', run_id: runId, entity: 'e', source_key: null, payload_json: '{}', reason: null });
        await s.audit.add({ action: 'a', installation_id: 'ts', target: null, details_json: null, ip: null });

        const install = await s.installs.find('ts');
        expect(install!.created_at, 'installs.created_at').toMatch(ISO_UTC);
        expect(install!.updated_at, 'installs.updated_at').toMatch(ISO_UTC);
        expect((await s.state.listMeta('ts'))[0]!.updated_at, 'integration_state.updated_at').toMatch(ISO_UTC);
        expect((await s.cursors.get('ts', 'e', ''))!.updated_at, 'sync_cursor.updated_at').toMatch(ISO_UTC);
        const run = (await s.runs.recent('ts', 1))[0]!;
        expect(run.started_at, 'sync_run.started_at').toMatch(ISO_UTC);
        expect(run.finished_at!, 'sync_run.finished_at').toMatch(ISO_UTC);
        expect((await s.webhookLog.recent(1))[0]!.created_at, 'webhook_log.created_at').toMatch(ISO_UTC);
        const inbound = (await s.inboundEvents.listByInstallation('ts', { limit: 1, offset: 0 })).items[0]!;
        expect(inbound.received_at, 'inbound_event.received_at').toMatch(ISO_UTC);
        expect(inbound.processed_at!, 'inbound_event.processed_at').toMatch(ISO_UTC);
        expect((await s.rejectedItems.listByInstallation('ts', 1))[0]!.created_at, 'rejected_item.created_at').toMatch(ISO_UTC);
        expect((await s.audit.list({ limit: 1, offset: 0 })).items[0]!.at, 'audit_log.at').toMatch(ISO_UTC);
      });
    });

    it('cutoffs are exact at sub-hour distance and within the same calendar day', async () => {
      await withStore(async (s) => {
        // The DISTANT_PAST / FUTURE cutoffs used elsewhere are so far away that a
        // malformed timestamp still lands on the right side by luck. These are the
        // distances where a format mismatch actually shows up.
        await s.webhookLog.log({ event: 'now', installation_id: 'i', signature_ok: true, payload_json: '{}' });
        const written = (await s.webhookLog.recent(1))[0]!.created_at;
        const at = Date.parse(written);

        // A cutoff one second BEFORE the row must not delete it…
        expect(await s.webhookLog.purgeCreatedBefore(new Date(at - 1000).toISOString())).toBe(0);
        // …and it must still be counted from that same instant.
        expect((await s.webhookLog.countSince(new Date(at - 1000).toISOString())).total).toBe(1);
        // A cutoff at midnight of the SAME day must not delete a row from later that day.
        const midnight = new Date(at);
        midnight.setUTCHours(0, 0, 0, 0);
        expect(await s.webhookLog.purgeCreatedBefore(midnight.toISOString())).toBe(0);
        // A cutoff one second AFTER the row does delete it.
        expect(await s.webhookLog.purgeCreatedBefore(new Date(at + 1000).toISOString())).toBe(1);
      });
    });
  });

  describe('store conformance — installs', () => {
    it('upsert inserts, find returns the row, timestamps are parseable', async () => {
      await withStore(async (s) => {
        await s.installs.upsert({ installation_id: 'i1', shop_domain: 'a.com', shop_name: 'Alpha', status: 'active' });
        const row = await s.installs.find('i1');
        expect(row?.shop_domain).toBe('a.com');
        expect(row?.status).toBe('active');
        expect(Number.isNaN(parseStoreTimestamp(row!.created_at))).toBe(false);
        expect(Number.isNaN(parseStoreTimestamp(row!.updated_at))).toBe(false);
        expect(await s.installs.find('ghost')).toBe(undefined);
      });
    });

    it('upsert has COALESCE semantics: a null field never wipes a stored value', async () => {
      await withStore(async (s) => {
        await s.installs.upsert({ installation_id: 'i1', shop_domain: 'a.com', shop_name: 'Alpha', status: 'active' });
        await s.installs.upsert({ installation_id: 'i1', shop_domain: null, shop_name: null, status: 'inactive' });
        const row = await s.installs.find('i1');
        expect(row?.shop_domain).toBe('a.com'); // preserved
        expect(row?.shop_name).toBe('Alpha'); // preserved
        expect(row?.status).toBe('inactive'); // status always follows
      });
    });

    it('setStatus stamps transitions; setExternalAccount records the bridge', async () => {
      await withStore(async (s) => {
        await s.installs.upsert({ installation_id: 'i1', status: 'inactive' });
        await s.installs.setStatus('i1', 'active', { activated_at: '2026-01-01T00:00:00.000Z' });
        let row = await s.installs.find('i1');
        expect(row?.status).toBe('active');
        expect(row?.activated_at).toBe('2026-01-01T00:00:00.000Z');
        await s.installs.setExternalAccount('i1', 'acc-9', 'Big Corp');
        row = await s.installs.find('i1');
        expect(row?.external_account_ref).toBe('acc-9');
        expect(row?.external_account_name).toBe('Big Corp');
      });
    });

    it('setStatus REWRITES the stamps: an omitted one becomes null (documented contract)', async () => {
      await withStore(async (s) => {
        // Deliberately NOT patch semantics — the lifecycle dispatcher relies on a
        // deactivation clearing `activated_at`. An adapter that preserved omitted
        // stamps would build a different timeline from identical calls, so the
        // choice is pinned here rather than left to interpretation.
        await s.installs.upsert({ installation_id: 'i1', status: 'inactive' });
        await s.installs.setStatus('i1', 'active', { activated_at: '2026-01-10T00:00:00.000Z' });
        await s.installs.setStatus('i1', 'inactive', { deactivated_at: '2026-03-02T00:00:00.000Z' });
        const row = await s.installs.find('i1');
        expect(row?.deactivated_at).toBe('2026-03-02T00:00:00.000Z');
        expect(row?.activated_at).toBe(null);
        expect(row?.uninstalled_at).toBe(null);
      });
    });

    it('listActive returns only active installs; countByStatus aggregates', async () => {
      await withStore(async (s) => {
        await s.installs.upsert({ installation_id: 'a', status: 'active' });
        await s.installs.upsert({ installation_id: 'b', status: 'inactive' });
        await s.installs.upsert({ installation_id: 'c', status: 'active' });
        const active = await s.installs.listActive();
        expect(active.map((r) => r.installation_id).sort()).toEqual(['a', 'c']);
        const counts = await s.installs.countByStatus();
        expect(counts['active']).toBe(2);
        expect(counts['inactive']).toBe(1);
      });
    });

    it('list paginates with a stable total, filters by status, searches case-insensitively and literally', async () => {
      await withStore(async (s) => {
        await s.installs.upsert({ installation_id: 'x1', shop_name: 'Maison Bleue', status: 'active' });
        await s.installs.upsert({ installation_id: 'x2', shop_name: 'maison rouge', status: 'inactive' });
        await s.installs.upsert({ installation_id: 'y100%', shop_name: 'Percent', status: 'active' });

        const page = await s.installs.list({ limit: 2, offset: 0 });
        expect(page.total).toBe(3);
        expect(page.items.length).toBe(2);
        const rest = await s.installs.list({ limit: 2, offset: 2 });
        expect(rest.items.length).toBe(1);

        const byStatus = await s.installs.list({ status: 'active', limit: 10, offset: 0 });
        expect(byStatus.total).toBe(2);

        // Case-insensitive substring on id/domain/name.
        const search = await s.installs.list({ q: 'MAISON', limit: 10, offset: 0 });
        expect(search.total).toBe(2);

        // `%` must match literally (no wildcard injection through the search box).
        const literal = await s.installs.list({ q: '100%', limit: 10, offset: 0 });
        expect(literal.total).toBe(1);
        expect(literal.items[0]?.installation_id).toBe('y100%');
      });
    });
  });

  describe('store conformance — state KV', () => {
    it('write/read round-trips values with their encrypted flag; delete removes', async () => {
      await withStore(async (s) => {
        await s.state.write('i1', 'plain', 'hello', false);
        await s.state.write('i1', 'sec', 'CIPHERTEXT', true);
        expect(await s.state.read('i1', 'plain')).toEqual({ value: 'hello', encrypted: false });
        expect(await s.state.read('i1', 'sec')).toEqual({ value: 'CIPHERTEXT', encrypted: true });
        expect(await s.state.read('i1', 'nope')).toBe(undefined);
        expect(await s.state.read('other', 'plain')).toBe(undefined); // scoped by installation

        await s.state.write('i1', 'plain', 'world', false); // overwrite
        expect((await s.state.read('i1', 'plain'))?.value).toBe('world');

        await s.state.delete('i1', 'plain');
        expect(await s.state.read('i1', 'plain')).toBe(undefined);
      });
    });

    it('SECURITY: listMeta never materializes an encrypted value', async () => {
      await withStore(async (s) => {
        await s.state.write('i1', 'big', 'z'.repeat(400), false);
        await s.state.write('i1', 'api_key', 'SUPER-SECRET-'.repeat(40), true);
        const meta = await s.state.listMeta('i1');
        const secret = meta.find((m) => m.key === 'api_key');
        expect(secret?.encrypted).toBe(true);
        expect(secret?.value_preview).toBe(null); // the invariant
        expect(secret!.value_length > 0).toBe(true);
        const plain = meta.find((m) => m.key === 'big');
        expect(plain?.encrypted).toBe(false);
        expect(plain?.value_preview?.length).toBe(200); // preview capped
        expect(plain?.value_length).toBe(400);
        // Sorted by key, scoped by installation.
        expect(meta.map((m) => m.key)).toEqual(['api_key', 'big']);
        expect(await s.state.listMeta('other')).toEqual([]);
      });
    });
  });

  describe('store conformance — cursors', () => {
    it('set/get round-trips, scoped by (installation, entity, source_key)', async () => {
      await withStore(async (s) => {
        expect(await s.cursors.get('i1', 'orders', '')).toBe(undefined);
        await s.cursors.set('i1', 'orders', '', { last_synced_at: '2026-05-01T00:00:00.000Z', last_status: 'ok', items: 5 });
        await s.cursors.set('i1', 'orders', 'store2', { last_synced_at: '2026-05-02T00:00:00.000Z', last_status: 'ok' });
        const global = await s.cursors.get('i1', 'orders', '');
        expect(global?.last_synced_at).toBe('2026-05-01T00:00:00.000Z');
        expect(global?.items).toBe(5);
        expect((await s.cursors.get('i1', 'orders', 'store2'))?.last_synced_at).toBe('2026-05-02T00:00:00.000Z');
        const all = await s.cursors.listByInstallation('i1');
        expect(all.length).toBe(2);
      });
    });

    it('consecutive_failures: omitted keeps the stored counter, explicit overwrites; countInError counts', async () => {
      await withStore(async (s) => {
        await s.cursors.set('i1', 'orders', '', { last_synced_at: null, last_status: 'error', consecutive_failures: 3 });
        // Omitted -> COALESCE keeps 3.
        await s.cursors.set('i1', 'orders', '', { last_synced_at: null, last_status: 'error' });
        expect((await s.cursors.get('i1', 'orders', ''))?.consecutive_failures).toBe(3);
        expect(await s.cursors.countInError()).toBe(1);
        // Explicit 0 -> reset.
        await s.cursors.set('i1', 'orders', '', { last_synced_at: '2026-05-01T00:00:00.000Z', last_status: 'ok', consecutive_failures: 0 });
        expect((await s.cursors.get('i1', 'orders', ''))?.consecutive_failures).toBe(0);
        expect(await s.cursors.countInError()).toBe(0);
      });
    });
  });

  describe('store conformance — runs', () => {
    it('start returns a usable id; finish stamps status/summary; recent/list order newest first', async () => {
      await withStore(async (s) => {
        const id1 = await s.runs.start('i1');
        const id2 = await s.runs.start('i1');
        expect(typeof id1).toBe('number');
        expect(id2 > id1).toBe(true);
        await s.runs.finish(id1, 'ok', '{"steps":1}');
        const recent = await s.runs.recent('i1', 10);
        expect(recent[0]?.id).toBe(id2); // newest first
        expect(recent[1]?.status).toBe('ok');
        expect(recent[1]?.summary_json).toBe('{"steps":1}');
        expect(recent[1]?.finished_at == null).toBe(false);
        const page = await s.runs.list('i1', { limit: 1, offset: 0 });
        expect(page.total).toBe(2);
        expect(page.items.length).toBe(1);
      });
    });

    it('purgeStartedBefore honours the cutoff', async () => {
      await withStore(async (s) => {
        await s.runs.start('i1');
        expect(await s.runs.purgeStartedBefore(DISTANT_PAST)).toBe(0); // nothing older
        expect(await s.runs.purgeStartedBefore(FUTURE)).toBe(1); // everything older than future
        expect((await s.runs.list('i1', { limit: 10, offset: 0 })).total).toBe(0);
      });
    });
  });

  describe('store conformance — inbound events (idempotency)', () => {
    it('claim is atomic: two concurrent claims yield exactly one fresh', async () => {
      await withStore(async (s) => {
        const [a, b] = await Promise.all([
          s.inboundEvents.claim('i1', 'key-1', 'doThing'),
          s.inboundEvents.claim('i1', 'key-1', 'doThing'),
        ]);
        expect([a.fresh, b.fresh].filter(Boolean).length).toBe(1);
        expect(a.rowId).toBe(b.rowId); // both resolved to the same row
      });
    });

    it('finish drives the replay contract: done short-circuits, failed re-executes', async () => {
      await withStore(async (s) => {
        const first = await s.inboundEvents.claim('i1', 'k', null);
        expect(first.fresh).toBe(true);
        await s.inboundEvents.finish(first.rowId, 'failed', 'boom');
        const retry = await s.inboundEvents.claim('i1', 'k', null);
        expect(retry.fresh).toBe(false);
        expect(retry.status).toBe('failed'); // caller may re-execute
        await s.inboundEvents.finish(retry.rowId, 'done', null);
        const replay = await s.inboundEvents.claim('i1', 'k', null);
        expect(replay.status).toBe('done'); // caller short-circuits
        const row = await s.inboundEvents.find('i1', 'k');
        expect(row?.status).toBe('done');
        expect(row?.processed_at == null).toBe(false);
      });
    });

    it('lists per installation and purges by cutoff', async () => {
      await withStore(async (s) => {
        await s.inboundEvents.claim('i1', 'k1', null);
        await s.inboundEvents.claim('i2', 'k2', null);
        const page = await s.inboundEvents.listByInstallation('i1', { limit: 10, offset: 0 });
        expect(page.total).toBe(1);
        expect(await s.inboundEvents.purgeReceivedBefore(DISTANT_PAST)).toBe(0);
        expect(await s.inboundEvents.purgeReceivedBefore(FUTURE)).toBe(2);
      });
    });
  });

  describe('store conformance — webhook dedup (anti-replay)', () => {
    it('claim/release cycle: claim once, replay refused, release re-allows', async () => {
      await withStore(async (s) => {
        expect(await s.webhookSeen.claim('i1', 'sig-1')).toBe(true);
        expect(await s.webhookSeen.claim('i1', 'sig-1')).toBe(false); // replay
        await s.webhookSeen.release('i1', 'sig-1');
        expect(await s.webhookSeen.claim('i1', 'sig-1')).toBe(true); // retry allowed
        expect(await s.webhookSeen.claim('i2', 'sig-1')).toBe(true); // scoped by installation
      });
    });

    it('concurrent claims of the same signature resolve to exactly one true', async () => {
      await withStore(async (s) => {
        const results = await Promise.all([
          s.webhookSeen.claim('i1', 'sig-x'),
          s.webhookSeen.claim('i1', 'sig-x'),
          s.webhookSeen.claim('i1', 'sig-x'),
        ]);
        expect(results.filter(Boolean).length).toBe(1);
      });
    });

    it('counts since a cutoff and purges by cutoff', async () => {
      await withStore(async (s) => {
        await s.webhookSeen.claim('i1', 'a');
        await s.webhookSeen.claim('i1', 'b');
        expect(await s.webhookSeen.countByInstallationSince('i1', DISTANT_PAST)).toBe(2);
        expect(await s.webhookSeen.countByInstallationSince('i1', FUTURE)).toBe(0);
        expect(await s.webhookSeen.purgeCreatedBefore(FUTURE)).toBe(2);
      });
    });
  });

  describe('store conformance — webhook log', () => {
    it('logs, filters, counts and reads back', async () => {
      await withStore(async (s) => {
        await s.webhookLog.log({ event: 'installed', installation_id: 'i1', signature_ok: true, payload_json: '{"a":1}' });
        await s.webhookLog.log({ event: 'activated', installation_id: 'i1', signature_ok: false, payload_json: '{"b":2}' });
        await s.webhookLog.log({ event: 'installed', installation_id: 'i2', signature_ok: true, payload_json: '{}' });

        const recent = await s.webhookLog.recent(10);
        expect(recent.length).toBe(3);
        expect(recent[0]?.event).toBe('installed'); // newest first (i2)

        const all = await s.webhookLog.listByInstallation('i1', { limit: 10, offset: 0 });
        expect(all.total).toBe(2);
        const refused = await s.webhookLog.listByInstallation('i1', { signatureOk: false, limit: 10, offset: 0 });
        expect(refused.total).toBe(1);
        expect(refused.items[0]?.event).toBe('activated');
        const byEvent = await s.webhookLog.listByInstallation('i1', { event: 'installed', limit: 10, offset: 0 });
        expect(byEvent.total).toBe(1);

        const counts = await s.webhookLog.countSince(DISTANT_PAST);
        expect(counts.total).toBe(3);
        expect(counts.refused).toBe(1);
        expect((await s.webhookLog.countSince(FUTURE)).total).toBe(0);

        const last = await s.webhookLog.lastForInstallation('i1');
        expect(last?.event).toBe('activated');
        const byId = await s.webhookLog.findById(refused.items[0]!.id);
        expect(byId?.payload_json).toBe('{"b":2}');

        expect(await s.webhookLog.purgeCreatedBefore(FUTURE)).toBe(3);
      });
    });
  });

  describe('store conformance — rejected items (dead-letter)', () => {
    it('adds, lists (scoped, filtered, literal search), counts and finds', async () => {
      await withStore(async (s) => {
        await s.rejectedItems.add({ installation_id: 'i1', run_id: 1, entity: 'orders', source_key: '', payload_json: '{"o":1}', reason: 'invalid total 100%' });
        await s.rejectedItems.add({ installation_id: 'i1', run_id: 1, entity: 'customers', source_key: '', payload_json: '{"c":1}', reason: 'no email' });
        await s.rejectedItems.add({ installation_id: 'i2', run_id: 2, entity: 'orders', source_key: 's1', payload_json: '{"o":2}', reason: null });

        expect((await s.rejectedItems.listByInstallation('i1', 10)).length).toBe(2);
        expect((await s.rejectedItems.list({ entity: 'orders', limit: 10, offset: 0 })).total).toBe(2);
        expect((await s.rejectedItems.list({ installationId: 'i1', entity: 'orders', limit: 10, offset: 0 })).total).toBe(1);
        // Literal search: `%` in the term must not act as a wildcard.
        expect((await s.rejectedItems.list({ q: '100%', limit: 10, offset: 0 })).total).toBe(1);
        expect((await s.rejectedItems.list({ sinceIso: FUTURE, limit: 10, offset: 0 })).total).toBe(0);

        expect(await s.rejectedItems.count({ installationId: 'i1' })).toBe(2);
        const byEntity = await s.rejectedItems.countByEntity();
        expect(byEntity.find((e) => e.entity === 'orders')?.n).toBe(2);
        const one = (await s.rejectedItems.listByInstallation('i2', 1))[0]!;
        expect((await s.rejectedItems.findById(one.id))?.payload_json).toBe('{"o":2}');
      });
    });

    it('deleteByIds is tenant-scoped: ids of another installation are untouched', async () => {
      await withStore(async (s) => {
        await s.rejectedItems.add({ installation_id: 'a', run_id: null, entity: 'x', source_key: null, payload_json: '{}', reason: null });
        await s.rejectedItems.add({ installation_id: 'b', run_id: null, entity: 'x', source_key: null, payload_json: '{}', reason: null });
        const bId = (await s.rejectedItems.listByInstallation('b', 1))[0]!.id;
        expect(await s.rejectedItems.deleteByIds('a', [bId])).toBe(0); // cross-tenant no-op
        expect(await s.rejectedItems.count({ installationId: 'b' })).toBe(1);
        expect(await s.rejectedItems.deleteByIds('b', [bId])).toBe(1);
        expect(await s.rejectedItems.count({ installationId: 'b' })).toBe(0);
      });
    });

    it('purges by cutoff', async () => {
      await withStore(async (s) => {
        await s.rejectedItems.add({ installation_id: 'a', run_id: null, entity: 'x', source_key: null, payload_json: '{}', reason: null });
        expect(await s.rejectedItems.purgeCreatedBefore(DISTANT_PAST)).toBe(0);
        expect(await s.rejectedItems.purgeCreatedBefore(FUTURE)).toBe(1);
      });
    });
  });

  describe('store conformance — audit trail', () => {
    it('appends, lists newest first with totals, purges by cutoff', async () => {
      await withStore(async (s) => {
        await s.audit.add({ action: 'login', installation_id: null, target: null, details_json: null, ip: '1.2.3.4' });
        await s.audit.add({ action: 'sync', installation_id: 'i1', target: 'i1', details_json: '{"full":true}', ip: null });
        const page = await s.audit.list({ limit: 1, offset: 0 });
        expect(page.total).toBe(2);
        expect(page.items[0]?.action).toBe('sync'); // newest first
        expect(page.items[0]?.details_json).toBe('{"full":true}');
        expect(await s.audit.purgeRecordedBefore(DISTANT_PAST)).toBe(0);
        expect(await s.audit.purgeRecordedBefore(FUTURE)).toBe(2);
      });
    });
  });
}
