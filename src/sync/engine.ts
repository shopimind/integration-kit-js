import type { CursorRepo, RunRepo } from '../store/repositories.js';
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
}

export interface SyncSummary {
  runId: number;
  status: 'ok' | 'partial';
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

  const runId = deps.runs.start(base.installationId);
  const summary: SyncSummary = { runId, status: 'ok', steps: [], errors: [] };

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
        const stepSummary = await runOneSource(step, base, deps, sourceKey, { now, full, backfillDays });
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
  win: { now: () => Date; full: boolean; backfillDays: number },
): Promise<SyncStepSummary> {
  const cursor = deps.cursors.get(base.installationId, step.entity, sourceKey) ?? null;
  const window = computeWindow(cursor?.last_synced_at ?? null, win);

  // Per-step-run reject accumulator: `ctx.sendBulk` and `withSource(k).send` feed it,
  // so the engine can HOLD the cursor on data loss EVEN IF the step result omits the
  // count — safe by construction (the dev cannot forget to surface rejections).
  const rejects = { count: 0 };
  const stepSendBulk = makeSendBulk(base.spm, base.logger, (n) => {
    rejects.count += n;
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

  // GOLDEN RULE: do not advance the cursor on (a) a step error OR (b) unhandled
  // rejections (data the API did NOT persist). `tolerateRejects` only lifts (b) — for
  // a windowed stream a PERMANENT rejection ("poison pill") would otherwise freeze the
  // window forever — but rejections stay visible (the warn log + the summary count).
  const cleanRun = shouldAdvanceCursor(result);
  const blockedByRejects = rejects.count > 0 && !step.tolerateRejects;
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
    });
  } else if (errors.length > 0) {
    // Failed/blocked step: record the failure WITHOUT advancing the cursor, so the
    // same window is replayed next run (no silent data loss). The CursorWrite API
    // requires a last_synced_at, so we keep the previous value (or null if none yet).
    deps.cursors.set(base.installationId, step.entity, sourceKey, {
      // Keep the OLD cursor value (or null on a never-synced source); the column is
      // nullable at the DB level even though CursorWrite types it as a string.
      last_synced_at: (cursor?.last_synced_at ?? null) as unknown as string,
      last_status: 'error',
      last_error: errors.join('; '),
      items: result.items,
    });
  }

  return { entity: step.entity, sourceKey, items: result.items, rejected: rejects.count, errors, advanced };
}

/** Sync window: backfill on the first run / in full mode, otherwise from the cursor. */
export function computeWindow(
  lastSyncedAt: string | null,
  opts: { now: () => Date; full: boolean; backfillDays: number },
): SyncWindow {
  const until = opts.now();
  if (opts.full || !lastSyncedAt) {
    const since = new Date(until);
    since.setDate(since.getDate() - opts.backfillDays);
    return { since, until };
  }
  return { since: new Date(lastSyncedAt), until };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
