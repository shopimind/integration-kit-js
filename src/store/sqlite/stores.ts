import type DatabaseT from 'better-sqlite3';
import type {
  InstallStore,
  StateKvStore,
  StateEntry,
  StateMetaRow,
  CursorStore,
  RunStore,
  InboundEventStore,
  WebhookSeenStore,
  WebhookLogStore,
  RejectedItemStore,
  AuditStore,
} from '../port.js';
import type {
  InstallRow,
  InstallUpsert,
  CursorRow,
  CursorWrite,
  SyncRunRow,
  InboundEventRow,
  RejectedItemRow,
  WebhookLogRow,
  AuditRow,
} from '../types.js';
import { nowIso, type StoreClock } from '../time.js';

type Db = DatabaseT.Database;

const nn = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

/** Escapes LIKE metacharacters (`%`, `_`, `\`) so a search term matches literally. */
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * SQLite implementation of the persistence port. Pure storage: timestamps are
 * generated in JS (canonical ISO-8601 UTC — SQL `datetime('now')` is never used
 * for new writes; the v1 column DEFAULTs remain for backward compatibility but
 * no longer apply), retention cutoffs arrive pre-computed, and the state KV
 * stores opaque blobs (encryption lives above the port).
 *
 * SQLite's `LIKE` is case-insensitive for ASCII by default, which matches the
 * port's "case-insensitive substring" contract (the PG adapter uses
 * `lower() LIKE lower()` for the same behaviour).
 */

export class SqliteInstallStore implements InstallStore {
  constructor(
    private readonly db: Db,
    private readonly clock: StoreClock,
  ) {}

  async upsert(u: InstallUpsert): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO installs
           (installation_id, shop_domain, shop_name, status, installed_at, created_at, updated_at)
         VALUES
           (@installation_id, @shop_domain, @shop_name, @status, @installed_at, @now, @now)
         ON CONFLICT(installation_id) DO UPDATE SET
           shop_domain  = COALESCE(excluded.shop_domain, shop_domain),
           shop_name    = COALESCE(excluded.shop_name, shop_name),
           status       = excluded.status,
           installed_at = COALESCE(excluded.installed_at, installed_at),
           updated_at   = @now`,
      )
      .run({
        installation_id: u.installation_id,
        shop_domain: nn(u.shop_domain),
        shop_name: nn(u.shop_name),
        status: u.status,
        installed_at: nn(u.installed_at),
        now: nowIso(this.clock),
      });
  }

  async setStatus(
    installationId: string,
    status: string,
    stamps: { activated_at?: string | null; deactivated_at?: string | null; uninstalled_at?: string | null } = {},
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE installs SET
           status         = @status,
           activated_at   = @activated_at,
           deactivated_at = @deactivated_at,
           uninstalled_at = @uninstalled_at,
           updated_at     = @now
         WHERE installation_id = @installation_id`,
      )
      .run({
        installation_id: installationId,
        status,
        activated_at: nn(stamps.activated_at),
        deactivated_at: nn(stamps.deactivated_at),
        uninstalled_at: nn(stamps.uninstalled_at),
        now: nowIso(this.clock),
      });
  }

  async setExternalAccount(installationId: string, ref: string | null, name: string | null = null): Promise<void> {
    this.db
      .prepare(
        `UPDATE installs SET
           external_account_ref  = @ref,
           external_account_name = @name,
           updated_at            = @now
         WHERE installation_id = @installation_id`,
      )
      .run({ installation_id: installationId, ref, name, now: nowIso(this.clock) });
  }

  async find(installationId: string): Promise<InstallRow | undefined> {
    return this.db
      .prepare('SELECT * FROM installs WHERE installation_id = ?')
      .get(installationId) as InstallRow | undefined;
  }

  async listActive(): Promise<InstallRow[]> {
    return this.db.prepare(`SELECT * FROM installs WHERE status = 'active'`).all() as InstallRow[];
  }

  async list(f: { status?: string; q?: string; limit: number; offset: number }): Promise<{ items: InstallRow[]; total: number }> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (f.status) {
      where.push('status = @status');
      params.status = f.status;
    }
    if (f.q) {
      where.push(`(installation_id LIKE @q ESCAPE '\\' OR shop_domain LIKE @q ESCAPE '\\' OR shop_name LIKE @q ESCAPE '\\')`);
      params.q = `%${likeEscape(f.q)}%`;
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM installs ${clause}`).get(params) as { n: number }).n;
    const items = this.db
      .prepare(`SELECT * FROM installs ${clause} ORDER BY updated_at DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: f.limit, offset: f.offset }) as InstallRow[];
    return { items, total };
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM installs GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
  }
}

