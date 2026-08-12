import type { Pool } from 'pg';
import type { IntegrationStore } from '../port.js';
import { realClock, type StoreClock } from '../time.js';
import { PG_MIGRATIONS } from './migrations.js';
import {
  PgInstallStore,
  PgStateKvStore,
  PgCursorStore,
  PgRunStore,
  PgInboundEventStore,
  PgWebhookSeenStore,
  PgWebhookLogStore,
  PgRejectedItemStore,
  PgAuditStore,
  type PgQuerier,
} from './stores.js';

export interface PostgresStoreOptions {
  /**
   * Connection string of YOUR PostgreSQL database (`postgres://user:pass@host/db`).
   * The store opens (and owns) its own small `pg.Pool` on it. Alternative: pass
   * an existing `pool` — exactly one of the two is required.
   */
  connectionString?: string;
  /**
   * An existing `pg.Pool` to reuse (e.g. your application's). The store does NOT
   * close a pool it did not create — `close()` is then a no-op on the pool.
   */
  pool?: Pool;
  /**
   * PostgreSQL schema holding the kit's tables (created if missing). One schema
   * per integration keeps several integrations — and your own tables — cleanly
   * separated inside the same database. Default: 'shopimind_kit'.
   */
  schema?: string;
  /** Max connections when the store owns the pool (default 10). */
  maxConnections?: number;
  /**
   * How long (ms) to wait for a free connection before failing a query. Bounds
   * `/health` and every store call when the pool is saturated or the server is
   * unreachable. Default 5000. Only applies when the store owns the pool.
   */
  connectionTimeoutMs?: number;
  /**
   * Server-side `statement_timeout` (ms) for the kit's own connections: a query
   * blocked on a lock is cancelled instead of hanging forever. Default 30000.
   * Only applies when the store owns the pool.
   */
  statementTimeoutMs?: number;
  /**
   * Upper bound (ms) on `ping()`, the health probe's DB check. Default 3000 —
   * a probe must answer, even when PostgreSQL is silently unresponsive.
   */
  pingTimeoutMs?: number;
  /** Injectable clock for the store's timestamps (tests). Defaults to the real clock. */
  clock?: StoreClock;
  /**
   * Called when the pool reports an error on an IDLE connection (managed-PG
   * failover, PgBouncer timeout, `pg_terminate_backend`). The store always
   * attaches a listener — without one, `pg` would surface it as an
   * `uncaughtException` and kill the process — and forwards it here so you can
   * log it. Defaults to a silent no-op.
   */
  onPoolError?: (error: Error) => void;
}

/** The PostgreSQL-backed store. `pool` is an escape hatch for advanced tooling/tests. */
export interface PostgresStore extends IntegrationStore {
  pool: Pool;
  /** The (validated) schema name the tables live in. */
  schema: string;
}

/** Schema names are interpolated as SQL identifiers — restrict them hard. */
const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Opens the PostgreSQL store — point the kit at YOUR existing database instead
 * of the default SQLite file. All tables live in a dedicated schema; nothing
 * else in the database is touched. No persistent filesystem, no native module.
 *
 * `pg` is an OPTIONAL peer dependency of the kit, loaded here dynamically:
 * integrations on the SQLite default never need to install it.
 *
 * The schema is applied by `migrate()` (versioned, append-only, idempotent) —
 * `createIntegrationApp` calls it before the app is handed back. Concurrent
 * boots are safe: the migration runner serializes on a pg advisory lock.
 */
export async function createPostgresStore(opts: PostgresStoreOptions): Promise<PostgresStore> {
  if (!opts.connectionString && !opts.pool) {
    throw new Error("createPostgresStore: pass 'connectionString' (or an existing 'pool')");
  }
  if (opts.connectionString && opts.pool) {
    throw new Error("createPostgresStore: pass either 'connectionString' or 'pool', not both");
  }
  const schema = opts.schema ?? 'shopimind_kit';
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(
      `createPostgresStore: invalid schema name '${schema}' — use lowercase letters, digits and underscores (max 63 chars)`,
    );
  }

  const pg = await loadDriver();
  const ownsPool = !opts.pool;
  const pool: Pool =
    opts.pool ??
    new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.maxConnections ?? 10,
      // Bound the wait for a free/new connection: without it, a saturated pool or
      // an unreachable server makes every store call (including the health probe)
      // hang forever instead of failing.
      connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5_000,
      idleTimeoutMillis: 10_000,
      // Server-side cancellation: a query stuck on a lock is killed rather than
      // holding a pool slot indefinitely.
      statement_timeout: opts.statementTimeoutMs ?? 30_000,
    });
  // MANDATORY: `pg` emits 'error' on idle clients (managed-PG failover, PgBouncer
  // timeout, pg_terminate_backend). With no listener, Node turns that EventEmitter
  // error into an uncaughtException and the process dies — taking the in-flight
  // webhook with it. The pool recycles the client on its own; we only observe.
  pool.on('error', (error: Error) => opts.onPoolError?.(error));
  const pingTimeoutMs = opts.pingTimeoutMs ?? 3_000;
  const clock = opts.clock ?? realClock;

  // Tables are referenced with an explicit schema prefix on every query — the
  // pool's search_path is never touched (it may belong to the integrator).
  const t = (table: string): string => `"${schema}"."${table}"`;
  const q: PgQuerier = pool;

  return {
    pool,
    schema,
    installs: new PgInstallStore(q, t, clock),
    state: new PgStateKvStore(q, t, clock),
    cursors: new PgCursorStore(q, t, clock),
    runs: new PgRunStore(q, t, clock),
    inboundEvents: new PgInboundEventStore(q, t, clock),
    webhookSeen: new PgWebhookSeenStore(q, t, clock),
    webhookLog: new PgWebhookLogStore(q, t, clock),
    rejectedItems: new PgRejectedItemStore(q, t, clock),
    audit: new PgAuditStore(q, t, clock),
    async migrate(owner?: string): Promise<void> {
      await runPgMigrations(pool, schema, owner);
    },
    async ping(): Promise<void> {
      // Hard bound: /health must ANSWER (degraded is a useful answer, hanging is not).
      // A silently unresponsive server — TCP alive, no reply — would otherwise leave
      // the probe pending until the orchestrator's own timeout.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          pool.query('SELECT 1'),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`postgres ping timed out after ${pingTimeoutMs}ms`)), pingTimeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async close(): Promise<void> {
      if (ownsPool) await pool.end();
    },
  };
}

