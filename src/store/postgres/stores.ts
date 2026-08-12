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

/**
 * PostgreSQL implementation of the persistence port.
 *
 * Same storage layout and behaviour as the SQLite adapter, with the
 * node-postgres specifics handled once here:
 *   - every COUNT/SUM is cast `::int` (pg returns int8 aggregates as strings);
 *   - `rowCount` stands in for sqlite's `changes`;
 *   - searches use `lower(col) LIKE lower($n) ESCAPE '\'` so matching is
 *     case-insensitive exactly like SQLite's default LIKE;
 *   - claims rely on `ON CONFLICT DO NOTHING` + `RETURNING id` (atomic).
 * Timestamps are ISO-8601 UTC TEXT generated in JS — never by SQL.
 */

/** Minimal query surface (satisfied by pg.Pool). Keeps `pg` a type-only import. */
export interface PgQuerier {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class PgInstallStore implements InstallStore {
  constructor(
    private readonly q: PgQuerier,
    private readonly t: (table: string) => string,
    private readonly clock: StoreClock,
  ) {}

  async upsert(u: InstallUpsert): Promise<void> {
    await this.q.query(
      `INSERT INTO ${this.t('installs')}
         (installation_id, shop_domain, shop_name, status, installed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (installation_id) DO UPDATE SET
         shop_domain  = COALESCE(excluded.shop_domain, ${this.t('installs')}.shop_domain),
         shop_name    = COALESCE(excluded.shop_name, ${this.t('installs')}.shop_name),
         status       = excluded.status,
         installed_at = COALESCE(excluded.installed_at, ${this.t('installs')}.installed_at),
         updated_at   = $6`,
      [u.installation_id, u.shop_domain ?? null, u.shop_name ?? null, u.status, u.installed_at ?? null, nowIso(this.clock)],
    );
  }

  async setStatus(
    installationId: string,
    status: string,
    stamps: { activated_at?: string | null; deactivated_at?: string | null; uninstalled_at?: string | null } = {},
  ): Promise<void> {
    await this.q.query(
      `UPDATE ${this.t('installs')} SET
         status = $2, activated_at = $3, deactivated_at = $4, uninstalled_at = $5, updated_at = $6
       WHERE installation_id = $1`,
      [installationId, status, stamps.activated_at ?? null, stamps.deactivated_at ?? null, stamps.uninstalled_at ?? null, nowIso(this.clock)],
    );
  }

  async setExternalAccount(installationId: string, ref: string | null, name: string | null = null): Promise<void> {
    await this.q.query(
      `UPDATE ${this.t('installs')} SET external_account_ref = $2, external_account_name = $3, updated_at = $4
       WHERE installation_id = $1`,
      [installationId, ref, name, nowIso(this.clock)],
    );
  }

  async find(installationId: string): Promise<InstallRow | undefined> {
    const r = await this.q.query(`SELECT * FROM ${this.t('installs')} WHERE installation_id = $1`, [installationId]);
    return r.rows[0] as InstallRow | undefined;
  }

  async listActive(): Promise<InstallRow[]> {
    const r = await this.q.query(`SELECT * FROM ${this.t('installs')} WHERE status = 'active'`);
    return r.rows as InstallRow[];
  }

