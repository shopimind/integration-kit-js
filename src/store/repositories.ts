import type DatabaseT from 'better-sqlite3';
import type { SecretCipher } from '../security/crypto.js';
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
} from './types.js';

const nn = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

/** GCM AAD binding an encrypted secret to its exact location (anti-relocation). */
const aadFor = (installationId: string, key: string): string => `${installationId}:${key}`;

/** Escapes LIKE metacharacters (`%`, `_`, `\`) so a search term matches literally. */
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Installs (one row per installation). COALESCE upsert: a null field does not overwrite. */
export class InstallRepo {
  constructor(private readonly db: DatabaseT.Database) {}

  upsert(u: InstallUpsert): void {
    this.db
      .prepare(
        `INSERT INTO installs
           (installation_id, shop_domain, shop_name, status, installed_at, updated_at)
         VALUES
           (@installation_id, @shop_domain, @shop_name, @status, @installed_at, datetime('now'))
         ON CONFLICT(installation_id) DO UPDATE SET
           shop_domain  = COALESCE(excluded.shop_domain, shop_domain),
           shop_name    = COALESCE(excluded.shop_name, shop_name),
           status       = excluded.status,
           installed_at = COALESCE(excluded.installed_at, installed_at),
           updated_at   = datetime('now')`,
      )
      .run({
        installation_id: u.installation_id,
        shop_domain: nn(u.shop_domain),
        shop_name: nn(u.shop_name),
        status: u.status,
        installed_at: nn(u.installed_at),
      });
  }

  setStatus(
    installationId: string,
    status: InstallRow['status'],
    stamps: { activated_at?: string | null; deactivated_at?: string | null; uninstalled_at?: string | null } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE installs SET
           status         = @status,
           activated_at   = @activated_at,
           deactivated_at = @deactivated_at,
           uninstalled_at = @uninstalled_at,
           updated_at     = datetime('now')
         WHERE installation_id = @installation_id`,
      )
      .run({
        installation_id: installationId,
        status,
        activated_at: nn(stamps.activated_at),
        deactivated_at: nn(stamps.deactivated_at),
        uninstalled_at: nn(stamps.uninstalled_at),
      });
  }

  /** Sets the INTEGRATOR account associated with the installation (the correlation bridge). */
  setExternalAccount(installationId: string, ref: string | null, name: string | null = null): void {
    this.db
      .prepare(
        `UPDATE installs SET
           external_account_ref  = @ref,
           external_account_name = @name,
           updated_at            = datetime('now')
         WHERE installation_id = @installation_id`,
      )
      .run({ installation_id: installationId, ref: nn(ref), name: nn(name) });
  }

  find(installationId: string): InstallRow | undefined {
    return this.db
      .prepare('SELECT * FROM installs WHERE installation_id = ?')
      .get(installationId) as InstallRow | undefined;
  }

  listActive(): InstallRow[] {
    return this.db.prepare(`SELECT * FROM installs WHERE status = 'active'`).all() as InstallRow[];
  }

  /** Paginated list for the admin UI. `q` = case-insensitive LIKE across id/domain/name. */
  list(f: { status?: string; q?: string; limit: number; offset: number }): { items: InstallRow[]; total: number } {
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
    const limit = Math.max(1, Math.min(f.limit, 200));
    const items = this.db
      .prepare(`SELECT * FROM installs ${clause} ORDER BY updated_at DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset: Math.max(0, f.offset) }) as InstallRow[];
    return { items, total };
  }

  /** Count per status (dashboard). */
  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM installs GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
  }
}

/** Webhook log. The `payload_json` MUST already be redacted by the runtime. */
export class WebhookLogRepo {
  constructor(private readonly db: DatabaseT.Database) {}

