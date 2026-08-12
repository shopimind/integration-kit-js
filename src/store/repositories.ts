import type { SecretCipher } from '../security/crypto.js';
import type { IntegrationStore } from './port.js';
import { isoDaysAgo, isoHoursAgo, realClock, type StoreClock } from './time.js';
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

/**
 * KIT-SIDE FACADES over the persistence port (`IntegrationStore`).
 *
 * Everything that is kit LOGIC — and must therefore behave identically on every
 * backend — lives here, ABOVE the port: secret encryption (AES-256-GCM with a
 * location-binding AAD), defensive JSON serialization, pagination clamping,
 * relative-window → absolute-cutoff conversion. Adapters only ever do storage.
 *
 * The facade classes keep the v1 repository names and shapes; every method is
 * now async (the port is Promise-based so network backends can implement it).
 */

/** GCM AAD binding an encrypted secret to its exact location (anti-relocation). */
const aadFor = (installationId: string, key: string): string => `${installationId}:${key}`;

/**
 * Pagination bounds. These must yield INTEGERS: they are bound to `LIMIT`/`OFFSET`
 * parameters, and a fractional/NaN value is silently tolerated by SQLite but
 * rejected by PostgreSQL (`invalid input syntax for type bigint`). Clamping here —
 * above the port — keeps both adapters behaving the same on hostile input.
 */
/** Upper bound of a 32-bit signed column — the id type used by both official adapters. */
const INT4_MAX = 2_147_483_647;
const toInt = (v: number, fallback: number): number => (Number.isFinite(v) ? Math.floor(v) : fallback);
const clampLimit = (limit: number, max: number): number => Math.max(1, Math.min(toInt(limit, 1), max));
const clampOffset = (offset: number): number => Math.max(0, Math.min(toInt(offset, 0), Number.MAX_SAFE_INTEGER));

/** Installs (one row per installation). COALESCE upsert: a null field does not overwrite. */
export class InstallRepo {
  constructor(private readonly store: IntegrationStore) {}

  upsert(u: InstallUpsert): Promise<void> {
    return this.store.installs.upsert(u);
  }

  setStatus(
    installationId: string,
    status: InstallRow['status'],
    stamps: { activated_at?: string | null; deactivated_at?: string | null; uninstalled_at?: string | null } = {},
  ): Promise<void> {
    return this.store.installs.setStatus(installationId, status, stamps);
  }

  /** Sets the INTEGRATOR account associated with the installation (the correlation bridge). */
  setExternalAccount(installationId: string, ref: string | null, name: string | null = null): Promise<void> {
    return this.store.installs.setExternalAccount(installationId, ref, name);
  }

  find(installationId: string): Promise<InstallRow | undefined> {
    return this.store.installs.find(installationId);
  }

  listActive(): Promise<InstallRow[]> {
    return this.store.installs.listActive();
  }

  /** Paginated list for the admin UI. `q` = case-insensitive substring across id/domain/name. */
  list(f: { status?: string; q?: string; limit: number; offset: number }): Promise<{ items: InstallRow[]; total: number }> {
    return this.store.installs.list({
      ...(f.status !== undefined ? { status: f.status } : {}),
      ...(f.q !== undefined ? { q: f.q } : {}),
      limit: clampLimit(f.limit, 200),
      offset: clampOffset(f.offset),
    });
  }

  /** Count per status (dashboard). */
  countByStatus(): Promise<Record<string, number>> {
    return this.store.installs.countByStatus();
  }
}

/** Webhook log. The `payload_json` MUST already be redacted by the runtime. */
export class WebhookLogRepo {
  constructor(
    private readonly store: IntegrationStore,
    private readonly clock: StoreClock,
  ) {}

  log(entry: {
    event: string | null;
    installation_id?: string | null;
    signature_ok: boolean;
    payload_json: string;
  }): Promise<void> {
    return this.store.webhookLog.log({
      event: entry.event,
      installation_id: entry.installation_id ?? null,
      signature_ok: entry.signature_ok,
      payload_json: entry.payload_json,
    });
  }

  /** Retention: deletes log rows older than `days` days. Returns the number of rows removed. */
  purgeOlderThan(days: number): Promise<number> {
    return this.store.webhookLog.purgeCreatedBefore(isoDaysAgo(days, this.clock));
  }

  /** Most recent webhook log entries (newest first) — for /admin/overview. */
  recent(limit = 20): Promise<Array<{ event: string | null; installation_id: string | null; signature_ok: number; created_at: string }>> {
    return this.store.webhookLog.recent(clampLimit(limit, 200));
  }

