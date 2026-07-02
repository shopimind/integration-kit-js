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
} from './types.js';

const nn = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

/** GCM AAD binding an encrypted secret to its exact location (anti-relocation). */
const aadFor = (installationId: string, key: string): string => `${installationId}:${key}`;

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
    return this.db
      .prepare('SELECT * FROM sync_run WHERE installation_id = ? ORDER BY id DESC LIMIT ?')
      .all(installationId, limit) as SyncRunRow[];
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
  };
}