  log(entry: {
    event: string | null;
    installation_id?: string | null;
    signature_ok: boolean;
    payload_json: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO webhook_log (event, installation_id, signature_ok, payload_json)
         VALUES (@event, @installation_id, @signature_ok, @payload_json)`,
      )
      .run({
        event: nn(entry.event),
        installation_id: nn(entry.installation_id),
        signature_ok: entry.signature_ok ? 1 : 0,
        payload_json: entry.payload_json,
      });
  }

  /** Retention: deletes log rows older than `days` days. Returns the number of rows removed. */
  purgeOlderThan(days: number): number {
    return this.db
      .prepare(`DELETE FROM webhook_log WHERE created_at < datetime('now', @cutoff)`)
      .run({ cutoff: `-${days} days` }).changes;
  }

  /** Most recent webhook log entries (newest first) — for /admin/overview (E5). */
  recent(limit = 20): Array<{ event: string | null; installation_id: string | null; signature_ok: number; created_at: string }> {
    const capped = Math.max(1, Math.min(limit, 200));
    return this.db
      .prepare('SELECT event, installation_id, signature_ok, created_at FROM webhook_log ORDER BY id DESC LIMIT ?')
      .all(capped) as Array<{ event: string | null; installation_id: string | null; signature_ok: number; created_at: string }>;
  }

  /** Paginated webhook log for one installation (newest first). Payloads masked by the caller. */
  listByInstallation(
    id: string,
    f: { event?: string; signatureOk?: boolean; limit: number; offset: number },
  ): { items: WebhookLogRow[]; total: number } {
    const where = ['installation_id = @id'];
    const params: Record<string, unknown> = { id };
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
    const limit = Math.max(1, Math.min(f.limit, 200));
    const items = this.db
      .prepare(`SELECT * FROM webhook_log ${clause} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset: Math.max(0, f.offset) }) as WebhookLogRow[];
    return { items, total };
  }

  /** Dashboard counter: webhooks received in the last `hours`, and how many were refused. */
  countSince(hours: number): { total: number; refused: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN signature_ok = 0 THEN 1 ELSE 0 END) AS refused
         FROM webhook_log WHERE created_at >= datetime('now', @cutoff)`,
      )
      .get({ cutoff: `-${hours} hours` }) as { total: number; refused: number | null };
    return { total: row.total, refused: row.refused ?? 0 };
  }

  /** Last webhook event seen for an installation (lifecycle timeline). */
  lastForInstallation(id: string): { event: string | null; created_at: string } | undefined {
    return this.db
      .prepare('SELECT event, created_at FROM webhook_log WHERE installation_id = ? ORDER BY id DESC LIMIT 1')
      .get(id) as { event: string | null; created_at: string } | undefined;
  }

  /** Single webhook log row by id (installation scoping is enforced by the caller). */
  findById(id: number): WebhookLogRow | undefined {
    return this.db.prepare('SELECT * FROM webhook_log WHERE id = ?').get(id) as WebhookLogRow | undefined;
  }
}

/** Replay protection for lifecycle webhooks (key derived from the signature). */
export class WebhookSeenRepo {
  constructor(private readonly db: DatabaseT.Database) {}

  /** Atomically claims processing; `false` if the signature was already seen (replay). */
  claim(installationId: string, dedupKey: string): boolean {
    const info = this.db
      .prepare(
        `INSERT INTO webhook_seen (installation_id, dedup_key) VALUES (?, ?)
         ON CONFLICT(installation_id, dedup_key) DO NOTHING`,
      )
      .run(installationId, dedupKey);
    return info.changes === 1;
  }

  /** Releases a claim (failed processing) -> an identical resend can retry. */
  release(installationId: string, dedupKey: string): void {
    this.db
      .prepare('DELETE FROM webhook_seen WHERE installation_id = ? AND dedup_key = ?')
      .run(installationId, dedupKey);
  }

  /** Retention: deletes dedup rows older than `days` days. Returns the number of rows removed. */
  purgeOlderThan(days: number): number {
    return this.db
      .prepare(`DELETE FROM webhook_seen WHERE created_at < datetime('now', @cutoff)`)
      .run({ cutoff: `-${days} days` }).changes;
  }

  /** Count of retained signatures for an installation over the last `days` (idempotence view). */
  countByInstallationSince(id: string, days: number): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM webhook_seen WHERE installation_id = ? AND created_at >= datetime('now', ?)`)
        .get(id, `-${days} days`) as { n: number }
    ).n;
  }
}

/** Sync cursors, scoped by (installation, entity, source_key). */
export class CursorRepo {
  constructor(private readonly db: DatabaseT.Database) {}