  async list(f: { status?: string; q?: string; limit: number; offset: number }): Promise<{ items: InstallRow[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.status) {
      params.push(f.status);
      where.push(`status = $${params.length}`);
    }
    if (f.q) {
      params.push(`%${likeEscape(f.q)}%`);
      const n = params.length;
      where.push(
        `(lower(installation_id) LIKE lower($${n}) ESCAPE '\\' OR lower(shop_domain) LIKE lower($${n}) ESCAPE '\\' OR lower(shop_name) LIKE lower($${n}) ESCAPE '\\')`,
      );
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.q.query(`SELECT COUNT(*)::int AS n FROM ${this.t('installs')} ${clause}`, params);
    const items = await this.q.query(
      `SELECT * FROM ${this.t('installs')} ${clause} ORDER BY updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.limit, f.offset],
    );
    return { items: items.rows as InstallRow[], total: (total.rows[0] as { n: number }).n };
  }

  async countByStatus(): Promise<Record<string, number>> {
    const r = await this.q.query(`SELECT status, COUNT(*)::int AS n FROM ${this.t('installs')} GROUP BY status`);
    const out: Record<string, number> = {};
    for (const row of r.rows as Array<{ status: string; n: number }>) out[row.status] = row.n;
    return out;
  }
}

export class PgStateKvStore implements StateKvStore {
  constructor(
    private readonly q: PgQuerier,
    private readonly t: (table: string) => string,
    private readonly clock: StoreClock,
  ) {}

  async write(installationId: string, key: string, value: string, encrypted: boolean): Promise<void> {
    await this.q.query(
      `INSERT INTO ${this.t('integration_state')} (installation_id, key, value, encrypted, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (installation_id, key) DO UPDATE SET
         value = excluded.value, encrypted = excluded.encrypted, updated_at = $5`,
      [installationId, key, value, encrypted ? 1 : 0, nowIso(this.clock)],
    );
  }

  async read(installationId: string, key: string): Promise<StateEntry | undefined> {
    const r = await this.q.query(
      `SELECT value, encrypted FROM ${this.t('integration_state')} WHERE installation_id = $1 AND key = $2`,
      [installationId, key],
    );
    const row = r.rows[0] as { value: string | null; encrypted: number } | undefined;
    if (!row) return undefined;
    return { value: row.value, encrypted: row.encrypted === 1 };
  }

  async delete(installationId: string, key: string): Promise<void> {
    await this.q.query(`DELETE FROM ${this.t('integration_state')} WHERE installation_id = $1 AND key = $2`, [installationId, key]);
  }

  async listMeta(installationId: string): Promise<StateMetaRow[]> {
    // The CASE guarantees at the SQL level that an encrypted value is never
    // materialized: `value_preview` is NULL whenever `encrypted = 1`.
    const r = await this.q.query(
      `SELECT key,
              encrypted,
              updated_at,
              COALESCE(length(value), 0)::int AS value_length,
              CASE WHEN encrypted = 0 THEN substr(value, 1, 200) ELSE NULL END AS value_preview
       FROM ${this.t('integration_state')} WHERE installation_id = $1 ORDER BY key`,
      [installationId],
    );
    return (r.rows as Array<{ key: string; encrypted: number; updated_at: string; value_length: number; value_preview: string | null }>).map(
      (row) => ({
        key: row.key,
        encrypted: row.encrypted === 1,
        updated_at: row.updated_at,
        value_length: row.value_length,
        value_preview: row.value_preview,
      }),
    );
  }
}

export class PgCursorStore implements CursorStore {
  constructor(
    private readonly q: PgQuerier,
    private readonly t: (table: string) => string,
    private readonly clock: StoreClock,
  ) {}

  async get(installationId: string, entity: string, sourceKey: string): Promise<CursorRow | undefined> {
    const r = await this.q.query(
      `SELECT * FROM ${this.t('sync_cursor')} WHERE installation_id = $1 AND entity = $2 AND source_key = $3`,
      [installationId, entity, sourceKey],
    );
    return r.rows[0] as CursorRow | undefined;
  }

  async set(installationId: string, entity: string, sourceKey: string, w: CursorWrite): Promise<void> {
    await this.q.query(
      `INSERT INTO ${this.t('sync_cursor')}
         (installation_id, entity, source_key, last_synced_at, last_status, last_error, items, consecutive_failures, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::int, 0), $9)
       ON CONFLICT (installation_id, entity, source_key) DO UPDATE SET
         last_synced_at = excluded.last_synced_at,
         last_status    = excluded.last_status,
         last_error     = excluded.last_error,
         items          = excluded.items,
         consecutive_failures = COALESCE($8::int, ${this.t('sync_cursor')}.consecutive_failures),
         updated_at     = $9`,
      [
        installationId,
        entity,
        sourceKey,
        w.last_synced_at,
        w.last_status ?? null,
        w.last_error ?? null,
        w.items ?? 0,
        w.consecutive_failures ?? null,
        nowIso(this.clock),
      ],
    );
  }

  async listByInstallation(installationId: string): Promise<CursorRow[]> {
    const r = await this.q.query(
      `SELECT * FROM ${this.t('sync_cursor')} WHERE installation_id = $1 ORDER BY entity, source_key`,
      [installationId],
    );
    return r.rows as CursorRow[];
  }

  async countInError(): Promise<number> {
    const r = await this.q.query(`SELECT COUNT(*)::int AS n FROM ${this.t('sync_cursor')} WHERE last_status = 'error'`);
    return (r.rows[0] as { n: number }).n;
  }
}

export class PgRunStore implements RunStore {
  constructor(
    private readonly q: PgQuerier,
    private readonly t: (table: string) => string,
    private readonly clock: StoreClock,
  ) {}

  async start(installationId: string): Promise<number> {
    const r = await this.q.query(
      `INSERT INTO ${this.t('sync_run')} (installation_id, status, started_at) VALUES ($1, 'running', $2) RETURNING id`,
      [installationId, nowIso(this.clock)],
    );
    return (r.rows[0] as { id: number }).id;
  }

  async finish(runId: number, status: 'ok' | 'partial' | 'failed', summaryJson: string): Promise<void> {
    await this.q.query(
      `UPDATE ${this.t('sync_run')} SET status = $2, summary_json = $3, finished_at = $4 WHERE id = $1`,
      [runId, status, summaryJson, nowIso(this.clock)],
    );
  }

  async recent(installationId: string, limit: number): Promise<SyncRunRow[]> {
    const r = await this.q.query(
      `SELECT * FROM ${this.t('sync_run')} WHERE installation_id = $1 ORDER BY id DESC LIMIT $2`,
      [installationId, limit],
    );
    return r.rows as SyncRunRow[];
  }

  async list(installationId: string, f: { limit: number; offset: number }): Promise<{ items: SyncRunRow[]; total: number }> {
    const total = await this.q.query(`SELECT COUNT(*)::int AS n FROM ${this.t('sync_run')} WHERE installation_id = $1`, [installationId]);
    const items = await this.q.query(
      `SELECT * FROM ${this.t('sync_run')} WHERE installation_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
      [installationId, f.limit, f.offset],
    );
    return { items: items.rows as SyncRunRow[], total: (total.rows[0] as { n: number }).n };
  }

  async purgeStartedBefore(cutoffIso: string): Promise<number> {
    const r = await this.q.query(`DELETE FROM ${this.t('sync_run')} WHERE started_at < $1`, [cutoffIso]);
    return r.rowCount ?? 0;
  }
}

export class PgInboundEventStore implements InboundEventStore {
  constructor(
    private readonly q: PgQuerier,
    private readonly t: (table: string) => string,
    private readonly clock: StoreClock,
  ) {}

