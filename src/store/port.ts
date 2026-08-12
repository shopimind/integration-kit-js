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
 * THE PERSISTENCE PORT of the kit.
 *
 * An `IntegrationStore` is the storage backend behind an integration app. The kit
 * ships two official adapters — SQLite (`@shopimind/integration-kit-js/store-sqlite`,
 * the zero-config default) and PostgreSQL (`.../store-postgres`) — and this
 * interface is the extension point for custom backends.
 *
 * Design rules (what an adapter IS and IS NOT responsible for):
 *
 * - **Pure storage only.** No business logic lives behind the port: secret
 *   encryption, defensive JSON serialization, PII masking and pagination
 *   clamping are all done ABOVE it, in the kit. The `state` KV in particular
 *   only ever sees opaque blobs — an adapter cannot leak a secret it never saw
 *   in clear text.
 * - **One call = one atomic statement.** The port deliberately exposes NO
 *   transaction API. The only methods with concurrency semantics are the
 *   `claim` methods, which MUST be atomic ("insert if absent" — e.g. SQL
 *   `ON CONFLICT DO NOTHING`): two concurrent claims for the same key must
 *   resolve to exactly one `fresh: true`.
 * - **Timestamps are text.** All timestamps are stored and returned as
 *   ISO-8601 UTC strings generated in JS (see `store/time.ts`) — never by an
 *   SQL function — so ordering and cutoff comparisons behave identically on
 *   every backend.
 * - **Bounded inputs.** The kit clamps `limit`/`offset` to integers and caps id
 *   lists before calling the port; adapters may assume sane values but SHOULD not
 *   amplify them.
 *
 * Two contract points where the official adapters had to make a call, spelled out
 * so a third-party adapter matches them:
 * - `installs.setStatus` REWRITES the three lifecycle stamps on every call: an
 *   omitted stamp is stored as NULL, it is not preserved. Callers pass the ones
 *   they want to keep.
 * - `q` search is a case-insensitive LITERAL substring (`%`/`_` are not
 *   wildcards). Case folding beyond ASCII is adapter-dependent: PostgreSQL folds
 *   accents under a UTF-8 locale, SQLite (whose `LIKE` and `lower()` are
 *   ASCII-only without ICU) does not. Do not rely on it for non-ASCII input.
 *
 * Semver policy (custom adapters, read this): the port may GAIN methods or
 * optional fields in a MINOR version of the kit. Official adapters are always
 * updated in lockstep; a third-party adapter must be revalidated against the
 * conformance suite (`@shopimind/integration-kit-js/store-testing`) when
 * upgrading the kit. Removals or signature changes only happen in a MAJOR.
 */
export interface IntegrationStore {
  installs: InstallStore;
  state: StateKvStore;
  cursors: CursorStore;
  runs: RunStore;
  inboundEvents: InboundEventStore;
  webhookSeen: WebhookSeenStore;
  webhookLog: WebhookLogStore;
  rejectedItems: RejectedItemStore;
  audit: AuditStore;

  /**
   * Creates/upgrades the schema (versioned, append-only, idempotent). Called by
   * `createIntegrationApp` before the app is returned; safe to call repeatedly.
   *
   * `owner` is the slug of the integration about to use this store. An adapter
   * whose storage can be SHARED (a PostgreSQL database, where two integrations
   * could point at the same schema) SHOULD record it on first migration and
   * REFUSE to start when a different owner is presented — silently merging two
   * integrations' installations and cursors is far worse than failing to boot.
   * Adapters backed by a private file (SQLite) can ignore it. Optional so the
   * conformance suite and tooling can call `migrate()` with no argument.
   */
  migrate(owner?: string): Promise<void>;
  /** Cheap liveness check (`SELECT 1`-grade). Rejects when the backend is unreachable. */
  ping(): Promise<void>;
  /** Releases connections/handles. The app calls it on `stop()`. */
  close(): Promise<void>;
}

