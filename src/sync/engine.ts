import type { CursorRepo, RunRepo, RejectedItemRepo } from '../store/repositories.js';
import type {
  Integration,
  IntegrationContext,
  SyncStep,
  SyncStepContext,
  SyncStepResult,
  SyncWindow,
} from '../integration/types.js';
import type { SourceHandle } from '../sdk/source-scope.js';
import type { CustomDataHandle } from '../sdk/custom-data-scope.js';
import { makeSendBulk, type SendBulk } from '../sdk/send-bulk.js';
import { paginate } from './paginate.js';
import { mapWithConcurrency } from './concurrency.js';
import { shouldAdvanceCursor } from './cursor.js';

export interface SyncOptions {
  fullBackfill?: boolean;
  backfillDays?: number;
  /**
   * Defensive OVERLAP (E9): on an incremental window, shift `since` back by this many
   * seconds so an event that landed exactly on the previous cursor boundary (or a
   * source with slightly skewed clocks) is not missed. Harmless: re-fetched items are
   * idempotent on the ShopiMind side (bulkSave upserts). 0/undefined -> no overlap.
   */
  overlapSeconds?: number;
  /** Injectable for testing; defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface SyncStepSummary {
  entity: string;
  sourceKey: string;
  items: number;
  /** Items the API rejected during the step (data NOT persisted on the ShopiMind side). */
  rejected: number;
  errors: string[];
  advanced: boolean;
  /**
   * True when the step-source was NOT run because its cursor is in exponential
   * backoff after repeated failures (E3). `items`/`rejected` are 0, `errors` empty.
   */
  skippedBackoff?: boolean;
}

/**
 * Log ERROR once this many consecutive failures pile up on a cursor (E3), so a
 * persistently broken source escalates from warn-noise to an actionable signal.
 */
const ESCALATE_AT_FAILURES = 3;
/** Backoff is capped at ~24h: 2^(k-1) minutes, never longer than this. */
const MAX_BACKOFF_MS = 24 * 60 * 60_000;
/** Base backoff unit (E3): the k-th consecutive failure skips ticks for ~2^(k-1) minutes. */
const BACKOFF_BASE_MS = 60_000;
/** Per-run cap on dead-lettered items (E4) — a poison batch must not flood the store. */
const REJECTED_ITEMS_CAP_PER_RUN = 500;

/**
 * Exponential backoff window after `n` consecutive failures: 2^(n-1) minutes,
 * capped at 24h. n<=0 -> 0 (no wait). While `now < updated_at + window` the engine
 * SKIPS the step-source; the cursor is untouched (GOLDEN RULE preserved).
 */
export function backoffWindowMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const ms = BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1);
  return Math.min(ms, MAX_BACKOFF_MS);
}

/**
 * Decides whether per-item rejections should be TOLERATED (cursor may advance),
 * per the step's `tolerateRejects` policy (E8):
 *   - `undefined`/`false` -> never tolerate (strict hold);
 *   - `true`              -> always tolerate (poison-pill escape hatch);
 *   - `{ maxRatio }`      -> tolerate only while rejected/attempted <= maxRatio.
 * `attempted` = accepted `items` + `rejected` (the reject sink is not counted in
 * `items`, so we add it back to size the denominator).
 */
export function rejectsTolerated(
  policy: boolean | { maxRatio: number } | undefined,
  rejected: number,
  items: number,
): boolean {
  if (!policy) return false;
  if (policy === true) return true;
  const attempted = items + rejected;
  if (attempted <= 0) return true; // nothing attempted -> nothing to hold on
  const ratio = rejected / attempted;
  return ratio <= policy.maxRatio;
}

export interface SyncSummary {
  runId: number;
  status: 'ok' | 'partial';
  /** Whether this run was a full backfill or an incremental sync (admin observability). */
  mode: 'full' | 'incremental';
  steps: SyncStepSummary[];
  errors: string[];
}