export class SqliteStateKvStore implements StateKvStore {
  constructor(
    private readonly db: Db,
    private readonly clock: StoreClock,
  ) {}

  async write(installationId: string, key: string, value: string, encrypted: boolean): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO integration_state (installation_id, key, value, encrypted, updated_at)
         VALUES (@id, @key, @value, @encrypted, @now)
         ON CONFLICT(installation_id, key) DO UPDATE SET
           value = excluded.value, encrypted = excluded.encrypted, updated_at = @now`,
      )
      .run({ id: installationId, key, value, encrypted: encrypted ? 1 : 0, now: nowIso(this.clock) });
  }

  async read(installationId: string, key: string): Promise<StateEntry | undefined> {
    const row = this.db
      .prepare('SELECT value, encrypted FROM integration_state WHERE installation_id = ? AND key = ?')
      .get(installationId, key) as { value: string | null; encrypted: number } | undefined;
    if (!row) return undefined;
    return { value: row.value, encrypted: row.encrypted === 1 };
  }

  async delete(installationId: string, key: string): Promise<void> {
    this.db
      .prepare('DELETE FROM integration_state WHERE installation_id = ? AND key = ?')
      .run(installationId, key);
  }

  async listMeta(installationId: string): Promise<StateMetaRow[]> {
    // The CASE guarantees at the SQL level that an encrypted value is never
    // materialized: `value_preview` is NULL whenever `encrypted = 1`.
    const rows = this.db
      .prepare(
        `SELECT key,
                encrypted,
                updated_at,
                COALESCE(length(value), 0) AS value_length,
                CASE WHEN encrypted = 0 THEN substr(value, 1, 200) ELSE NULL END AS value_preview
         FROM integration_state WHERE installation_id = ? ORDER BY key`,
      )
      .all(installationId) as Array<{ key: string; encrypted: number; updated_at: string; value_length: number; value_preview: string | null }>;
    return rows.map((r) => ({
      key: r.key,
      encrypted: r.encrypted === 1,
      updated_at: r.updated_at,
      value_length: r.value_length,
      value_preview: r.value_preview,
    }));
  }
}

export class SqliteCursorStore implements CursorStore {
  constructor(
    private readonly db: Db,
    private readonly clock: StoreClock,
  ) {}

  async get(installationId: string, entity: string, sourceKey: string): Promise<CursorRow | undefined> {
    return this.db
      .prepare('SELECT * FROM sync_cursor WHERE installation_id = ? AND entity = ? AND source_key = ?')
      .get(installationId, entity, sourceKey) as CursorRow | undefined;
  }

  async set(installationId: string, entity: string, sourceKey: string, w: CursorWrite): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sync_cursor
           (installation_id, entity, source_key, last_synced_at, last_status, last_error, items,
            consecutive_failures, updated_at)
         VALUES
           (@installation_id, @entity, @source_key, @last_synced_at, @last_status, @last_error, @items,
            COALESCE(@consecutive_failures, 0), @now)
         ON CONFLICT(installation_id, entity, source_key) DO UPDATE SET
           last_synced_at = excluded.last_synced_at,
           last_status    = excluded.last_status,
           last_error     = excluded.last_error,
           items          = excluded.items,
           -- Omitted (@consecutive_failures IS NULL) -> keep the existing counter.
           consecutive_failures = COALESCE(@consecutive_failures, sync_cursor.consecutive_failures),
           updated_at     = @now`,
      )
      .run({
        installation_id: installationId,
        entity,
        source_key: sourceKey,
        last_synced_at: w.last_synced_at,
        last_status: nn(w.last_status),
        last_error: nn(w.last_error),
        items: w.items ?? 0,
        consecutive_failures: nn(w.consecutive_failures),
        now: nowIso(this.clock),
      });
  }

  async listByInstallation(installationId: string): Promise<CursorRow[]> {
    return this.db
      .prepare('SELECT * FROM sync_cursor WHERE installation_id = ? ORDER BY entity, source_key')
      .all(installationId) as CursorRow[];
  }

  async countInError(): Promise<number> {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM sync_cursor WHERE last_status = 'error'`)
      .get() as { n: number };
    return row.n;
  }
}

export class SqliteRunStore implements RunStore {
  constructor(
    private readonly db: Db,
    private readonly clock: StoreClock,
  ) {}

  async start(installationId: string): Promise<number> {
    const info = this.db
      .prepare(`INSERT INTO sync_run (installation_id, status, started_at) VALUES (?, 'running', ?)`)
      .run(installationId, nowIso(this.clock));
    return Number(info.lastInsertRowid);
  }

  async finish(runId: number, status: 'ok' | 'partial' | 'failed', summaryJson: string): Promise<void> {
    this.db
      .prepare(`UPDATE sync_run SET status = @status, summary_json = @summary_json, finished_at = @now WHERE id = @id`)
      .run({ id: runId, status, summary_json: summaryJson, now: nowIso(this.clock) });
  }

  async recent(installationId: string, limit: number): Promise<SyncRunRow[]> {
    return this.db
      .prepare('SELECT * FROM sync_run WHERE installation_id = ? ORDER BY id DESC LIMIT ?')
      .all(installationId, limit) as SyncRunRow[];
  }

  async list(installationId: string, f: { limit: number; offset: number }): Promise<{ items: SyncRunRow[]; total: number }> {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM sync_run WHERE installation_id = ?').get(installationId) as { n: number }).n;
    const items = this.db
      .prepare('SELECT * FROM sync_run WHERE installation_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(installationId, f.limit, f.offset) as SyncRunRow[];
    return { items, total };
  }

  async purgeStartedBefore(cutoffIso: string): Promise<number> {
    return this.db.prepare(`DELETE FROM sync_run WHERE started_at < ?`).run(cutoffIso).changes;
  }
}

export class SqliteInboundEventStore implements InboundEventStore {
  constructor(
    private readonly db: Db,
    private readonly clock: StoreClock,
  ) {}

  async find(installationId: string, idempotencyKey: string): Promise<InboundEventRow | undefined> {
    return this.db
      .prepare('SELECT * FROM inbound_event WHERE installation_id = ? AND idempotency_key = ?')
      .get(installationId, idempotencyKey) as InboundEventRow | undefined;
  }

  async claim(
    installationId: string,
    idempotencyKey: string,
    action: string | null,
  ): Promise<{ rowId: number; fresh: boolean; status: InboundEventRow['status'] }> {
    const insert = this.db.prepare(
      `INSERT INTO inbound_event (installation_id, idempotency_key, action, status, received_at)
       VALUES (?, ?, ?, 'received', ?)
       ON CONFLICT(installation_id, idempotency_key) DO NOTHING`,
    );
    const info = insert.run(installationId, idempotencyKey, action, nowIso(this.clock));
    if (info.changes === 1) return { rowId: Number(info.lastInsertRowid), fresh: true, status: 'received' };
    const existing = await this.find(installationId, idempotencyKey);
    if (!existing) {
      // Extreme race (row deleted between the INSERT and the SELECT): retry once.
      const retry = insert.run(installationId, idempotencyKey, action, nowIso(this.clock));
      const row = await this.find(installationId, idempotencyKey);
      return { rowId: row ? row.id : Number(retry.lastInsertRowid), fresh: retry.changes === 1, status: row ? row.status : 'received' };
    }
    return { rowId: existing.id, fresh: false, status: existing.status };
  }

  async finish(id: number, status: 'done' | 'failed', error: string | null): Promise<void> {
    this.db
      .prepare(`UPDATE inbound_event SET status = @status, error = @error, processed_at = @now WHERE id = @id`)
      .run({ id, status, error, now: nowIso(this.clock) });
  }

  async purgeReceivedBefore(cutoffIso: string): Promise<number> {
    return this.db.prepare(`DELETE FROM inbound_event WHERE received_at < ?`).run(cutoffIso).changes;
  }

  async listByInstallation(
    installationId: string,
    f: { limit: number; offset: number },
  ): Promise<{ items: InboundEventRow[]; total: number }> {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM inbound_event WHERE installation_id = ?').get(installationId) as { n: number }).n;
    const items = this.db
      .prepare('SELECT * FROM inbound_event WHERE installation_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(installationId, f.limit, f.offset) as InboundEventRow[];
    return { items, total };
  }
}

export class SqliteWebhookSeenStore implements WebhookSeenStore {
  constructor(
    private readonly db: Db,
    private readonly clock: StoreClock,
  ) {}

  async claim(installationId: string, dedupKey: string): Promise<boolean> {
    const info = this.db
      .prepare(
        `INSERT INTO webhook_seen (installation_id, dedup_key, created_at) VALUES (?, ?, ?)
         ON CONFLICT(installation_id, dedup_key) DO NOTHING`,
      )
      .run(installationId, dedupKey, nowIso(this.clock));
    return info.changes === 1;
  }

  async release(installationId: string, dedupKey: string): Promise<void> {
    this.db
      .prepare('DELETE FROM webhook_seen WHERE installation_id = ? AND dedup_key = ?')
      .run(installationId, dedupKey);
  }

  async purgeCreatedBefore(cutoffIso: string): Promise<number> {
    return this.db.prepare(`DELETE FROM webhook_seen WHERE created_at < ?`).run(cutoffIso).changes;
  }

  async countByInstallationSince(installationId: string, sinceIso: string): Promise<number> {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM webhook_seen WHERE installation_id = ? AND created_at >= ?`)
        .get(installationId, sinceIso) as { n: number }
    ).n;
  }
}