  get(installationId: string, entity: string, sourceKey = ''): CursorRow | undefined {
    return this.db
      .prepare('SELECT * FROM sync_cursor WHERE installation_id = ? AND entity = ? AND source_key = ?')
      .get(installationId, entity, sourceKey) as CursorRow | undefined;
  }

  set(installationId: string, entity: string, sourceKey: string, w: CursorWrite): void {
    this.db
      .prepare(
        `INSERT INTO sync_cursor
           (installation_id, entity, source_key, last_synced_at, last_status, last_error, items,
            consecutive_failures, updated_at)
         VALUES
           (@installation_id, @entity, @source_key, @last_synced_at, @last_status, @last_error, @items,
            COALESCE(@consecutive_failures, 0), datetime('now'))
         ON CONFLICT(installation_id, entity, source_key) DO UPDATE SET
           last_synced_at = excluded.last_synced_at,
           last_status    = excluded.last_status,
           last_error     = excluded.last_error,
           items          = excluded.items,
           -- Omitted (@consecutive_failures IS NULL) -> keep the existing counter.
           consecutive_failures = COALESCE(@consecutive_failures, sync_cursor.consecutive_failures),
           updated_at     = datetime('now')`,
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
      });
  }

  /** All cursors for an installation (for /health, /admin/overview). */
  listByInstallation(installationId: string): CursorRow[] {
    return this.db
      .prepare('SELECT * FROM sync_cursor WHERE installation_id = ? ORDER BY entity, source_key')
      .all(installationId) as CursorRow[];
  }

  /** Number of cursors currently in the `error` status (health signal). */
  countInError(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM sync_cursor WHERE last_status = 'error'`)
      .get() as { n: number };
    return row.n;
  }
}

/** History of sync runs. */
export class RunRepo {
  constructor(private readonly db: DatabaseT.Database) {}

  start(installationId: string): number {
    const info = this.db
      .prepare(`INSERT INTO sync_run (installation_id, status) VALUES (?, 'running')`)
      .run(installationId);
    return Number(info.lastInsertRowid);
  }

  finish(runId: number, status: 'ok' | 'partial' | 'failed', summary: unknown): void {
    // Never let a non-serializable summary (circular reference, BigInt, …) throw and
    // leave the run stuck in 'running': fall back to a safe placeholder instead.
    let summaryJson: string;
    try {
      summaryJson = JSON.stringify(summary);
    } catch {
      summaryJson = '{"error":"unserializable summary"}';
    }
    this.db
      .prepare(`UPDATE sync_run SET status = @status, summary_json = @summary_json, finished_at = datetime('now') WHERE id = @id`)
      .run({ id: runId, status, summary_json: summaryJson });
  }

  recent(installationId: string, limit = 10): SyncRunRow[] {
    const capped = Math.max(1, Math.min(limit, 200));
    return this.db
      .prepare('SELECT * FROM sync_run WHERE installation_id = ? ORDER BY id DESC LIMIT ?')
      .all(installationId, capped) as SyncRunRow[];
  }

  /** Paginated runs for an installation (newest first) + total. */
  list(id: string, f: { limit: number; offset: number }): { items: SyncRunRow[]; total: number } {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM sync_run WHERE installation_id = ?').get(id) as { n: number }).n;
    const limit = Math.max(1, Math.min(f.limit, 200));
    const items = this.db
      .prepare('SELECT * FROM sync_run WHERE installation_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(id, limit, Math.max(0, f.offset)) as SyncRunRow[];
    return { items, total };
  }

  /** Retention: deletes run rows older than `days` days. Returns rows removed. */
  purgeOlderThan(days: number): number {
    return this.db
      .prepare(`DELETE FROM sync_run WHERE started_at < datetime('now', @cutoff)`)
      .run({ cutoff: `-${days} days` }).changes;
  }
}

/**
 * Private integration state (KV per installation). Sensitive values are encrypted
 * at rest via the kit's `SecretCipher`.
 */
export class IntegrationStateRepo {
  constructor(
    private readonly db: DatabaseT.Database,
    private readonly cipher: SecretCipher,
  ) {}

  private write(installationId: string, key: string, value: string, encrypted: boolean): void {
    this.db
      .prepare(
        `INSERT INTO integration_state (installation_id, key, value, encrypted, updated_at)
         VALUES (@id, @key, @value, @encrypted, datetime('now'))
         ON CONFLICT(installation_id, key) DO UPDATE SET
           value = excluded.value, encrypted = excluded.encrypted, updated_at = datetime('now')`,
      )
      .run({ id: installationId, key, value, encrypted: encrypted ? 1 : 0 });
  }

  set(installationId: string, key: string, value: string): void {
    this.write(installationId, key, value, false);
  }

  setSecret(installationId: string, key: string, value: string): void {
    this.write(installationId, key, this.cipher.encrypt(value, aadFor(installationId, key)), true);
  }

  get(installationId: string, key: string): string | null {
    const row = this.db
      .prepare('SELECT value, encrypted FROM integration_state WHERE installation_id = ? AND key = ?')
      .get(installationId, key) as { value: string | null; encrypted: number } | undefined;
    if (!row || row.value === null) return null;
    return row.encrypted ? this.cipher.decrypt(row.value, aadFor(installationId, key)) : row.value;
  }

  delete(installationId: string, key: string): void {
    this.db
      .prepare('DELETE FROM integration_state WHERE installation_id = ? AND key = ?')
      .run(installationId, key);
  }

  /**
   * Metadata for every state key of an installation — WITHOUT ever reading the value
   * of an encrypted row. The `CASE` guarantees at the SQL level that a secret's value
   * is never materialized: `value_preview` is NULL whenever `encrypted = 1`.
   */
  listMeta(
    installationId: string,
  ): Array<{ key: string; encrypted: 0 | 1; updated_at: string; value_length: number; value_preview: string | null }> {
    return this.db
      .prepare(
        `SELECT key,
                encrypted,
                updated_at,
                COALESCE(length(value), 0) AS value_length,
                CASE WHEN encrypted = 0 THEN substr(value, 1, 200) ELSE NULL END AS value_preview
         FROM integration_state WHERE installation_id = ? ORDER BY key`,
      )
      .all(installationId) as Array<{
      key: string;
      encrypted: 0 | 1;
      updated_at: string;
      value_length: number;
      value_preview: string | null;
    }>;
  }
}

/** Log of inbound calls (middleware idempotency + audit). */
export class InboundEventRepo {
  constructor(private readonly db: DatabaseT.Database) {}

  find(installationId: string, idempotencyKey: string): InboundEventRow | undefined {
    return this.db
      .prepare('SELECT * FROM inbound_event WHERE installation_id = ? AND idempotency_key = ?')
      .get(installationId, idempotencyKey) as InboundEventRow | undefined;
  }

  /**
   * ATOMICALLY claims the processing of an inbound call (anti-TOCTOU). The INSERT
   * `ON CONFLICT DO NOTHING` relies on the UNIQUE index (installation_id, idempotency_key):
   * - `fresh: true` => row created by THIS call -> it is responsible for processing;
   * - `fresh: false` => a row already existed -> `status` tells where it stands
   *   ('received' = in progress/already claimed, 'done' = processed, 'failed' = retryable).
   */
  claim(installationId: string, idempotencyKey: string, action: string | null): { rowId: number; fresh: boolean; status: InboundEventRow['status'] } {
    const info = this.db
      .prepare(
        `INSERT INTO inbound_event (installation_id, idempotency_key, action, status)
         VALUES (?, ?, ?, 'received')
         ON CONFLICT(installation_id, idempotency_key) DO NOTHING`,
      )
      .run(installationId, idempotencyKey, nn(action));
    if (info.changes === 1) return { rowId: Number(info.lastInsertRowid), fresh: true, status: 'received' };
    const existing = this.find(installationId, idempotencyKey);
    if (!existing) {
      // Extreme race (row deleted between the INSERT and the SELECT): retry once.
      const retry = this.db
        .prepare(`INSERT INTO inbound_event (installation_id, idempotency_key, action, status) VALUES (?, ?, ?, 'received') ON CONFLICT(installation_id, idempotency_key) DO NOTHING`)
        .run(installationId, idempotencyKey, nn(action));
      const row = this.find(installationId, idempotencyKey);
      return { rowId: row ? row.id : Number(retry.lastInsertRowid), fresh: retry.changes === 1, status: row ? row.status : 'received' };
    }
    return { rowId: existing.id, fresh: false, status: existing.status };
  }

  finish(id: number, status: 'done' | 'failed', error: string | null = null): void {
    this.db
      .prepare(`UPDATE inbound_event SET status = @status, error = @error, processed_at = datetime('now') WHERE id = @id`)
      .run({ id, status, error: nn(error) });
  }

  /** Retention: deletes inbound rows older than `days` days. Returns the number of rows removed. */
  purgeOlderThan(days: number): number {
    return this.db
      .prepare(`DELETE FROM inbound_event WHERE received_at < datetime('now', @cutoff)`)
      .run({ cutoff: `-${days} days` }).changes;
  }

  /** Paginated inbound events for an installation (newest first) + total. */
  listByInstallation(id: string, f: { limit: number; offset: number }): { items: InboundEventRow[]; total: number } {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM inbound_event WHERE installation_id = ?').get(id) as { n: number }).n;
    const limit = Math.max(1, Math.min(f.limit, 200));
    const items = this.db
      .prepare('SELECT * FROM inbound_event WHERE installation_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(id, limit, Math.max(0, f.offset)) as InboundEventRow[];
    return { items, total };
  }
}

/**
 * Dead-letter of per-item REJECTIONS (E4). The engine records here what the
 * ShopiMind API refused during a bulk push (validation), capped per run so a
 * poison batch cannot flood the store; an operator inspects/replays via the admin
 * endpoint. Subject to the same retention purge as the other log tables.
 */
export class RejectedItemRepo {
  constructor(private readonly db: DatabaseT.Database) {}

  add(entry: {
    installation_id: string;
    run_id?: number | null;
    entity?: string | null;
    source_key?: string | null;
    payload_json: string;
    reason?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO rejected_item (installation_id, run_id, entity, source_key, payload_json, reason)
         VALUES (@installation_id, @run_id, @entity, @source_key, @payload_json, @reason)`,
      )
      .run({
        installation_id: entry.installation_id,
        run_id: nn(entry.run_id),
        entity: nn(entry.entity),
        source_key: nn(entry.source_key),
        payload_json: entry.payload_json,
        reason: nn(entry.reason),
      });
  }

  /** Most recent rejected items for an installation, newest first (bounded). */
  listByInstallation(installationId: string, limit = 100): RejectedItemRow[] {
    const capped = Math.max(1, Math.min(limit, 500));
    return this.db
      .prepare('SELECT * FROM rejected_item WHERE installation_id = ? ORDER BY id DESC LIMIT ?')
      .all(installationId, capped) as RejectedItemRow[];
  }

  /** Retention: deletes rejected-item rows older than `days` days. Returns rows removed. */
  purgeOlderThan(days: number): number {
    return this.db
      .prepare(`DELETE FROM rejected_item WHERE created_at < datetime('now', @cutoff)`)
      .run({ cutoff: `-${days} days` }).changes;
  }

  /** Filtered, paginated dead-letter view (across installations or scoped). Payloads masked by the caller. */
  list(
    f: { installationId?: string; entity?: string; sinceDays?: number; q?: string; limit: number; offset: number },
  ): { items: RejectedItemRow[]; total: number } {
    const { where, params } = rejectedFilter(f);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM rejected_item ${clause}`).get(params) as { n: number }).n;
    const limit = Math.max(1, Math.min(f.limit, 500));
    const items = this.db
      .prepare(`SELECT * FROM rejected_item ${clause} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset: Math.max(0, f.offset) }) as RejectedItemRow[];
    return { items, total };
  }

  count(f: { installationId?: string; entity?: string; sinceDays?: number }): number {
    const { where, params } = rejectedFilter(f);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM rejected_item ${clause}`).get(params) as { n: number }).n;
  }

  /** Count grouped by entity (dashboard breakdown), optionally scoped to one installation. */
  countByEntity(installationId?: string): Array<{ entity: string | null; n: number }> {
    if (installationId) {
      return this.db
        .prepare('SELECT entity, COUNT(*) AS n FROM rejected_item WHERE installation_id = ? GROUP BY entity ORDER BY n DESC')
        .all(installationId) as Array<{ entity: string | null; n: number }>;
    }
    return this.db
      .prepare('SELECT entity, COUNT(*) AS n FROM rejected_item GROUP BY entity ORDER BY n DESC')
      .all() as Array<{ entity: string | null; n: number }>;
  }

  /** Single rejected item by id (for an audited reveal of the raw, un-masked payload). */
  findById(id: number): RejectedItemRow | undefined {
    return this.db.prepare('SELECT * FROM rejected_item WHERE id = ?').get(id) as RejectedItemRow | undefined;
  }

  /** Deletes rejected items by id, SCOPED to the installation (never cross-tenant). Caps 500 ids. */
  deleteByIds(installationId: string, ids: number[]): number {
    const clean = ids.filter((n) => Number.isInteger(n)).slice(0, 500);
    if (clean.length === 0) return 0;
    const placeholders = clean.map(() => '?').join(',');
    return this.db
      .prepare(`DELETE FROM rejected_item WHERE installation_id = ? AND id IN (${placeholders})`)
      .run(installationId, ...clean).changes;
  }
}

/** Shared WHERE builder for the rejected-item filters (installation/entity/since/reason). */
function rejectedFilter(f: {
  installationId?: string;
  entity?: string;
  sinceDays?: number;
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
  if (f.sinceDays) {
    where.push(`created_at >= datetime('now', @since)`);
    params.since = `-${f.sinceDays} days`;
  }
  if (f.q) {
    where.push(`reason LIKE @q ESCAPE '\\'`);
    params.q = `%${likeEscape(f.q)}%`;
  }
  return { where, params };
}

/** Append-only audit trail of admin actions. Metadata ONLY — no secrets, no raw PII. */
export class AuditRepo {
  constructor(private readonly db: DatabaseT.Database) {}

  add(e: { action: string; installation_id?: string | null; target?: string | null; details?: unknown; ip?: string | null }): void {
    let details: string | null = null;
    if (e.details !== undefined) {
      try {
        details = JSON.stringify(e.details);
      } catch {
        details = null;
      }
    }
    this.db
      .prepare(
        `INSERT INTO audit_log (action, installation_id, target, details_json, ip)
         VALUES (@action, @installation_id, @target, @details_json, @ip)`,
      )
      .run({
        action: e.action,
        installation_id: nn(e.installation_id),
        target: nn(e.target),
        details_json: details,
        ip: nn(e.ip),
      });
  }

  list(f: { limit: number; offset: number }): { items: AuditRow[]; total: number } {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    const limit = Math.max(1, Math.min(f.limit, 200));
    const items = this.db
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(limit, Math.max(0, f.offset)) as AuditRow[];
    return { items, total };
  }

  /** Retention: deletes audit rows older than `days` days. Returns rows removed. */
  purgeOlderThan(days: number): number {
    return this.db
      .prepare(`DELETE FROM audit_log WHERE at < datetime('now', @cutoff)`)
      .run({ cutoff: `-${days} days` }).changes;
  }
}

export interface Repositories {
  installs: InstallRepo;
  webhookLog: WebhookLogRepo;
  webhookSeen: WebhookSeenRepo;
  cursors: CursorRepo;
  runs: RunRepo;
  state: IntegrationStateRepo;
  inboundEvents: InboundEventRepo;
  rejectedItems: RejectedItemRepo;
  audit: AuditRepo;
}

export function createRepositories(db: DatabaseT.Database, cipher: SecretCipher): Repositories {
  return {
    installs: new InstallRepo(db),
    webhookLog: new WebhookLogRepo(db),
    webhookSeen: new WebhookSeenRepo(db),
    cursors: new CursorRepo(db),
    runs: new RunRepo(db),
    state: new IntegrationStateRepo(db, cipher),
    inboundEvents: new InboundEventRepo(db),
    rejectedItems: new RejectedItemRepo(db),
    audit: new AuditRepo(db),
  };
}