/**
 * Applies the missing migrations in order, each inside a transaction, keeping
 * the same `schema_migrations` registry contract as the SQLite adapter.
 * Serialized on a schema-scoped advisory lock so two instances booting at the
 * same time cannot race the DDL.
 *
 * Also enforces SCHEMA OWNERSHIP when the caller provides an `owner` slug: a
 * PostgreSQL database is shared by nature, and the default schema name is the
 * same for every integration. Without this check, deploying a second integration
 * without an explicit `schema` would silently merge both integrations'
 * installations, cursors and secrets into one set of tables.
 */
async function runPgMigrations(pool: Pool, schema: string, owner?: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One advisory lock per schema name (stable 32-bit hash), held for the tx.
    await client.query('SELECT pg_advisory_xact_lock(541287, hashtext($1))', [schema]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS "${schema}".kit_owner (
         id INTEGER PRIMARY KEY,
         integration_slug TEXT NOT NULL,
         claimed_at TEXT NOT NULL
       )`,
    );
    if (owner) {
      const claim = await client.query(
        `INSERT INTO "${schema}".kit_owner (id, integration_slug, claimed_at)
         VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING`,
        [owner, new Date().toISOString()],
      );
      if (claim.rowCount === 0) {
        const current = await client.query(`SELECT integration_slug FROM "${schema}".kit_owner WHERE id = 1`);
        const existing = (current.rows[0] as { integration_slug: string } | undefined)?.integration_slug;
        if (existing && existing !== owner) {
          throw new Error(
            `PostgreSQL schema "${schema}" already belongs to the integration '${existing}', but '${owner}' is trying to use it. ` +
              'Two integrations must not share a schema (their installations, cursors and secrets would be merged). ' +
              `Give this integration its own schema, e.g. createPostgresStore({ schema: 'shopimind_${owner.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}' }).`,
          );
        }
      }
    }
    await client.query(
      `CREATE TABLE IF NOT EXISTS "${schema}".schema_migrations (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at TEXT NOT NULL
       )`,
    );
    const res = await client.query(`SELECT MAX(version)::int AS v FROM "${schema}".schema_migrations`);
    const current = (res.rows[0] as { v: number | null }).v ?? 0;
    const pending = PG_MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
    for (const m of pending) {
      await client.query(m.sql.replaceAll('{S}', `"${schema}"`));
      await client.query(`INSERT INTO "${schema}".schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)`, [
        m.version,
        m.name,
        new Date().toISOString(),
      ]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function loadDriver(): Promise<{ Pool: typeof Pool }> {
  try {
    // pg ships CJS; under a NodeNext dynamic import the namespace may nest the
    // constructors under `default`. Only `Pool` is needed here.
    const mod = (await import('pg')) as unknown as { Pool?: typeof Pool; default?: { Pool: typeof Pool } };
    const resolved = mod.default ?? mod;
    if (typeof resolved.Pool !== 'function') throw new Error("module 'pg' does not expose a Pool constructor");
    return resolved as { Pool: typeof Pool };
  } catch (cause) {
    // Only claim "not installed" when the module genuinely could not be RESOLVED.
    // Any other failure (a module that throws while initializing) must surface
    // as-is: replacing it would send the operator hunting for a missing package
    // that is in fact installed.
    if (isModuleNotFound(cause)) {
      throw new Error(
        "The PostgreSQL store requires the optional peer dependency 'pg'. " +
          'Install it in your integration (`yarn add pg`), or use the default SQLite backend ' +
          "via 'databasePath' / '@shopimind/integration-kit-js/store-sqlite'.",
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

export { PG_MIGRATIONS } from './migrations.js';
export type { PgMigration } from './migrations.js';
