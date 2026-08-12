import type { IntegrationStore } from '../store/port.js';
import type { Repositories } from '../store/repositories.js';
import { parseStoreTimestamp } from '../store/time.js';

/**
 * Health & overview reports.
 *
 * `/health` is an UNAUTHENTICATED probe endpoint: it must stay coarse (no secrets,
 * no PII beyond opaque installation ids) and cheap. It answers three questions an
 * orchestrator / on-call needs:
 *   - is the DB reachable? (a `store.ping()`)
 *   - is any active installation stalled? (age of its last finished run)
 *   - are cursors stuck? (count of cursors in the `error` status)
 * The snapshot is `degraded` (HTTP 503) when the DB is unreachable, or a run is
 * older than `staleRunThresholdMs`, or cursors-in-error exceeds `maxCursorsInError`.
 *
 * `/admin/overview` is the AUTHENTICATED, richer JSON counterpart (installations,
 * their latest run, recent webhooks) for a human/dashboard.
 */

export interface HealthThresholds {
  /** A last run older than this marks the installation (and the snapshot) stale. Default 6h. */
  staleRunThresholdMs?: number;
  /** More cursors-in-error than this degrades the snapshot. Default 10. */
  maxCursorsInError?: number;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  db: 'ok' | 'error';
  active_installations: number;
  cursors_in_error: number;
  /** Per active installation: age (ms) of the last finished run (null if never run). */
  installations: Array<{ installation_id: string; last_run_at: string | null; last_run_age_ms: number | null; last_run_status: string | null; stale: boolean }>;
  checked_at: string;
}

export async function buildHealthReport(
  store: IntegrationStore,
  repos: Repositories,
  nowMs: number,
  thresholds: HealthThresholds = {},
): Promise<HealthReport> {
  const staleThreshold = thresholds.staleRunThresholdMs ?? 6 * 60 * 60_000;
  const maxInError = thresholds.maxCursorsInError ?? 10;

  /** The answer when the store cannot be questioned. The probe must ALWAYS answer. */
  const degradedReport = (): HealthReport => ({
    status: 'degraded',
    db: 'error',
    active_installations: 0,
    cursors_in_error: 0,
    installations: [],
    checked_at: new Date(nowMs).toISOString(),
  });

  // Every store call is guarded, not just the ping: `SELECT 1` can succeed while
  // the kit's own tables are unreachable (revoked grants, dropped schema, failover
  // to a standby, a DDL migration holding a lock). Letting those throw would turn
  // the probe into a generic 500 with no body, instead of the documented
  // `{ db: 'error' }` / 503 that tells an operator what is wrong.
  try {
    await store.ping();

    const active = await repos.installs.listActive();
    const cursorsInError = await repos.cursors.countInError();

    const installations = [];
    for (const inst of active) {
      const last = (await repos.runs.recent(inst.installation_id, 1))[0];
      const finishedAt = last?.finished_at ?? null;
      // Stored UTC; tolerates both the canonical ISO `Z` format and legacy v1 rows.
      const ageMs = finishedAt ? nowMs - parseStoreTimestamp(finishedAt) : null;
      const stale = ageMs != null && ageMs > staleThreshold;
      installations.push({
        installation_id: inst.installation_id,
        last_run_at: finishedAt,
        last_run_age_ms: ageMs != null && Number.isFinite(ageMs) ? ageMs : null,
        last_run_status: last?.status ?? null,
        stale,
      });
    }

    const anyStale = installations.some((i) => i.stale);
    const degraded = cursorsInError > maxInError || anyStale;

    return {
      status: degraded ? 'degraded' : 'ok',
      db: 'ok',
      active_installations: active.length,
      cursors_in_error: cursorsInError,
      installations,
      checked_at: new Date(nowMs).toISOString(),
    };
  } catch {
    return degradedReport();
  }
}

export interface OverviewReport {
  active_installations: number;
  cursors_in_error: number;
  installations: Array<{
    installation_id: string;
    status: string;
    shop_domain: string | null;
    last_run: { id: number; status: string; started_at: string; finished_at: string | null } | null;
  }>;
  recent_webhooks: Array<{ event: string | null; installation_id: string | null; signature_ok: number; created_at: string }>;
  generated_at: string;
}

export async function buildOverview(repos: Repositories, nowMs: number): Promise<OverviewReport> {
  const active = await repos.installs.listActive();
  const installations = [];
  for (const inst of active) {
    const last = (await repos.runs.recent(inst.installation_id, 1))[0];
    installations.push({
      installation_id: inst.installation_id,
      status: inst.status,
      shop_domain: inst.shop_domain,
      last_run: last
        ? { id: last.id, status: last.status, started_at: last.started_at, finished_at: last.finished_at }
        : null,
    });
  }
  return {
    active_installations: active.length,
    cursors_in_error: await repos.cursors.countInError(),
    installations,
    recent_webhooks: await repos.webhookLog.recent(20),
    generated_at: new Date(nowMs).toISOString(),
  };
}
