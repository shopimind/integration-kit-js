import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { createSqliteStore } from './index.js';
import { MIGRATIONS } from './migrations.js';
import { runMigrations } from './migrate.js';

/**
 * UPGRADE FROM KIT v1 — a store file written by v1 must keep working under v2.
 *
 * v1 stamped rows via SQL `datetime('now')` ('YYYY-MM-DD HH:MM:SS'); v2 writes
 * ISO-8601 UTC from JS. The two formats do NOT compare against each other
 * (' ' < 'T'), so migration 9 rewrites the legacy rows once at upgrade time.
 * These tests reproduce a v1-shaped file (schema at version 8, legacy stamps)
 * and assert the upgrade path end to end.
 */

/** Builds a file with the v1 schema (migrations 1..8) and v1-formatted timestamps. */
function makeLegacyFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'kit-legacy-'));
  const path = join(dir, 'legacy.sqlite');
  const db = new Database(path);
  // Only the migrations that existed in v1 — the file is left at version 8.
  runMigrations(db, MIGRATIONS.filter((m) => m.version <= 8));
  const legacy = "datetime('now')";
  db.exec(`
    INSERT INTO installs (installation_id, shop_domain, shop_name, status, created_at, updated_at)
      VALUES ('i1', 'shop.fr', 'Shop', 'active', ${legacy}, ${legacy});
    INSERT INTO integration_state (installation_id, key, value, encrypted, updated_at)
      VALUES ('i1', 'pref', 'fr', 0, ${legacy});
    INSERT INTO sync_cursor (installation_id, entity, source_key, last_synced_at, last_status, items, updated_at)
      VALUES ('i1', 'orders', '', '2026-08-01T00:00:00.000Z', 'ok', 3, ${legacy});
    INSERT INTO sync_run (installation_id, status, started_at, finished_at)
      VALUES ('i1', 'ok', ${legacy}, ${legacy});
    INSERT INTO webhook_log (event, installation_id, signature_ok, payload_json, created_at)
      VALUES ('installed', 'i1', 1, '{}', ${legacy});
    INSERT INTO webhook_seen (installation_id, dedup_key, created_at) VALUES ('i1', 'sig-1', ${legacy});
    INSERT INTO inbound_event (installation_id, idempotency_key, action, status, received_at, processed_at)
      VALUES ('i1', 'idem-1', 'trigger', 'done', ${legacy}, ${legacy});
    INSERT INTO rejected_item (installation_id, entity, payload_json, reason, created_at)
      VALUES ('i1', 'orders', '{}', 'bad', ${legacy});
    INSERT INTO audit_log (at, action, installation_id) VALUES (${legacy}, 'sync', 'i1');
  `);
  db.close();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const LEGACY_SHAPE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('upgrade from a kit v1 store file', () => {
  it('migration 9 normalizes every legacy timestamp column to ISO-8601 UTC', async () => {
    const { path, cleanup } = makeLegacyFile();
    try {
      const probe = new Database(path);
      expect((probe.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(8);
      expect((probe.prepare('SELECT created_at FROM webhook_log').get() as { created_at: string }).created_at).toMatch(LEGACY_SHAPE);
      probe.close();

      const store = await createSqliteStore({ path });
      await store.migrate();

      const rows = {
        install: store.db.prepare('SELECT created_at, updated_at FROM installs').get() as { created_at: string; updated_at: string },
        state: store.db.prepare('SELECT updated_at FROM integration_state').get() as { updated_at: string },
        cursor: store.db.prepare('SELECT updated_at, last_synced_at FROM sync_cursor').get() as { updated_at: string; last_synced_at: string },
        run: store.db.prepare('SELECT started_at, finished_at FROM sync_run').get() as { started_at: string; finished_at: string },
        webhook: store.db.prepare('SELECT created_at FROM webhook_log').get() as { created_at: string },
        seen: store.db.prepare('SELECT created_at FROM webhook_seen').get() as { created_at: string },
        inbound: store.db.prepare('SELECT received_at, processed_at FROM inbound_event').get() as { received_at: string; processed_at: string },
        rejected: store.db.prepare('SELECT created_at FROM rejected_item').get() as { created_at: string },
        audit: store.db.prepare('SELECT at FROM audit_log').get() as { at: string },
      };
      for (const value of [
        rows.install.created_at, rows.install.updated_at, rows.state.updated_at, rows.cursor.updated_at,
        rows.run.started_at, rows.run.finished_at, rows.webhook.created_at, rows.seen.created_at,
        rows.inbound.received_at, rows.inbound.processed_at, rows.rejected.created_at, rows.audit.at,
      ]) {
        expect(value).toMatch(ISO_SHAPE);
      }
      // A value that was ALREADY ISO (the engine has always written cursors in ISO)
      // must be left byte-for-byte alone — no double suffix.
      expect(rows.cursor.last_synced_at).toBe('2026-08-01T00:00:00.000Z');
      await store.close();
    } finally {
      cleanup();
    }
  });

  it('normalized timestamps make retention purges exact again (no early deletion)', async () => {
    const { path, cleanup } = makeLegacyFile();
    try {
      const store = await createSqliteStore({ path });
      await store.migrate();
      // A legacy row dated LATER in the same calendar day as the cutoff: before
      // normalization the lexicographic comparison deleted it (' ' < 'T').
      store.db
        .prepare(`INSERT INTO webhook_log (event, installation_id, signature_ok, payload_json, created_at) VALUES ('same-day','i1',1,'{}','2026-05-13T23:00:00.000Z')`)
        .run();
      const removed = await store.webhookLog.purgeCreatedBefore('2026-05-13T00:00:00.000Z');
      expect(removed).toBe(0);
      const kept = store.db.prepare(`SELECT COUNT(*) AS n FROM webhook_log WHERE event = 'same-day'`).get() as { n: number };
      expect(kept.n).toBe(1);
      await store.close();
    } finally {
      cleanup();
    }
  });

  it('v1 data stays readable through the port after the upgrade', async () => {
    const { path, cleanup } = makeLegacyFile();
    try {
      const store = await createSqliteStore({ path });
      await store.migrate();
      expect((await store.installs.find('i1'))?.shop_name).toBe('Shop');
      expect((await store.state.read('i1', 'pref'))?.value).toBe('fr');
      expect((await store.cursors.get('i1', 'orders', ''))?.last_synced_at).toBe('2026-08-01T00:00:00.000Z');
      // Idempotence / anti-replay claimed under v1 are still honoured.
      expect(await store.webhookSeen.claim('i1', 'sig-1')).toBe(false);
      expect((await store.inboundEvents.claim('i1', 'idem-1', 'trigger')).status).toBe('done');
      await store.close();
    } finally {
      cleanup();
    }
  });

  it('is a no-op on a fresh v2 store (nothing to normalize)', async () => {
    const store = await createSqliteStore({ path: ':memory:' });
    await store.migrate();
    await store.installs.upsert({ installation_id: 'fresh', status: 'active' });
    const row = await store.installs.find('fresh');
    expect(row?.created_at).toMatch(ISO_SHAPE);
    expect((store.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(9);
    await store.close();
  });
});