export class SqliteWebhookLogStore implements WebhookLogStore {
  constructor(
    private readonly db: Db,
    private readonly clock: StoreClock,
  ) {}

  async log(entry: {
    event: string | null;
    installation_id: string | null;
    signature_ok: boolean;
    payload_json: string;
  }): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO webhook_log (event, installation_id, signature_ok, payload_json, created_at)
         VALUES (@event, @installation_id, @signature_ok, @payload_json, @now)`,
      )
      .run({
        event: entry.event,
        installation_id: entry.installation_id,
        signature_ok: entry.signature_ok ? 1 : 0,
        payload_json: entry.payload_json,
        now: nowIso(this.clock),
      });
  }

  async purgeCreatedBefore(cutoffIso: string): Promise<number> {
    return this.db.prepare(`DELETE FROM webhook_log WHERE created_at < ?`).run(cutoffIso).changes;
  }

  async recent(limit: number): Promise<Array<{ event: string | null; installation_id: string | null; signature_ok: number; created_at: string }>> {
    return this.db
      .prepare('SELECT event, installation_id, signature_ok, created_at FROM webhook_log ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{ event: string | null; installation_id: string | null; signature_ok: number; created_at: string }>;
  }

  async listByInstallation(
    installationId: string,
    f: { event?: string; signatureOk?: boolean; limit: number; offset: number },
  ): Promise<{ items: WebhookLogRow[]; total: number }> {
    const where = ['installation_id = @id'];
    const params: Record<string, unknown> = { id: installationId };
    if (f.event) {
      where.push('event = @event');
      params.event = f.event;
    }
    if (f.signatureOk !== undefined) {
      where.push('signature_ok = @sig');
      params.sig = f.signatureOk ? 1 : 0;
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM webhook_log ${clause}`).get(params) as { n: number }).n;
    const items = this.db
      .prepare(`SELECT * FROM webhook_log ${clause} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: f.limit, offset: f.offset }) as WebhookLogRow[];
    return { items, total };
  }

  async countSince(sinceIso: string): Promise<{ total: number; refused: number }> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN signature_ok = 0 THEN 1 ELSE 0 END) AS refused
         FROM webhook_log WHERE created_at >= ?`,
      )
      .get(sinceIso) as { total: number; refused: number | null };
    return { total: row.total, refused: row.refused ?? 0 };
  }

  async lastForInstallation(installationId: string): Promise<{ event: string | null; created_at: string } | undefined> {
    return this.db
      .prepare('SELECT event, created_at FROM webhook_log WHERE installation_id = ? ORDER BY id DESC LIMIT 1')
      .get(installationId) as { event: string | null; created_at: string } | undefined;
  }

  async findById(id: number): Promise<WebhookLogRow | undefined> {
    return this.db.prepare('SELECT * FROM webhook_log WHERE id = ?').get(id) as WebhookLogRow | undefined;
  }
}

