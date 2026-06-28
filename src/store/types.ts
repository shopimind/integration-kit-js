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
  updated_at: string;
}

export interface CursorWrite {
  last_synced_at: string;
  last_status?: string;
  last_error?: string | null;
  items?: number;
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