export interface SyncDeps {
  cursors: CursorRepo;
  runs: RunRepo;
  /**
   * Builds `withSource` bound to a given `sendBulk`, so source-scoped pushes
   * (`withSource(k).send(...)`) feed the step's reject accumulator. Provided by the
   * runtime, which knows the installation + provisioning state.
   */
  makeSource: (sendBulk: SendBulk) => (sourceKey: string) => SourceHandle;
  /**
   * Builds `customData` bound to a given `sendBulk`, so `customData(name).save(...)`
   * inside a step feeds the step's reject accumulator.
   */
  makeCustomData: (sendBulk: SendBulk) => (name: string) => CustomDataHandle;
  /**
   * Optional dead-letter sink (E4). When provided, per-item REJECTIONS reported
   * during a step are recorded here (capped per run) so an operator can inspect and
   * later replay what the API refused. Best-effort: a store failure never aborts sync.
   */
  rejectedItems?: RejectedItemRepo;
}

/**
 * Runs the enabled sync steps of an integration. The cursor is managed HERE,
 * never by the integration:
 *   - scope 'global'      -> one cursor (entity, '')
 *   - scope 'per-source'  -> one cursor per source (entity, sourceKey)
 * GOLDEN RULE: the cursor only advances if the step had NO error.
 */
export async function runIntegrationSync<S>(
  integration: Pick<Integration<S>, 'syncSteps'>,
  base: IntegrationContext<S>,
  deps: SyncDeps,
  opts: SyncOptions = {},
): Promise<SyncSummary> {
  const now = opts.now ?? ((): Date => new Date());
  const backfillDays = opts.backfillDays ?? 365;
  const full = opts.fullBackfill ?? false;
  const overlapSeconds = opts.overlapSeconds ?? 0;

  const runId = deps.runs.start(base.installationId);
  const summary: SyncSummary = { runId, status: 'ok', mode: full ? 'full' : 'incremental', steps: [], errors: [] };
  // Per-run budget shared across all step-sources: caps total dead-lettered items (E4).
  const deadLetterBudget = { remaining: REJECTED_ITEMS_CAP_PER_RUN };

  try {
    for (const step of integration.syncSteps) {
      if (!step.enabled(base.settings)) continue;
      const resolved = await resolveSources(step, base);
      if (resolved.error) {
        // A misconfigured per-source step (no sources()) is NOT skipped silently:
        // surface it so the run is marked partial instead of hiding missing data.
        summary.errors.push(resolved.error);
        continue;
      }
      for (const sourceKey of resolved.sourceKeys) {
        const stepSummary = await runOneSource(step, base, deps, sourceKey, {
          now,
          full,
          backfillDays,
          overlapSeconds,
          runId,
          deadLetterBudget,
        });
        summary.steps.push(stepSummary);
        summary.errors.push(...stepSummary.errors);
      }
    }
    summary.status = summary.errors.length > 0 ? 'partial' : 'ok';
    deps.runs.finish(runId, summary.status, summary);
    return summary;
  } catch (e) {
    deps.runs.finish(runId, 'failed', { errors: [errMsg(e)] });
    throw e;
  }
}

interface ResolvedSources {
  sourceKeys: string[];
  /** Set when the step is misconfigured (per-source without a sources() resolver). */
  error?: string;
}

async function resolveSources<S>(step: SyncStep<S>, base: IntegrationContext<S>): Promise<ResolvedSources> {
  if (step.cursorScope === 'global') return { sourceKeys: [''] };
  if (!step.sources) {
    return { sourceKeys: [], error: `per-source step '${step.entity}' has no sources()` };
  }
  return { sourceKeys: await step.sources(base) };
}

