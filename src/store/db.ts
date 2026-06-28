import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';
import { runMigrations } from './migrate.js';

export type Db = Database.Database;

/**
 * Opens (or creates) the SQLite store, applies the PRAGMAs and runs the migrations.
 * Use `:memory:` for tests. The parent directory is created if needed.
 */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // Wait up to 5s on a locked database before raising SQLITE_BUSY, so a concurrent
  // writer does not fail immediately under contention.
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  runMigrations(db, MIGRATIONS);
  return db;
}
