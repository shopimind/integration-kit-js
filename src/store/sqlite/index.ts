import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type DatabaseT from 'better-sqlite3';
import type { IntegrationStore } from '../port.js';
import { realClock, type StoreClock } from '../time.js';
import { MIGRATIONS } from './migrations.js';
import { runMigrations } from './migrate.js';
import {
  SqliteInstallStore,
  SqliteStateKvStore,
  SqliteCursorStore,
  SqliteRunStore,
  SqliteInboundEventStore,
  SqliteWebhookSeenStore,
  SqliteWebhookLogStore,
  SqliteRejectedItemStore,
  SqliteAuditStore,
} from './stores.js';

export interface SqliteStoreOptions {
  /** SQLite file path. Use `:memory:` for tests. The parent directory is created if needed. */
  path: string;
  /** Injectable clock for the store's timestamps (tests). Defaults to the real clock. */
  clock?: StoreClock;
}

/** The SQLite-backed store. `db` is an escape hatch for advanced tooling/tests. */
export interface SqliteStore extends IntegrationStore {
  db: DatabaseT.Database;
}

/**
 * Opens (or creates) the SQLite store — the kit's zero-config default backend.
 *
 * `better-sqlite3` is an OPTIONAL peer dependency of the kit: it is loaded here
 * dynamically so integrations using another backend (e.g. PostgreSQL) never
 * need to install or compile the native module.
 *
 * The schema is applied by `migrate()` (versioned, append-only, idempotent) —
 * `createIntegrationApp` calls it before the app is handed back.
 */
export async function createSqliteStore(opts: SqliteStoreOptions): Promise<SqliteStore> {
  const Database = await loadDriver();
  if (opts.path !== ':memory:') {
    mkdirSync(dirname(opts.path), { recursive: true });
  }
  const db = new Database(opts.path);
  db.pragma('journal_mode = WAL');
  // Wait up to 5s on a locked database before raising SQLITE_BUSY, so a concurrent
  // writer does not fail immediately under contention.
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  const clock = opts.clock ?? realClock;

  return {
    db,
    installs: new SqliteInstallStore(db, clock),
    state: new SqliteStateKvStore(db, clock),
    cursors: new SqliteCursorStore(db, clock),
    runs: new SqliteRunStore(db, clock),
    inboundEvents: new SqliteInboundEventStore(db, clock),
    webhookSeen: new SqliteWebhookSeenStore(db, clock),
    webhookLog: new SqliteWebhookLogStore(db, clock),
    rejectedItems: new SqliteRejectedItemStore(db, clock),
    audit: new SqliteAuditStore(db, clock),
    async migrate(): Promise<void> {
      // The `owner` slug of the port is ignored here on purpose: a SQLite store is
      // a private file, so two integrations cannot collide the way they could in a
      // shared PostgreSQL schema.
      runMigrations(db, MIGRATIONS);
    },
    async ping(): Promise<void> {
      db.prepare('SELECT 1').get();
    },
    async close(): Promise<void> {
      db.close();
    },
  };
}

async function loadDriver(): Promise<typeof DatabaseT> {
  try {
    const mod = await import('better-sqlite3');
    return mod.default;
  } catch (cause) {
    // Only claim "not installed" when the module could not be RESOLVED. better-sqlite3
    // is a NATIVE module whose most common failure is an ABI/build mismatch (Node
    // upgraded, image rebuilt, node_modules copied between stages) — that error must
    // reach the operator intact instead of being relabelled as a missing package.
    if (isModuleNotFound(cause)) {
      throw new Error(
        "The SQLite store requires the optional peer dependency 'better-sqlite3'. " +
          'Install it in your integration (`yarn add better-sqlite3`), or use another backend ' +
          "such as PostgreSQL via '@shopimind/integration-kit-js/store-postgres'.",
        { cause },
      );
    }
    throw cause;
  }
}

/** True when an import failed because the module could not be resolved at all. */
function isModuleNotFound(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

export { MIGRATIONS } from './migrations.js';
export type { Migration } from './migrations.js';
export { runMigrations, currentSchemaVersion } from './migrate.js';