async function runOneSource<S>(
  step: SyncStep<S>,
  base: IntegrationContext<S>,
  deps: SyncDeps,
  sourceKey: string,
  win: {
    now: () => Date;
    full: boolean;
    backfillDays: number;
    overlapSeconds: number;
    runId: number;
    deadLetterBudget: { remaining: number };
  },
): Promise<SyncStepSummary> {
  const cursor = deps.cursors.get(base.installationId, step.entity, sourceKey) ?? null;

  // E3 — EXPONENTIAL BACKOFF. A cursor that keeps failing must not hammer a broken
  // upstream every tick. While inside the backoff window (based on the last failure's
  // `updated_at`), skip this step-source entirely. The cursor is NOT touched (GOLDEN
  // RULE preserved) and no error is added — the source will simply retry once the
  // window elapses. `full` mode (an explicit operator backfill) bypasses backoff.
  const failures = cursor?.consecutive_failures ?? 0;
  if (!win.full && failures > 0 && cursor?.updated_at) {
    const backoffMs = backoffWindowMs(failures);
    const lastAt = Date.parse(cursor.updated_at + 'Z'); // stored UTC (SQLite datetime('now'))
    const readyAt = Number.isNaN(lastAt) ? 0 : lastAt + backoffMs;
    if (win.now().getTime() < readyAt) {
      base.logger.info(`sync step '${step.entity}' in backoff — skipped this tick`, {
        entity: step.entity,
        sourceKey,
        consecutive_failures: failures,
        retry_in_ms: readyAt - win.now().getTime(),
      });
      return { entity: step.entity, sourceKey, items: 0, rejected: 0, errors: [], advanced: false, skippedBackoff: true };
    }
  }

  const window = computeWindow(cursor?.last_synced_at ?? null, win);

  // Per-step-run reject accumulator: `ctx.sendBulk` and `withSource(k).send` feed it,
  // so the engine can HOLD the cursor on data loss EVEN IF the step result omits the
  // count — safe by construction (the dev cannot forget to surface rejections).
  const rejects = { count: 0 };
  const stepSendBulk = makeSendBulk(base.spm, base.logger, (n, items) => {
    rejects.count += n;
    // E4 — DEAD-LETTER. Persist what the API refused (bounded by the per-run budget)
    // so it survives the run for inspection/replay. Best-effort: a store hiccup here
    // must never fail the sync.
    if (deps.rejectedItems) recordRejects(deps.rejectedItems, base, step, sourceKey, win, items, rejects.count);
  });

  const ctx: SyncStepContext<S> = {
    ...base,
    entity: step.entity,
    sourceKey,
    window,
    cursor,
    paginate,
    mapConcurrent: mapWithConcurrency,
    sendBulk: stepSendBulk,
    withSource: deps.makeSource(stepSendBulk),
    customData: deps.makeCustomData(stepSendBulk),
  };

  let result: SyncStepResult;
  try {
    result = await step.run(ctx);
  } catch (e) {
    result = { items: 0, errors: [`fatal: ${errMsg(e)}`] };
  }

  // A step that finished CLEAN (no error) yet returned no `advanceCursorTo` almost
  // always means the author forgot to advance: the window will be replayed forever
  // and the cursor is stuck. This is a silent correctness bug (duplicate work, no
  // progress), so surface it loudly. A step that legitimately never advances (e.g.
  // a pure fan-out) can suppress this by returning `advanceCursorTo: ctx.window.until`.
  if (result.errors.length === 0 && result.advanceCursorTo == null) {
    base.logger.warn(
      `sync step '${step.entity}' completed clean without advanceCursorTo — cursor not advanced (window will replay)`,
      { entity: step.entity, sourceKey, items: result.items },
    );
  }

  // GOLDEN RULE: do not advance the cursor on (a) a step error OR (b) unhandled
  // rejections (data the API did NOT persist). `tolerateRejects` only lifts (b) — for
  // a windowed stream a PERMANENT rejection ("poison pill") would otherwise freeze the
  // window forever — but rejections stay visible (the warn log + the summary count).
  // E8: `{ maxRatio }` tolerates only while the reject ratio stays within budget.
  const cleanRun = shouldAdvanceCursor(result);
  const tolerated = rejectsTolerated(step.tolerateRejects, rejects.count, result.items);
  const blockedByRejects = rejects.count > 0 && !tolerated;
  const advanced = cleanRun && !blockedByRejects;

  const errors = [...result.errors];
  if (blockedByRejects) {
    errors.push(`${rejects.count} item(s) rejected (cursor held; set tolerateRejects to advance)`);
  }

  if (advanced) {
    const advanceTo = result.advanceCursorTo as Date;
    // Never advance past the window upper bound: a future cursor would make the
    // next window empty/inverted and silently skip data.
    const clamped = advanceTo.getTime() > window.until.getTime() ? window.until : advanceTo;
    deps.cursors.set(base.installationId, step.entity, sourceKey, {
      last_synced_at: clamped.toISOString(),
      last_status: 'ok',
      items: result.items,
      // E3 — a clean advance clears the failure escalation.
      consecutive_failures: 0,
    });
  } else if (errors.length > 0) {
    // Failed/blocked step: record the failure WITHOUT advancing the cursor, so the
    // same window is replayed next run (no silent data loss). `last_synced_at` is
    // nullable by contract (E11) — keep the previous value (or null if never synced).
    const nextFailures = failures + 1;
    if (nextFailures >= ESCALATE_AT_FAILURES) {
      // E3 — escalate to ERROR once failures pile up: a persistently broken source
      // deserves an actionable signal, not just repeated warns.
      base.logger.error(`sync step '${step.entity}' failing repeatedly`, {
        entity: step.entity,
        sourceKey,
        consecutive_failures: nextFailures,
        last_error: errors.join('; '),
      });
    }
    deps.cursors.set(base.installationId, step.entity, sourceKey, {
      last_synced_at: cursor?.last_synced_at ?? null,
      last_status: 'error',
      last_error: errors.join('; '),
      items: result.items,
      consecutive_failures: nextFailures,
    });
  }

  return { entity: step.entity, sourceKey, items: result.items, rejected: rejects.count, errors, advanced };
}

