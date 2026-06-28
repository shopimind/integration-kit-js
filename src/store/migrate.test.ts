import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, currentSchemaVersion } from './migrate.js';
import { MIGRATIONS } from './migrations.js';

describe('runMigrations (versioned migrations)', () => {
  it('applies all migrations then is idempotent', () => {
    const db = new Database(':memory:');
    expect(currentSchemaVersion(db)).toBe(0);
    expect(runMigrations(db, MIGRATIONS)).toBe(4);
    expect(runMigrations(db, MIGRATIONS)).toBe(0); // nothing left to redo
    expect(currentSchemaVersion(db)).toBe(4);

    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
      .map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(['installs', 'webhook_log', 'integration_state', 'sync_run', 'sync_cursor', 'inbound_event', 'webhook_seen']),
    );
    db.close();
  });

  it('applies only the missing migrations', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.filter((m) => m.version === 1));
    expect(currentSchemaVersion(db)).toBe(1);
    expect(runMigrations(db, MIGRATIONS)).toBe(3); // v2 + v3 + v4 remain
    expect(currentSchemaVersion(db)).toBe(4);
    db.close();
  });
});