  /** Paginated webhook log for one installation (newest first). Payloads masked by the caller. */
  listByInstallation(
    id: string,
    f: { event?: string; signatureOk?: boolean; limit: number; offset: number },
  ): Promise<{ items: WebhookLogRow[]; total: number }> {
    return this.store.webhookLog.listByInstallation(id, {
      ...(f.event !== undefined ? { event: f.event } : {}),
      ...(f.signatureOk !== undefined ? { signatureOk: f.signatureOk } : {}),
      limit: clampLimit(f.limit, 200),
      offset: clampOffset(f.offset),
    });
  }

  /** Dashboard counter: webhooks received in the last `hours`, and how many were refused. */
  countSince(hours: number): Promise<{ total: number; refused: number }> {
    return this.store.webhookLog.countSince(isoHoursAgo(hours, this.clock));
  }

  /** Last webhook event seen for an installation (lifecycle timeline). */
  lastForInstallation(id: string): Promise<{ event: string | null; created_at: string } | undefined> {
    return this.store.webhookLog.lastForInstallation(id);
  }

  /** Single webhook log row by id (installation scoping is enforced by the caller). */
  findById(id: number): Promise<WebhookLogRow | undefined> {
    if (!Number.isInteger(id) || Math.abs(id) > INT4_MAX) return Promise.resolve(undefined);
    return this.store.webhookLog.findById(id);
  }
}

/** Replay protection for lifecycle webhooks (key derived from the signature). */
export class WebhookSeenRepo {
  constructor(
    private readonly store: IntegrationStore,
    private readonly clock: StoreClock,
  ) {}

  /** Atomically claims processing; `false` if the signature was already seen (replay). */
  claim(installationId: string, dedupKey: string): Promise<boolean> {
    return this.store.webhookSeen.claim(installationId, dedupKey);
  }

  /** Releases a claim (failed processing) -> an identical resend can retry. */
  release(installationId: string, dedupKey: string): Promise<void> {
    return this.store.webhookSeen.release(installationId, dedupKey);
  }

  /** Retention: deletes dedup rows older than `days` days. Returns the number of rows removed. */
  purgeOlderThan(days: number): Promise<number> {
    return this.store.webhookSeen.purgeCreatedBefore(isoDaysAgo(days, this.clock));
  }

  /** Count of retained signatures for an installation over the last `days` (idempotence view). */
  countByInstallationSince(id: string, days: number): Promise<number> {
    return this.store.webhookSeen.countByInstallationSince(id, isoDaysAgo(days, this.clock));
  }
}

/** Sync cursors, scoped by (installation, entity, source_key). */
export class CursorRepo {
  constructor(private readonly store: IntegrationStore) {}

  get(installationId: string, entity: string, sourceKey = ''): Promise<CursorRow | undefined> {
    return this.store.cursors.get(installationId, entity, sourceKey);
  }

  set(installationId: string, entity: string, sourceKey: string, w: CursorWrite): Promise<void> {
    return this.store.cursors.set(installationId, entity, sourceKey, w);
  }

  /** All cursors for an installation (for /health, /admin/overview). */
  listByInstallation(installationId: string): Promise<CursorRow[]> {
    return this.store.cursors.listByInstallation(installationId);
  }

  /** Number of cursors currently in the `error` status (health signal). */
  countInError(): Promise<number> {
    return this.store.cursors.countInError();
  }
}

/** History of sync runs. */
export class RunRepo {
  constructor(
    private readonly store: IntegrationStore,
    private readonly clock: StoreClock,
  ) {}

  start(installationId: string): Promise<number> {
    return this.store.runs.start(installationId);
  }

  finish(runId: number, status: 'ok' | 'partial' | 'failed', summary: unknown): Promise<void> {
    // Never let a non-serializable summary (circular reference, BigInt, …) throw and
    // leave the run stuck in 'running': fall back to a safe placeholder instead.
    let summaryJson: string;
    try {
      summaryJson = JSON.stringify(summary);
    } catch {
      summaryJson = '{"error":"unserializable summary"}';
    }
    return this.store.runs.finish(runId, status, summaryJson);
  }

  recent(installationId: string, limit = 10): Promise<SyncRunRow[]> {
    return this.store.runs.recent(installationId, clampLimit(limit, 200));
  }

  /** Paginated runs for an installation (newest first) + total. */
  list(id: string, f: { limit: number; offset: number }): Promise<{ items: SyncRunRow[]; total: number }> {
    return this.store.runs.list(id, { limit: clampLimit(f.limit, 200), offset: clampOffset(f.offset) });
  }

  /** Retention: deletes run rows older than `days` days. Returns rows removed. */
  purgeOlderThan(days: number): Promise<number> {
    return this.store.runs.purgeStartedBefore(isoDaysAgo(days, this.clock));
  }
}