export class SqliteRejectedItemStore implements RejectedItemStore {
  constructor(
    private readonly db: Db,
    private readonly clock: StoreClock,
  ) {}

  async add(entry: {
    installation_id: string;
    run_id: number | null;
    entity: string | null;
    source_key: string | null;
    payload_json: string;
    reason: string | null;
  }): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO rejected_item (installation_id, run_id, entity, source_key, payload_json, reason, created_at)
         VALUES (@installation_id, @run_id, @entity, @source_key, @payload_json, @reason, @now)`,
      )
      .run({ ...entry, now: nowIso(this.clock) });
  }

  async listByInstallation(installationId: string, limit: number): Promise<RejectedItemRow[]> {
    return this.db
      .prepare('SELECT * FROM rejected_item WHERE installation_id = ? ORDER BY id DESC LIMIT ?')
      .all(installationId, limit) as RejectedItemRow[];
  }

  async purgeCreatedBefore(cutoffIso: string): Promise<number> {
    return this.db.prepare(`DELETE FROM rejected_item WHERE created_at < ?`).run(cutoffIso).changes;
  }

  async list(f: {
    installationId?: string;
    entity?: string;
    sinceIso?: string;
    q?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: RejectedItemRow[]; total: number }> {
    const { where, params } = rejectedFilter(f);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM rejected_item ${clause}`).get(params) as { n: number }).n;
    const items = this.db
      .prepare(`SELECT * FROM rejected_item ${clause} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: f.limit, offset: f.offset }) as RejectedItemRow[];
    return { items, total };
  }

  async count(f: { installationId?: string; entity?: string; sinceIso?: string }): Promise<number> {
    const { where, params } = rejectedFilter(f);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM rejected_item ${clause}`).get(params) as { n: number }).n;
  }

  async countByEntity(installationId?: string): Promise<Array<{ entity: string | null; n: number }>> {
    if (installationId) {
      return this.db
        .prepare('SELECT entity, COUNT(*) AS n FROM rejected_item WHERE installation_id = ? GROUP BY entity ORDER BY n DESC')
        .all(installationId) as Array<{ entity: string | null; n: number }>;
    }
    return this.db
      .prepare('SELECT entity, COUNT(*) AS n FROM rejected_item GROUP BY entity ORDER BY n DESC')
      .all() as Array<{ entity: string | null; n: number }>;
  }

  async findById(id: number): Promise<RejectedItemRow | undefined> {
    return this.db.prepare('SELECT * FROM rejected_item WHERE id = ?').get(id) as RejectedItemRow | undefined;
  }

  async deleteByIds(installationId: string, ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .prepare(`DELETE FROM rejected_item WHERE installation_id = ? AND id IN (${placeholders})`)
      .run(installationId, ...ids).changes;
  }
}

