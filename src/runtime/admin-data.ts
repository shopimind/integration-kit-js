import type { Repositories } from '../store/repositories.js';
import type { IntegrationDescriptor } from '../integration/describe.js';
import { maskPiiJson } from '../security/pii-mask.js';
import type {
  InstallRow,
  SyncRunRow,
  WebhookLogRow,
  RejectedItemRow,
  InboundEventRow,
  AuditRow,
  CursorRow,
} from '../store/types.js';

/**
 * Read-side provider for the admin API / operations UI. It turns the raw
 * repositories into the exact DTOs the admin endpoints return, and is the single
 * place where the two display invariants are enforced:
 *
 *   1. PII in webhook / rejected payloads is MASKED before it leaves the store
 *      (`maskPiiJson`); the un-masked payload is only ever exposed by the separate,
 *      audited "reveal" action.
 *   2. Encrypted secrets are never materialized: state is read via `listMeta`,
 *      which the SQL layer guarantees never returns an encrypted `value`.
 *
 * Keeping this logic out of the HTTP layer makes both invariants unit-testable
 * without spinning up a server.
 */

export interface Page<T> {
  items: T[];
  total: number;
}

export type StateMeta = Awaited<ReturnType<Repositories['state']['listMeta']>>;

export interface AdminMeta {
  kitVersion: string;
  generatedAt: string;
  integration: { name: string; slug: string; version: string };
  installations: { total: number; byStatus: Record<string, number> };
  webhooks24h: { total: number; refused: number };
  rejected: { total: number; byEntity: Array<{ entity: string | null; n: number }> };
}

export interface InstallationDetail {
  install: InstallRow;
  cursors: CursorRow[];
  recentRuns: SyncRunRow[];
  lastWebhook: { event: string | null; created_at: string } | null;
  state: StateMeta;
  rejectedCount: number;
  seenSignatures7d: number;
}

export interface InstallationFilter {
  status?: string;
  q?: string;
  limit: number;
  offset: number;
}
export interface PageFilter {
  limit: number;
  offset: number;
}
export interface WebhookFilter extends PageFilter {
  event?: string;
  signatureOk?: boolean;
}
export interface RejectedFilter extends PageFilter {
  installationId?: string;
  entity?: string;
  sinceDays?: number;
  q?: string;
}

export interface AdminData {
  meta(): Promise<AdminMeta>;
  listInstallations(f: InstallationFilter): Promise<Page<InstallRow>>;
  installation(id: string): Promise<InstallationDetail | null>;
  cursors(id: string): Promise<CursorRow[]>;
  runs(id: string, f: PageFilter): Promise<Page<SyncRunRow>>;
  webhooks(id: string, f: WebhookFilter): Promise<Page<WebhookLogRow>>;
  inbound(id: string, f: PageFilter): Promise<Page<InboundEventRow>>;
  state(id: string): Promise<StateMeta>;
  rejected(f: RejectedFilter): Promise<Page<RejectedItemRow>>;
  audit(f: PageFilter): Promise<Page<AuditRow>>;
  definition(): IntegrationDescriptor;
}

export function buildAdminData(
  repos: Repositories,
  env: { kitVersion: string; now: () => number; integration: IntegrationDescriptor },
): AdminData {
  const maskWebhooks = (p: Page<WebhookLogRow>): Page<WebhookLogRow> => ({
    total: p.total,
    items: p.items.map((w) => ({ ...w, payload_json: maskPiiJson(w.payload_json) })),
  });
  const maskRejected = (p: Page<RejectedItemRow>): Page<RejectedItemRow> => ({
    total: p.total,
    items: p.items.map((it) => ({ ...it, payload_json: maskPiiJson(it.payload_json) })),
  });

  return {
    async meta() {
      const byStatus = await repos.installs.countByStatus();
      const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
      return {
        kitVersion: env.kitVersion,
        generatedAt: new Date(env.now()).toISOString(),
        integration: { name: env.integration.meta.name, slug: env.integration.slug, version: env.integration.meta.version },
        installations: { total, byStatus },
        webhooks24h: await repos.webhookLog.countSince(24),
        rejected: { total: await repos.rejectedItems.count({}), byEntity: await repos.rejectedItems.countByEntity() },
      };
    },
    listInstallations(f) {
      return repos.installs.list(f);
    },
    async installation(id) {
      const install = await repos.installs.find(id);
      if (!install) return null;
      return {
        install,
        cursors: await repos.cursors.listByInstallation(id),
        recentRuns: await repos.runs.recent(id, 5),
        lastWebhook: (await repos.webhookLog.lastForInstallation(id)) ?? null,
        state: await repos.state.listMeta(id),
        rejectedCount: await repos.rejectedItems.count({ installationId: id }),
        seenSignatures7d: await repos.webhookSeen.countByInstallationSince(id, 7),
      };
    },
    cursors(id) {
      return repos.cursors.listByInstallation(id);
    },
    runs(id, f) {
      return repos.runs.list(id, f);
    },
    async webhooks(id, f) {
      return maskWebhooks(await repos.webhookLog.listByInstallation(id, f));
    },
    inbound(id, f) {
      return repos.inboundEvents.listByInstallation(id, f);
    },
    state(id) {
      return repos.state.listMeta(id);
    },
    async rejected(f) {
      return maskRejected(await repos.rejectedItems.list(f));
    },
    audit(f) {
      return repos.audit.list(f);
    },
    definition() {
      return env.integration;
    },
  };
}
