/**
 * VERSIONED PostgreSQL migrations. Same registry and append-only rule as the
 * SQLite adapter (`schema_migrations`), but a dialect-specific history: the
 * PostgreSQL backend ships since kit v2, so its v1 is the CONSOLIDATED final
 * schema (SQLite's v1..v8 squashed) — there are no pre-existing PG databases
 * to upgrade step by step.
 *
 * Dialect decisions (kept deliberately identical to the SQLite layout):
 *   - Timestamps are TEXT holding ISO-8601 UTC strings generated in JS
 *     (`store/time.ts`) — NOT timestamptz — so ordering, cutoffs and returned
 *     rows behave byte-for-byte the same on every backend.
 *   - Booleans-as-integers (`signature_ok`, `encrypted`) stay INTEGER 0/1 to
 *     match the row types the kit exposes.
 *   - `id` columns are INTEGER IDENTITY (int4): these tables are retention-purged
 *     logs / registries, far below int4 range; int8 would surface as strings in
 *     node-postgres and break the numeric row contract.
 *
 * `{S}` is replaced by the (validated) schema name at runtime.
 *
 * Migrations are APPEND-ONLY: NEVER edit a migration that has already been
 * published/shipped — add a new versioned migration instead.
 */

export interface PgMigration {
  version: number;
  name: string;
  sql: string;
}

export const PG_MIGRATIONS: PgMigration[] = [
  {
    version: 1,
    name: 'consolidated_v2_baseline',
    sql: `
      CREATE TABLE {S}.installs (
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
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL
      );
      CREATE INDEX idx_installs_status ON {S}.installs(status);

      CREATE TABLE {S}.webhook_log (
        id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        event                TEXT,
        installation_id      TEXT,
        signature_ok         INTEGER NOT NULL DEFAULT 0,
        payload_json         TEXT,
        created_at           TEXT NOT NULL
      );
      CREATE INDEX idx_webhook_log_install    ON {S}.webhook_log(installation_id);
      CREATE INDEX idx_webhook_log_install_id ON {S}.webhook_log(installation_id, id);
      CREATE INDEX idx_webhook_log_created    ON {S}.webhook_log(created_at);

      CREATE TABLE {S}.integration_state (
        installation_id      TEXT NOT NULL,
        key                  TEXT NOT NULL,
        value                TEXT,
        encrypted            INTEGER NOT NULL DEFAULT 0,
        updated_at           TEXT NOT NULL,
        PRIMARY KEY (installation_id, key)
      );

      CREATE TABLE {S}.sync_run (
        id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        installation_id      TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'running',
        summary_json         TEXT,
        started_at           TEXT NOT NULL,
        finished_at          TEXT
      );
      CREATE INDEX idx_sync_run_install    ON {S}.sync_run(installation_id);
      CREATE INDEX idx_sync_run_install_id ON {S}.sync_run(installation_id, id);

      CREATE TABLE {S}.sync_cursor (
        installation_id      TEXT NOT NULL,
        entity               TEXT NOT NULL,
        source_key           TEXT NOT NULL DEFAULT '',
        last_synced_at       TEXT,
        last_status          TEXT,
        last_error           TEXT,
        items                INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        updated_at           TEXT NOT NULL,
        PRIMARY KEY (installation_id, entity, source_key)
      );

      CREATE TABLE {S}.inbound_event (
        id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        installation_id  TEXT NOT NULL,
        idempotency_key  TEXT NOT NULL,
        action           TEXT,
        status           TEXT NOT NULL DEFAULT 'received',
        error            TEXT,
        received_at      TEXT NOT NULL,
        processed_at     TEXT
      );
      CREATE UNIQUE INDEX idx_inbound_event_key      ON {S}.inbound_event(installation_id, idempotency_key);
      CREATE INDEX idx_inbound_event_install_id      ON {S}.inbound_event(installation_id, id);
      CREATE INDEX idx_inbound_event_received        ON {S}.inbound_event(received_at);

      CREATE TABLE {S}.webhook_seen (
        installation_id  TEXT NOT NULL,
        dedup_key        TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        PRIMARY KEY (installation_id, dedup_key)
      );
      CREATE INDEX idx_webhook_seen_created ON {S}.webhook_seen(created_at);

      CREATE TABLE {S}.rejected_item (
        id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        installation_id  TEXT NOT NULL,
        run_id           INTEGER,
        entity           TEXT,
        source_key       TEXT,
        payload_json     TEXT,
        reason           TEXT,
        created_at       TEXT NOT NULL
      );
      CREATE INDEX idx_rejected_item_install    ON {S}.rejected_item(installation_id, created_at);
      CREATE INDEX idx_rejected_item_install_id ON {S}.rejected_item(installation_id, id);

      CREATE TABLE {S}.audit_log (
        id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        at               TEXT NOT NULL,
        action           TEXT NOT NULL,
        installation_id  TEXT,
        target           TEXT,
        details_json     TEXT,
        ip               TEXT
      );
      CREATE INDEX idx_audit_log_at ON {S}.audit_log(at);
    `,
  },
];