  async find(installationId: string, idempotencyKey: string): Promise<InboundEventRow | undefined> {
    const r = await this.q.query(
      `SELECT * FROM ${this.t('inbound_event')} WHERE installation_id = $1 AND idempotency_key = $2`,
      [installationId, idempotencyKey],
    );
    return r.rows[0] as InboundEventRow | undefined;
  }

  async claim(
    installationId: string,
    idempotencyKey: string,
    action: string | null,
  ): Promise<{ rowId: number; fresh: boolean; status: InboundEventRow['status'] }> {
    const insert = `INSERT INTO ${this.t('inbound_event')} (installation_id, idempotency_key, action, status, received_at)
       VALUES ($1, $2, $3, 'received', $4)
       ON CONFLICT (installation_id, idempotency_key) DO NOTHING
       RETURNING id`;
    const first = await this.q.query(insert, [installationId, idempotencyKey, action, nowIso(this.clock)]);
    if (first.rows[0]) return { rowId: (first.rows[0] as { id: number }).id, fresh: true, status: 'received' };
    const existing = await this.find(installationId, idempotencyKey);
    if (!existing) {
      // Extreme race (row deleted between the INSERT and the SELECT): retry once.
      const retry = await this.q.query(insert, [installationId, idempotencyKey, action, nowIso(this.clock)]);
      const row = await this.find(installationId, idempotencyKey);
      const retriedId = retry.rows[0] ? (retry.rows[0] as { id: number }).id : 0;
      return { rowId: row ? row.id : retriedId, fresh: !!retry.rows[0], status: row ? row.status : 'received' };
    }
    return { rowId: existing.id, fresh: false, status: existing.status };
  }

