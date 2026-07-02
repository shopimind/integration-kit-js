/**
 * VERSIONED SQLite migrations. The SQL is embedded (no asset to copy into
 * `dist`). The runner applies the missing versions within a transaction.
 *
 * Schema centered on `installation_id` (OPAQUE token issued by ShopiMind, treated
 * as a string). The local store is the integrator's CORRELATION REGISTRY: it links
 * a ShopiMind installation (`installation_id`) to ITS internal account
 * (`external_account_ref`/`_name`). No internal ShopiMind id (PK, `id_shop`) is
 * stored here.
 *
 * Encryption — be honest about what is and is NOT protected:
 *   - ONLY secrets written via `integration_state.setSecret` are encrypted at rest
 *     (AES-256-GCM, `encrypted = 1`).
 *   - PII (`shop_domain`, `shop_name`, `external_account_name`) and plain values
 *     written via `integration_state.set` are stored IN CLEAR TEXT.
 *   - The SQLite file itself is NOT encrypted. Protect it via filesystem/disk
 *     controls if at-rest confidentiality of the whole store is required.
 *
 * Migrations are APPEND-ONLY: NEVER edit a migration that has already been
 * published/shipped — add a new versioned migration instead.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core',
    sql: `
      CREATE TABLE installs (
        installation_id        TEXT PRIMARY KEY,
        shop_domain            TEXT,
        shop_name              TEXT,
        external_account_ref   TEXT,
        external_account_name  TEXT,
        status                 TEXT NOT NULL DEFAULT 'inactive',
        installed_at           TEXT,
        activated_at           TEXT,
        deactivated_at         TEXT,
        uninstalled_at         TEXT,
        created_at             TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_installs_status ON installs(status);

      CREATE TABLE webhook_log (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        event                TEXT,
        installation_id      TEXT,
        signature_ok         INTEGER NOT NULL DEFAULT 0,
        payload_json         TEXT,
        created_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_webhook_log_install ON webhook_log(installation_id);

      CREATE TABLE integration_state (
        installation_id      TEXT NOT NULL,
        key                  TEXT NOT NULL,
        value                TEXT,
        encrypted            INTEGER NOT NULL DEFAULT 0,
        updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (installation_id, key)
      );
    `,
  },
  {
    version: 2,
    name: 'sync',
    sql: `
      CREATE TABLE sync_run (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        installation_id      TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'running',
        summary_json         TEXT,
        started_at           TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at          TEXT
      );
      CREATE INDEX idx_sync_run_install ON sync_run(installation_id);

      -- Cursor per (installation, entity, source_key). source_key = '' for the
      -- global scope; a store id for the 'per-source' scope.
      CREATE TABLE sync_cursor (
        installation_id      TEXT NOT NULL,
        entity               TEXT NOT NULL,
        source_key           TEXT NOT NULL DEFAULT '',
        last_synced_at       TEXT,
        last_status          TEXT,
        last_error           TEXT,
        items                INTEGER NOT NULL DEFAULT 0,
        updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (installation_id, entity, source_key)
      );
    `,
  },
  {
    version: 3,
    name: 'inbound',
    sql: `
      -- Log of INBOUND calls (integrator app -> integration, the middleware).
      -- Backs idempotency (unique key per installation) and audit. Persisted BEFORE
      -- processing -> no event lost; a replay after success is short-circuited.
      CREATE TABLE inbound_event (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        installation_id  TEXT NOT NULL,
        idempotency_key  TEXT NOT NULL,
        action           TEXT,
        status           TEXT NOT NULL DEFAULT 'received',
        error            TEXT,
        received_at      TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at     TEXT
      );
      CREATE UNIQUE INDEX idx_inbound_event_key ON inbound_event(installation_id, idempotency_key);
    `,
  },
  {
    version: 4,
    name: 'webhook_dedup',
    sql: `
      -- Replay protection for lifecycle webhooks: we claim a key derived from the
      -- SIGNATURE (unique per timestamp+body) BEFORE processing. A verbatim replay
      -- (same signature) within the tolerance window is short-circuited. The row is
      -- kept only if processing SUCCEEDS (otherwise released -> retry allowed).
      CREATE TABLE webhook_seen (
        installation_id  TEXT NOT NULL,
        dedup_key        TEXT NOT NULL,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (installation_id, dedup_key)
      );
    `,
  },
  {
    version: 5,
    name: 'cursor_failure_escalation',
    sql: `
      -- Repeated-failure escalation (E3). A run-level counter per cursor:
      --   - incremented every time the step fails/holds (last_status = 'error'),
      --   - reset to 0 on a clean advance.
      -- The engine uses it for EXPONENTIAL backoff (skip 2^(k-1) ticks, capped ~24h)
      -- so a persistently-failing source stops hammering a broken upstream every tick,
      -- and escalates to an ERROR log at the 3rd consecutive failure. The GOLDEN RULE
      -- is untouched: this only decides WHEN to retry, never whether the cursor moves.
      ALTER TABLE sync_cursor ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 6,
    name: 'rejected_item_dead_letter',
    sql: `
      -- Dead-letter of per-item REJECTIONS (E4). When a bulk push reports rejected
      -- items (validation, permanent-ish), the engine records them here instead of
      -- letting the warn scroll away — so an operator can inspect what the API refused
      -- and, later, replay it. Bounded per run (the engine caps inserts at 500/run) to
      -- keep a poison batch from flooding the store. Subject to the same retention purge
      -- as the other log tables.
      CREATE TABLE rejected_item (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        installation_id  TEXT NOT NULL,
        run_id           INTEGER,
        entity           TEXT,
        source_key       TEXT,
        payload_json     TEXT,
        reason           TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_rejected_item_install ON rejected_item(installation_id, created_at);
    `,
  },
  {
    version: 7,
    name: 'admin_audit',
    sql: `
      -- Audit trail of ADMIN actions performed through the admin API / operations UI
      -- (login, sync, reprovision, purge, PII reveal). Append-only, with its own
      -- retention (auditRetentionDays, default 365). Metadata ONLY: no secrets, no raw
      -- PII — 'details_json' holds counts/ids/flags, never customer data.
      CREATE TABLE audit_log (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        at               TEXT NOT NULL DEFAULT (datetime('now')),
        action           TEXT NOT NULL,
        installation_id  TEXT,
        target           TEXT,
        details_json     TEXT,
        ip               TEXT
      );
      CREATE INDEX idx_audit_log_at ON audit_log(at);
    `,
  },
  {
    version: 8,
    name: 'admin_query_indexes',
    sql: `
      -- Composite (installation_id, id) indexes so the admin per-installation lists
      -- (filter by installation_id, ORDER BY id DESC) read in reverse index order with
      -- no filesort, plus time indexes so the retention purges and the dashboard's
      -- time-window counters do not full-table-scan as the tables grow.
      CREATE INDEX idx_webhook_log_install_id   ON webhook_log(installation_id, id);
      CREATE INDEX idx_webhook_log_created      ON webhook_log(created_at);
      CREATE INDEX idx_inbound_event_install_id ON inbound_event(installation_id, id);
      CREATE INDEX idx_inbound_event_received   ON inbound_event(received_at);
      CREATE INDEX idx_sync_run_install_id      ON sync_run(installation_id, id);
      CREATE INDEX idx_rejected_item_install_id ON rejected_item(installation_id, id);
      CREATE INDEX idx_webhook_seen_created     ON webhook_seen(created_at);
    `,
  },
];