/**
 * Dead-letters the rejected items reported by a push (E4), honouring the per-run
 * budget. Best-effort: any store error is swallowed (a broken dead-letter must never
 * fail sync) — the rejection is already surfaced via the warn log + cursor hold.
 */
function recordRejects<S>(
  repo: RejectedItemRepo,
  base: IntegrationContext<S>,
  step: SyncStep<S>,
  sourceKey: string,
  win: { runId: number; deadLetterBudget: { remaining: number } },
  items: unknown[],
  reasonCount: number,
): void {
  if (win.deadLetterBudget.remaining <= 0) return;
  try {
    for (const item of items) {
      if (win.deadLetterBudget.remaining <= 0) break;
      win.deadLetterBudget.remaining -= 1;
      repo.add({
        installation_id: base.installationId,
        run_id: win.runId,
        entity: step.entity,
        source_key: sourceKey,
        payload_json: safeJson(item),
        reason: `rejected during ${step.entity} push`,
      });
    }
  } catch (e) {
    base.logger.warn('dead-letter write failed (best-effort)', { entity: step.entity, error: errMsg(e), reasonCount });
  }
}

/** JSON-stringifies an item, falling back to a placeholder on a non-serializable value. */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '"[unserializable rejected item]"';
  }
}

/**
 * Sync window: backfill on the first run / in full mode, otherwise from the cursor.
 * On an incremental window, `overlapSeconds` (E9) shifts `since` back defensively so
 * an item on the previous boundary is not missed (re-fetches are idempotent upserts).
 * A backfill window is NOT shifted — it already starts far in the past.
 */
export function computeWindow(
  lastSyncedAt: string | null,
  opts: { now: () => Date; full: boolean; backfillDays: number; overlapSeconds?: number },
): SyncWindow {
  const until = opts.now();
  if (opts.full || !lastSyncedAt) {
    const since = new Date(until);
    since.setDate(since.getDate() - opts.backfillDays);
    return { since, until };
  }
  const since = new Date(lastSyncedAt);
  const overlap = opts.overlapSeconds ?? 0;
  if (overlap > 0) since.setTime(since.getTime() - overlap * 1000);
  return { since, until };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