/**
 * Private integration state (KV per installation). Sensitive values are encrypted
 * at rest via the kit's `SecretCipher` — encryption happens HERE, above the port:
 * a storage adapter only ever sees opaque blobs.
 */
export class IntegrationStateRepo {
  constructor(
    private readonly store: IntegrationStore,
    private readonly cipher: SecretCipher,
  ) {}

  set(installationId: string, key: string, value: string): Promise<void> {
    return this.store.state.write(installationId, key, value, false);
  }

  setSecret(installationId: string, key: string, value: string): Promise<void> {
    return this.store.state.write(installationId, key, this.cipher.encrypt(value, aadFor(installationId, key)), true);
  }

  async get(installationId: string, key: string): Promise<string | null> {
    const entry = await this.store.state.read(installationId, key);
    if (!entry || entry.value === null) return null;
    return entry.encrypted ? this.cipher.decrypt(entry.value, aadFor(installationId, key)) : entry.value;
  }

  delete(installationId: string, key: string): Promise<void> {
    return this.store.state.delete(installationId, key);
  }

  /**
   * Metadata for every state key of an installation — WITHOUT ever reading the
   * value of an encrypted row (`value_preview` is null whenever `encrypted = 1`).
   */
  async listMeta(
    installationId: string,
  ): Promise<Array<{ key: string; encrypted: 0 | 1; updated_at: string; value_length: number; value_preview: string | null }>> {
    const rows = await this.store.state.listMeta(installationId);
    return rows.map((r) => ({
      key: r.key,
      encrypted: r.encrypted ? (1 as const) : (0 as const),
      updated_at: r.updated_at,
      value_length: r.value_length,
      // Belt-and-braces: enforce the port contract even against a misbehaving adapter.
      value_preview: r.encrypted ? null : r.value_preview,
    }));
  }
}

/** Log of inbound calls (middleware idempotency + audit). */
export class InboundEventRepo {
  constructor(
    private readonly store: IntegrationStore,
    private readonly clock: StoreClock,
  ) {}

  find(installationId: string, idempotencyKey: string): Promise<InboundEventRow | undefined> {
    return this.store.inboundEvents.find(installationId, idempotencyKey);
  }

  /**
   * ATOMICALLY claims the processing of an inbound call (anti-TOCTOU):
   * - `fresh: true` => row created by THIS call -> it is responsible for processing;
   * - `fresh: false` => a row already existed -> `status` tells where it stands
   *   ('received' = in progress/already claimed, 'done' = processed, 'failed' = retryable).
   */
  claim(
    installationId: string,
    idempotencyKey: string,
    action: string | null,
  ): Promise<{ rowId: number; fresh: boolean; status: InboundEventRow['status'] }> {
    return this.store.inboundEvents.claim(installationId, idempotencyKey, action);
  }

  finish(id: number, status: 'done' | 'failed', error: string | null = null): Promise<void> {
    return this.store.inboundEvents.finish(id, status, error);
  }

  /** Retention: deletes inbound rows older than `days` days. Returns the number of rows removed. */
  purgeOlderThan(days: number): Promise<number> {
    return this.store.inboundEvents.purgeReceivedBefore(isoDaysAgo(days, this.clock));
  }

  /** Paginated inbound events for an installation (newest first) + total. */
  listByInstallation(id: string, f: { limit: number; offset: number }): Promise<{ items: InboundEventRow[]; total: number }> {
    return this.store.inboundEvents.listByInstallation(id, {
      limit: clampLimit(f.limit, 200),
      offset: clampOffset(f.offset),
    });
  }
}

/**
 * Dead-letter of per-item REJECTIONS. The engine records here what the
 * ShopiMind API refused during a bulk push (validation), capped per run so a
 * poison batch cannot flood the store; an operator inspects/replays via the admin
 * endpoint. Subject to the same retention purge as the other log tables.
 */
export class RejectedItemRepo {
  constructor(
    private readonly store: IntegrationStore,
    private readonly clock: StoreClock,
  ) {}

  add(entry: {
    installation_id: string;
    run_id?: number | null;
    entity?: string | null;
    source_key?: string | null;
    payload_json: string;
    reason?: string | null;
  }): Promise<void> {
    return this.store.rejectedItems.add({
      installation_id: entry.installation_id,
      run_id: entry.run_id ?? null,
      entity: entry.entity ?? null,
      source_key: entry.source_key ?? null,
      payload_json: entry.payload_json,
      reason: entry.reason ?? null,
    });
  }