/** Installs (one row per installation). Upsert semantics: a null/omitted field never overwrites. */
export interface InstallStore {
  upsert(u: InstallUpsert): Promise<void>;
  setStatus(
    installationId: string,
    status: string,
    stamps?: { activated_at?: string | null; deactivated_at?: string | null; uninstalled_at?: string | null },
  ): Promise<void>;
  /** Sets the INTEGRATOR account associated with the installation (the correlation bridge). */
  setExternalAccount(installationId: string, ref: string | null, name?: string | null): Promise<void>;
  find(installationId: string): Promise<InstallRow | undefined>;
  listActive(): Promise<InstallRow[]>;
  /** Paginated list. `q` = case-insensitive substring across id/domain/name (literal match). */
  list(f: { status?: string; q?: string; limit: number; offset: number }): Promise<{ items: InstallRow[]; total: number }>;
  countByStatus(): Promise<Record<string, number>>;
}

/** A raw state entry as persisted. `value` is an opaque blob (possibly ciphertext). */
export interface StateEntry {
  value: string | null;
  encrypted: boolean;
}

/** Metadata of a state key. `value_preview` MUST be null whenever `encrypted` is true. */
export interface StateMetaRow {
  key: string;
  encrypted: boolean;
  updated_at: string;
  value_length: number;
  value_preview: string | null;
}

/**
 * Private integration state — a RAW key/value per installation. Encryption
 * happens ABOVE the port (the kit's state facade): an adapter only ever stores
 * and returns opaque strings plus the `encrypted` flag.
 */
export interface StateKvStore {
  write(installationId: string, key: string, value: string, encrypted: boolean): Promise<void>;
  read(installationId: string, key: string): Promise<StateEntry | undefined>;
  delete(installationId: string, key: string): Promise<void>;
  /**
   * Metadata for every key of an installation — WITHOUT ever materializing the
   * value of an encrypted entry (`value_preview` null, at most 200 chars otherwise).
   */
  listMeta(installationId: string): Promise<StateMetaRow[]>;
}

/** Sync cursors, scoped by (installation, entity, source_key). */
export interface CursorStore {
  get(installationId: string, entity: string, sourceKey: string): Promise<CursorRow | undefined>;
  set(installationId: string, entity: string, sourceKey: string, w: CursorWrite): Promise<void>;
  listByInstallation(installationId: string): Promise<CursorRow[]>;
  countInError(): Promise<number>;
}

/** History of sync runs. */
export interface RunStore {
  /** Inserts a `running` row and returns its id. */
  start(installationId: string): Promise<number>;
  /** `summaryJson` is already serialized by the kit (defensively). */
  finish(runId: number, status: 'ok' | 'partial' | 'failed', summaryJson: string): Promise<void>;
  recent(installationId: string, limit: number): Promise<SyncRunRow[]>;
  list(installationId: string, f: { limit: number; offset: number }): Promise<{ items: SyncRunRow[]; total: number }>;
  /** Deletes runs started before `cutoffIso`. Returns rows removed. */
  purgeStartedBefore(cutoffIso: string): Promise<number>;
}

/** Log of inbound calls (middleware idempotency + audit). */
export interface InboundEventStore {
  find(installationId: string, idempotencyKey: string): Promise<InboundEventRow | undefined>;
  /**
   * ATOMICALLY claims the processing of an inbound call (anti-TOCTOU):
   * - `fresh: true`  => the row was created by THIS call — it owns the processing;
   * - `fresh: false` => a row already existed — `status` tells where it stands
   *   ('received' = claimed/in progress, 'done' = processed, 'failed' = retryable).
   */
  claim(
    installationId: string,
    idempotencyKey: string,
    action: string | null,
  ): Promise<{ rowId: number; fresh: boolean; status: InboundEventRow['status'] }>;
  finish(id: number, status: 'done' | 'failed', error: string | null): Promise<void>;
  /** Deletes rows received before `cutoffIso`. Returns rows removed. */
  purgeReceivedBefore(cutoffIso: string): Promise<number>;
  listByInstallation(
    installationId: string,
    f: { limit: number; offset: number },
  ): Promise<{ items: InboundEventRow[]; total: number }>;
}

