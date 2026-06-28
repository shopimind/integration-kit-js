import type DatabaseT from 'better-sqlite3';
import type { Migration } from './migrations.js';

/**
 * Applies the missing migrations in order, each within a transaction.
 * Keeps a `schema_migrations` registry. Idempotent: re-running only applies what
 * is missing (returns the number of migrations applied).
 */
export function runMigrations(db: DatabaseT.Database, migrations: Migration[]): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     );`,
  );

  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  const current = row.v ?? 0;

  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);

  const record = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');
  const apply = db.transaction((m: Migration) => {
    db.exec(m.sql);
    record.run(m.version, m.name);
  });

  for (const m of pending) apply(m);
  return pending.length;
}

/** Currently applied schema version (0 if blank). */
export function currentSchemaVersion(db: DatabaseT.Database): number {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`)
    .get();
  if (!exists) return 0;
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}
