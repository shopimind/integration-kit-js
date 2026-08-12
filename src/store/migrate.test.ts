import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, currentSchemaVersion } from './sqlite/migrate.js';
import { MIGRATIONS } from './sqlite/migrations.js';

const TOTAL = MIGRATIONS.length;
const MAX_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));

describe('runMigrations (versioned migrations)', () => {
  it('applies all migrations then is idempotent', () => {
    const db = new Database(':memory:');
    expect(currentSchemaVersion(db)).toBe(0);
    expect(runMigrations(db, MIGRATIONS)).toBe(TOTAL);
    expect(runMigrations(db, MIGRATIONS)).toBe(0); // nothing left to redo
    expect(currentSchemaVersion(db)).toBe(MAX_VERSION);

    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
      .map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'installs', 'webhook_log', 'integration_state', 'sync_run', 'sync_cursor',
        'inbound_event', 'webhook_seen', 'rejected_item',
      ]),
    );
    db.close();
  });

  it('applies only the missing migrations', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.filter((m) => m.version === 1));
    expect(currentSchemaVersion(db)).toBe(1);
    expect(runMigrations(db, MIGRATIONS)).toBe(TOTAL - 1); // everything but v1 remains
    expect(currentSchemaVersion(db)).toBe(MAX_VERSION);
    db.close();
  });
});
