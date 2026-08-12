import type { Repositories } from '../store/repositories.js';

/**
 * Write-side provider for the admin operations UI. Mirrors `admin-data` (reads) for
 * the handful of state-changing actions the UI exposes: purging dead-lettered
 * items, revealing a raw (un-masked) payload, reprovisioning, and recording the
 * audit trail. Every reveal / purge / reprovision is expected to be audited by the
 * caller — the routes do exactly that.
 *
 * Scoping is enforced here, not in the HTTP layer: `revealWebhook` refuses a log id
 * that does not belong to the named installation, and `purgeRejected` delegates to
 * the repo's installation-scoped delete.
 */

export interface AuditEntry {
  action: string;
  installationId?: string | null;
  target?: string | null;
  details?: unknown;
  ip?: string | null;
}

export interface ReprovisionOutcome {
  sources: number;
  defs: number;
  events: number;
  orderStatuses: number;
  errors: string[];
}

export interface AdminActions {
  /** Deletes rejected items by id, scoped to the installation. Returns rows removed. */
  purgeRejected(installationId: string, ids: number[]): Promise<number>;
  /** The raw rejected-item row for an audited reveal, or null if unknown. */
  revealRejected(id: number): Promise<{ installation_id: string; payload_json: string | null } | null>;
  /** The stored webhook payload, scoped to the installation, or null if unknown/mismatched. */
  revealWebhook(installationId: string, logId: number): Promise<{ payload_json: string | null } | null>;
  /** Re-runs the integration's provisioning for an installation (idempotent). */
  reprovision(id: string): Promise<ReprovisionOutcome>;
  /** Appends an entry to the audit trail (metadata only — no secrets, no raw PII). */
  audit(entry: AuditEntry): Promise<void>;
}

export function buildAdminActions(
  repos: Repositories,
  deps: { reprovision: (id: string) => Promise<ReprovisionOutcome> },
): AdminActions {
  return {
    purgeRejected(installationId, ids) {
      return repos.rejectedItems.deleteByIds(installationId, ids);
    },
    async revealRejected(id) {
      const row = await repos.rejectedItems.findById(id);
      return row ? { installation_id: row.installation_id, payload_json: row.payload_json } : null;
    },
    async revealWebhook(installationId, logId) {
      const row = await repos.webhookLog.findById(logId);
      if (!row || row.installation_id !== installationId) return null; // scope guard
      return { payload_json: row.payload_json };
    },
    reprovision(id) {
      return deps.reprovision(id);
    },
    audit(entry) {
      return repos.audit.add({
        action: entry.action,
        installation_id: entry.installationId ?? null,
        target: entry.target ?? null,
        details: entry.details,
        ip: entry.ip ?? null,
      });
    },
  };
}
