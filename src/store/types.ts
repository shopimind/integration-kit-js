export type InstallStatus = 'inactive' | 'active' | 'uninstalled';

/**
 * An installation. `installation_id` = OPAQUE token issued by ShopiMind.
 * `external_account_ref`/`_name` = the reference of the INTEGRATOR's internal
 * account (the correlation bridge, set by the integration).
 */
export interface InstallRow {
  installation_id: string;
  shop_domain: string | null;
  shop_name: string | null;
  external_account_ref: string | null;
  external_account_name: string | null;
  status: string;
  installed_at: string | null;
  activated_at: string | null;
  deactivated_at: string | null;
  uninstalled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InstallUpsert {
  installation_id: string;
  shop_domain?: string | null;
  shop_name?: string | null;
  status: InstallStatus;
  installed_at?: string | null;
}

export interface CursorRow {
  installation_id: string;
  entity: string;
  source_key: string;
  last_synced_at: string | null;
  last_status: string | null;
  last_error: string | null;
  items: number;
  /** Consecutive failed/held runs for this cursor (E3). Reset to 0 on a clean advance. */
  consecutive_failures: number;
  updated_at: string;
}

export interface CursorWrite {
  /**
   * Upper bound the cursor advanced to (ISO 8601), or `null` when the cursor is
   * NOT advancing (a failure row that preserves the previous value, possibly
   * never-synced). Nullable by design — do not cast a null away.
   */
  last_synced_at: string | null;
  last_status?: string;
  last_error?: string | null;
  items?: number;
  /**
   * Absolute value to persist in `consecutive_failures` (E3). The engine sets 0 on
   * a clean advance and the incremented count on a failure/hold. Omitted -> left
   * unchanged (COALESCE), so callers that do not track it keep the old value.
   */
  consecutive_failures?: number;
}

export interface SyncRunRow {
  id: number;
  installation_id: string;
  status: string;
  summary_json: string | null;
  started_at: string;
  finished_at: string | null;
}

/** A row of the inbound call log (inbound routes / middleware). */
export interface InboundEventRow {
  id: number;
  installation_id: string;
  idempotency_key: string;
  action: string | null;
  status: string;
  error: string | null;
  received_at: string;
  processed_at: string | null;
}

/** A dead-lettered item the ShopiMind API REJECTED during a bulk push (E4). */
export interface RejectedItemRow {
  id: number;
  installation_id: string;
  run_id: number | null;
  entity: string | null;
  source_key: string | null;
  payload_json: string | null;
  reason: string | null;
  created_at: string;
}

/** A row of the lifecycle webhook log. `payload_json` is already redacted at write time. */
export interface WebhookLogRow {
  id: number;
  event: string | null;
  installation_id: string | null;
  signature_ok: number;
  payload_json: string | null;
  created_at: string;
}

/** A row of the admin audit trail. Metadata only: no secrets, no raw PII. */
export interface AuditRow {
  id: number;
  at: string;
  action: string;
  installation_id: string | null;
  target: string | null;
  details_json: string | null;
  ip: string | null;
}