  async finish(id: number, status: 'done' | 'failed', error: string | null): Promise<void> {
    await this.q.query(
      `UPDATE ${this.t('inbound_event')} SET status = $2, error = $3, processed_at = $4 WHERE id = $1`,
      [id, status, error, nowIso(this.clock)],
    );
  }

  async purgeReceivedBefore(cutoffIso: string): Promise<number> {
    const r = await this.q.query(`DELETE FROM ${this.t('inbound_event')} WHERE received_at < $1`, [cutoffIso]);
    return r.rowCount ?? 0;
  }

  async listByInstallation(
    installationId: string,
    f: { limit: number; offset: number },
  ): Promise<{ items: InboundEventRow[]; total: number }> {
    const total = await this.q.query(`SELECT COUNT(*)::int AS n FROM ${this.t('inbound_event')} WHERE installation_id = $1`, [installationId]);
    const items = await this.q.query(
      `SELECT * FROM ${this.t('inbound_event')} WHERE installation_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
      [installationId, f.limit, f.offset],
    );
    return { items: items.rows as InboundEventRow[], total: (total.rows[0] as { n: number }).n };
  }
}

export class PgWebhookSeenStore implements WebhookSeenStore {
  constructor(
    private readonly q: PgQuerier,
    private readonly t: (table: string) => string,
    private readonly clock: StoreClock,
  ) {}

  async claim(installationId: string, dedupKey: string): Promise<boolean> {
    const r = await this.q.query(
      `INSERT INTO ${this.t('webhook_seen')} (installation_id, dedup_key, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (installation_id, dedup_key) DO NOTHING`,
      [installationId, dedupKey, nowIso(this.clock)],
    );
    return (r.rowCount ?? 0) === 1;
  }

  async release(installationId: string, dedupKey: string): Promise<void> {
    await this.q.query(`DELETE FROM ${this.t('webhook_seen')} WHERE installation_id = $1 AND dedup_key = $2`, [installationId, dedupKey]);
  }

  async purgeCreatedBefore(cutoffIso: string): Promise<number> {
    const r = await this.q.query(`DELETE FROM ${this.t('webhook_seen')} WHERE created_at < $1`, [cutoffIso]);
    return r.rowCount ?? 0;
  }

  async countByInstallationSince(installationId: string, sinceIso: string): Promise<number> {
    const r = await this.q.query(
      `SELECT COUNT(*)::int AS n FROM ${this.t('webhook_seen')} WHERE installation_id = $1 AND created_at >= $2`,
      [installationId, sinceIso],
    );
    return (r.rows[0] as { n: number }).n;
  }
}

export class PgWebhookLogStore implements WebhookLogStore {
  constructor(
    private readonly q: PgQuerier,
    private readonly t: (table: string) => string,
    private readonly clock: StoreClock,
  ) {}

  async log(entry: {
    event: string | null;
    installation_id: string | null;
    signature_ok: boolean;
    payload_json: string;
  }): Promise<void> {
    await this.q.query(
      `INSERT INTO ${this.t('webhook_log')} (event, installation_id, signature_ok, payload_json, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [entry.event, entry.installation_id, entry.signature_ok ? 1 : 0, entry.payload_json, nowIso(this.clock)],
    );
  }

  async purgeCreatedBefore(cutoffIso: string): Promise<number> {
    const r = await this.q.query(`DELETE FROM ${this.t('webhook_log')} WHERE created_at < $1`, [cutoffIso]);
    return r.rowCount ?? 0;
  }

  async recent(limit: number): Promise<Array<{ event: string | null; installation_id: string | null; signature_ok: number; created_at: string }>> {
    const r = await this.q.query(
      `SELECT event, installation_id, signature_ok, created_at FROM ${this.t('webhook_log')} ORDER BY id DESC LIMIT $1`,
      [limit],
    );
    return r.rows as Array<{ event: string | null; installation_id: string | null; signature_ok: number; created_at: string }>;
  }

  async listByInstallation(
    installationId: string,
    f: { event?: string; signatureOk?: boolean; limit: number; offset: number },
  ): Promise<{ items: WebhookLogRow[]; total: number }> {
    const where = ['installation_id = $1'];
    const params: unknown[] = [installationId];
    if (f.event) {
      params.push(f.event);
      where.push(`event = $${params.length}`);
    }
    if (f.signatureOk !== undefined) {
      params.push(f.signatureOk ? 1 : 0);
      where.push(`signature_ok = $${params.length}`);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = await this.q.query(`SELECT COUNT(*)::int AS n FROM ${this.t('webhook_log')} ${clause}`, params);
    const items = await this.q.query(
      `SELECT * FROM ${this.t('webhook_log')} ${clause} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.limit, f.offset],
    );
    return { items: items.rows as WebhookLogRow[], total: (total.rows[0] as { n: number }).n };
  }

  async countSince(sinceIso: string): Promise<{ total: number; refused: number }> {
    const r = await this.q.query(
      `SELECT COUNT(*)::int AS total, COALESCE(SUM(CASE WHEN signature_ok = 0 THEN 1 ELSE 0 END), 0)::int AS refused
       FROM ${this.t('webhook_log')} WHERE created_at >= $1`,
      [sinceIso],
    );
    const row = r.rows[0] as { total: number; refused: number };
    return { total: row.total, refused: row.refused };
  }

  async lastForInstallation(installationId: string): Promise<{ event: string | null; created_at: string } | undefined> {
    const r = await this.q.query(
      `SELECT event, created_at FROM ${this.t('webhook_log')} WHERE installation_id = $1 ORDER BY id DESC LIMIT 1`,
      [installationId],
    );
    return r.rows[0] as { event: string | null; created_at: string } | undefined;
  }

  async findById(id: number): Promise<WebhookLogRow | undefined> {
    const r = await this.q.query(`SELECT * FROM ${this.t('webhook_log')} WHERE id = $1`, [id]);
    return r.rows[0] as WebhookLogRow | undefined;
  }
}

export class PgRejectedItemStore implements RejectedItemStore {
  constructor(
    private readonly q: PgQuerier,
    private readonly t: (table: string) => string,
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
    await this.q.query(
      `INSERT INTO ${this.t('rejected_item')} (installation_id, run_id, entity, source_key, payload_json, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [entry.installation_id, entry.run_id, entry.entity, entry.source_key, entry.payload_json, entry.reason, nowIso(this.clock)],
    );
  }

  async listByInstallation(installationId: string, limit: number): Promise<RejectedItemRow[]> {
    const r = await this.q.query(
      `SELECT * FROM ${this.t('rejected_item')} WHERE installation_id = $1 ORDER BY id DESC LIMIT $2`,
      [installationId, limit],
    );
    return r.rows as RejectedItemRow[];
  }

  async purgeCreatedBefore(cutoffIso: string): Promise<number> {
    const r = await this.q.query(`DELETE FROM ${this.t('rejected_item')} WHERE created_at < $1`, [cutoffIso]);
    return r.rowCount ?? 0;
  }

  private filter(f: { installationId?: string; entity?: string; sinceIso?: string; q?: string }): { where: string[]; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.installationId) {
      params.push(f.installationId);
      where.push(`installation_id = $${params.length}`);
    }
    if (f.entity) {
      params.push(f.entity);
      where.push(`entity = $${params.length}`);
    }
    if (f.sinceIso) {
      params.push(f.sinceIso);
      where.push(`created_at >= $${params.length}`);
    }
    if (f.q) {
      params.push(`%${likeEscape(f.q)}%`);
      where.push(`lower(reason) LIKE lower($${params.length}) ESCAPE '\\'`);
    }
    return { where, params };
  }

  async list(f: {
    installationId?: string;
    entity?: string;
    sinceIso?: string;
    q?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: RejectedItemRow[]; total: number }> {
    const { where, params } = this.filter(f);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.q.query(`SELECT COUNT(*)::int AS n FROM ${this.t('rejected_item')} ${clause}`, params);
    const items = await this.q.query(
      `SELECT * FROM ${this.t('rejected_item')} ${clause} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.limit, f.offset],
    );
    return { items: items.rows as RejectedItemRow[], total: (total.rows[0] as { n: number }).n };
  }

  async count(f: { installationId?: string; entity?: string; sinceIso?: string }): Promise<number> {
    const { where, params } = this.filter(f);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const r = await this.q.query(`SELECT COUNT(*)::int AS n FROM ${this.t('rejected_item')} ${clause}`, params);
    return (r.rows[0] as { n: number }).n;
  }

  async countByEntity(installationId?: string): Promise<Array<{ entity: string | null; n: number }>> {
    if (installationId) {
      const r = await this.q.query(
        `SELECT entity, COUNT(*)::int AS n FROM ${this.t('rejected_item')} WHERE installation_id = $1 GROUP BY entity ORDER BY n DESC`,
        [installationId],
      );
      return r.rows as Array<{ entity: string | null; n: number }>;
    }
    const r = await this.q.query(`SELECT entity, COUNT(*)::int AS n FROM ${this.t('rejected_item')} GROUP BY entity ORDER BY n DESC`);
    return r.rows as Array<{ entity: string | null; n: number }>;
  }

  async findById(id: number): Promise<RejectedItemRow | undefined> {
    const r = await this.q.query(`SELECT * FROM ${this.t('rejected_item')} WHERE id = $1`, [id]);
    return r.rows[0] as RejectedItemRow | undefined;
  }

  async deleteByIds(installationId: string, ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    const r = await this.q.query(
      `DELETE FROM ${this.t('rejected_item')} WHERE installation_id = $1 AND id = ANY($2::int[])`,
      [installationId, ids],
    );
    return r.rowCount ?? 0;
  }
}

export class PgAuditStore implements AuditStore {
  constructor(
    private readonly q: PgQuerier,
    private readonly t: (table: string) => string,
    private readonly clock: StoreClock,
  ) {}

  async add(e: {
    action: string;
    installation_id: string | null;
    target: string | null;
    details_json: string | null;
    ip: string | null;
  }): Promise<void> {
    await this.q.query(
      `INSERT INTO ${this.t('audit_log')} (at, action, installation_id, target, details_json, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [nowIso(this.clock), e.action, e.installation_id, e.target, e.details_json, e.ip],
    );
  }

  async list(f: { limit: number; offset: number }): Promise<{ items: AuditRow[]; total: number }> {
    const total = await this.q.query(`SELECT COUNT(*)::int AS n FROM ${this.t('audit_log')}`);
    const items = await this.q.query(`SELECT * FROM ${this.t('audit_log')} ORDER BY id DESC LIMIT $1 OFFSET $2`, [f.limit, f.offset]);
    return { items: items.rows as AuditRow[], total: (total.rows[0] as { n: number }).n };
  }

  async purgeRecordedBefore(cutoffIso: string): Promise<number> {
    const r = await this.q.query(`DELETE FROM ${this.t('audit_log')} WHERE at < $1`, [cutoffIso]);
    return r.rowCount ?? 0;
  }
}