/** Shared WHERE builder for the rejected-item filters. */
function rejectedFilter(f: {
  installationId?: string;
  entity?: string;
  sinceIso?: string;
  q?: string;
}): { where: string[]; params: Record<string, unknown> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (f.installationId) {
    where.push('installation_id = @installationId');
    params.installationId = f.installationId;
  }
  if (f.entity) {
    where.push('entity = @entity');
    params.entity = f.entity;
  }
  if (f.sinceIso) {
    where.push(`created_at >= @since`);
    params.since = f.sinceIso;
  }
  if (f.q) {
    where.push(`reason LIKE @q ESCAPE '\\'`);
    params.q = `%${likeEscape(f.q)}%`;
  }
  return { where, params };
}

export class SqliteAuditStore implements AuditStore {
  constructor(
    private readonly db: Db,
    private readonly clock: StoreClock,
  ) {}

  async add(e: {
    action: string;
    installation_id: string | null;
    target: string | null;
    details_json: string | null;
    ip: string | null;
  }): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO audit_log (at, action, installation_id, target, details_json, ip)
         VALUES (@now, @action, @installation_id, @target, @details_json, @ip)`,
      )
      .run({ ...e, now: nowIso(this.clock) });
  }

  async list(f: { limit: number; offset: number }): Promise<{ items: AuditRow[]; total: number }> {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    const items = this.db
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(f.limit, f.offset) as AuditRow[];
    return { items, total };
  }

  async purgeRecordedBefore(cutoffIso: string): Promise<number> {
    return this.db.prepare(`DELETE FROM audit_log WHERE at < ?`).run(cutoffIso).changes;
  }
}