  /** Most recent rejected items for an installation, newest first (bounded). */
  listByInstallation(installationId: string, limit = 100): Promise<RejectedItemRow[]> {
    return this.store.rejectedItems.listByInstallation(installationId, clampLimit(limit, 500));
  }

  /** Retention: deletes rejected-item rows older than `days` days. Returns rows removed. */
  purgeOlderThan(days: number): Promise<number> {
    return this.store.rejectedItems.purgeCreatedBefore(isoDaysAgo(days, this.clock));
  }

  /** Filtered, paginated dead-letter view (across installations or scoped). Payloads masked by the caller. */
  list(
    f: { installationId?: string; entity?: string; sinceDays?: number; q?: string; limit: number; offset: number },
  ): Promise<{ items: RejectedItemRow[]; total: number }> {
    return this.store.rejectedItems.list({
      ...(f.installationId !== undefined ? { installationId: f.installationId } : {}),
      ...(f.entity !== undefined ? { entity: f.entity } : {}),
      ...(f.sinceDays ? { sinceIso: isoDaysAgo(f.sinceDays, this.clock) } : {}),
      ...(f.q !== undefined ? { q: f.q } : {}),
      limit: clampLimit(f.limit, 500),
      offset: clampOffset(f.offset),
    });
  }

  count(f: { installationId?: string; entity?: string; sinceDays?: number }): Promise<number> {
    return this.store.rejectedItems.count({
      ...(f.installationId !== undefined ? { installationId: f.installationId } : {}),
      ...(f.entity !== undefined ? { entity: f.entity } : {}),
      ...(f.sinceDays ? { sinceIso: isoDaysAgo(f.sinceDays, this.clock) } : {}),
    });
  }

  /** Count grouped by entity (dashboard breakdown), optionally scoped to one installation. */
  countByEntity(installationId?: string): Promise<Array<{ entity: string | null; n: number }>> {
    return this.store.rejectedItems.countByEntity(installationId);
  }

  /** Single rejected item by id (for an audited reveal of the raw, un-masked payload). */
  findById(id: number): Promise<RejectedItemRow | undefined> {
    if (!Number.isInteger(id) || Math.abs(id) > INT4_MAX) return Promise.resolve(undefined);
    return this.store.rejectedItems.findById(id);
  }

  /** Deletes rejected items by id, SCOPED to the installation (never cross-tenant). Caps 500 ids. */
  deleteByIds(installationId: string, ids: number[]): Promise<number> {
    // `Number.isInteger` also accepts values beyond a 32-bit column (1e300 is an
    // "integer"): bound them so an out-of-range id is a no-op everywhere instead of
    // an adapter-specific error.
    const clean = ids.filter((n) => Number.isInteger(n) && Math.abs(n) <= INT4_MAX).slice(0, 500);
    if (clean.length === 0) return Promise.resolve(0);
    return this.store.rejectedItems.deleteByIds(installationId, clean);
  }
}

/** Append-only audit trail of admin actions. Metadata ONLY — no secrets, no raw PII. */
export class AuditRepo {
  constructor(
    private readonly store: IntegrationStore,
    private readonly clock: StoreClock,
  ) {}

  add(e: { action: string; installation_id?: string | null; target?: string | null; details?: unknown; ip?: string | null }): Promise<void> {
    let details: string | null = null;
    if (e.details !== undefined) {
      try {
        details = JSON.stringify(e.details);
      } catch {
        details = null;
      }
    }
    return this.store.audit.add({
      action: e.action,
      installation_id: e.installation_id ?? null,
      target: e.target ?? null,
      details_json: details,
      ip: e.ip ?? null,
    });
  }

  list(f: { limit: number; offset: number }): Promise<{ items: AuditRow[]; total: number }> {
    return this.store.audit.list({ limit: clampLimit(f.limit, 200), offset: clampOffset(f.offset) });
  }

  /** Retention: deletes audit rows older than `days` days. Returns rows removed. */
  purgeOlderThan(days: number): Promise<number> {
    return this.store.audit.purgeRecordedBefore(isoDaysAgo(days, this.clock));
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

export function createRepositories(store: IntegrationStore, cipher: SecretCipher, clock: StoreClock = realClock): Repositories {
  return {
    installs: new InstallRepo(store),
    webhookLog: new WebhookLogRepo(store, clock),
    webhookSeen: new WebhookSeenRepo(store, clock),
    cursors: new CursorRepo(store),
    runs: new RunRepo(store, clock),
    state: new IntegrationStateRepo(store, cipher),
    inboundEvents: new InboundEventRepo(store, clock),
    rejectedItems: new RejectedItemRepo(store, clock),
    audit: new AuditRepo(store, clock),
  };
}