/** Replay protection for lifecycle webhooks (key derived from the signature). */
export interface WebhookSeenStore {
  /** Atomically claims processing; `false` if the key was already seen (replay). */
  claim(installationId: string, dedupKey: string): Promise<boolean>;
  /** Releases a claim (failed processing) -> an identical resend can retry. */
  release(installationId: string, dedupKey: string): Promise<void>;
  /** Deletes dedup rows created before `cutoffIso`. Returns rows removed. */
  purgeCreatedBefore(cutoffIso: string): Promise<number>;
  /** Count of retained signatures for an installation created at/after `sinceIso`. */
  countByInstallationSince(installationId: string, sinceIso: string): Promise<number>;
}

/** Webhook log. `payload_json` is already redacted by the kit at write time. */
export interface WebhookLogStore {
  log(entry: {
    event: string | null;
    installation_id: string | null;
    signature_ok: boolean;
    payload_json: string;
  }): Promise<void>;
  /** Deletes log rows created before `cutoffIso`. Returns rows removed. */
  purgeCreatedBefore(cutoffIso: string): Promise<number>;
  /** Most recent entries (newest first). */
  recent(limit: number): Promise<Array<{ event: string | null; installation_id: string | null; signature_ok: number; created_at: string }>>;
  listByInstallation(
    installationId: string,
    f: { event?: string; signatureOk?: boolean; limit: number; offset: number },
  ): Promise<{ items: WebhookLogRow[]; total: number }>;
  /** Webhooks received at/after `sinceIso`: total + how many failed the signature. */
  countSince(sinceIso: string): Promise<{ total: number; refused: number }>;
  lastForInstallation(installationId: string): Promise<{ event: string | null; created_at: string } | undefined>;
  findById(id: number): Promise<WebhookLogRow | undefined>;
}

/** Dead-letter of per-item rejections from bulk pushes. */
export interface RejectedItemStore {
  add(entry: {
    installation_id: string;
    run_id: number | null;
    entity: string | null;
    source_key: string | null;
    payload_json: string;
    reason: string | null;
  }): Promise<void>;
  /** Most recent rejected items for an installation, newest first (bounded by `limit`). */
  listByInstallation(installationId: string, limit: number): Promise<RejectedItemRow[]>;
  /** Deletes rows created before `cutoffIso`. Returns rows removed. */
  purgeCreatedBefore(cutoffIso: string): Promise<number>;
  list(f: {
    installationId?: string;
    entity?: string;
    /** Only rows created at/after this instant. */
    sinceIso?: string;
    /** Case-insensitive substring match on `reason` (literal). */
    q?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: RejectedItemRow[]; total: number }>;
  count(f: { installationId?: string; entity?: string; sinceIso?: string }): Promise<number>;
  countByEntity(installationId?: string): Promise<Array<{ entity: string | null; n: number }>>;
  findById(id: number): Promise<RejectedItemRow | undefined>;
  /** Deletes by id, SCOPED to the installation (never cross-tenant). Ids are pre-capped by the kit. */
  deleteByIds(installationId: string, ids: number[]): Promise<number>;
}

/** Append-only audit trail of admin actions. Metadata only — the kit never passes secrets or raw PII. */
export interface AuditStore {
  add(e: {
    action: string;
    installation_id: string | null;
    target: string | null;
    /** Already serialized (defensively) by the kit; null when unserializable/absent. */
    details_json: string | null;
    ip: string | null;
  }): Promise<void>;
  list(f: { limit: number; offset: number }): Promise<{ items: AuditRow[]; total: number }>;
  /** Deletes audit rows recorded before `cutoffIso`. Returns rows removed. */
  purgeRecordedBefore(cutoffIso: string): Promise<number>;
}
