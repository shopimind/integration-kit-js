import type { SyncStep, SyncStepContext, SyncStepResult, IntegrationContext } from './types.js';
import type { BulkResult } from '../sdk/send-bulk.js';

/**
 * `defineBulkStep` (E12) — pure sugar over the common "stream a window, map each raw
 * item to a record, push in batches, advance the cursor to `window.until`" shape that
 * every catalog/entity sync step repeats. The author supplies only the domain bits:
 * where to read (`stream`), how to shape (`map`), and how to push (`push`). The kit
 * handles the batching, the try/catch (an error is collected, the cursor holds), the
 * item count, and — by default — `advanceCursorTo = window.until` on a clean run.
 *
 * It produces a plain {@link SyncStep}, so it composes with everything else (the
 * engine's cursor rules, reject holding, backoff, dead-letter…) unchanged. Authors
 * who need finer control keep writing steps by hand.
 */
export interface BulkStepConfig<S, Raw, Rec> {
  entity: string;
  /** Cursor scope. Defaults to `'global'` (E12). */
  cursorScope?: 'global' | 'per-source';
  /** Whether the step runs for the given settings. Defaults to `() => true` (E12). */
  enabled?: (settings: S) => boolean;
  /** Required for `cursorScope: 'per-source'` — the source keys to iterate. */
  sources?: (ctx: IntegrationContext<S>) => Promise<string[]> | string[];
  /** See {@link SyncStep.tolerateRejects}. Forwarded as-is. */
  tolerateRejects?: boolean | { maxRatio: number };
  /** Batch size before a flush. Default 500. */
  batchSize?: number;
  /** Streams the raw items for the step's window (async iterable / generator). */
  stream: (ctx: SyncStepContext<S>) => AsyncIterable<Raw>;
  /** Maps a raw item to a record to push. Return `null`/`undefined` to skip it. */
  map: (raw: Raw, ctx: SyncStepContext<S>) => Rec | null | undefined;
  /** Pushes a batch of records (typically `ctx.sendBulk(...)` or `ctx.withSource(k).send(...)`). */
  push: (ctx: SyncStepContext<S>, records: Rec[]) => Promise<BulkResult | unknown>;
  /**
   * Overrides the cursor bound on a clean run. Defaults to `ctx.window.until`
   * (the standard windowed advance). Return `null` to NOT advance (a pure fan-out).
   */
  advanceTo?: (ctx: SyncStepContext<S>) => Date | null;
}

export function defineBulkStep<S, Raw, Rec>(config: BulkStepConfig<S, Raw, Rec>): SyncStep<S> {
  const batchSize = Math.max(1, config.batchSize ?? 500);

  const step: SyncStep<S> = {
    entity: config.entity,
    cursorScope: config.cursorScope ?? 'global',
    enabled: config.enabled ?? ((): boolean => true),
    ...(config.sources ? { sources: config.sources } : {}),
    ...(config.tolerateRejects !== undefined ? { tolerateRejects: config.tolerateRejects } : {}),
    run: async (ctx: SyncStepContext<S>): Promise<SyncStepResult> => {
      const errors: string[] = [];
      let items = 0;
      let batch: Rec[] = [];

      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        const toSend = batch;
        batch = [];
        await config.push(ctx, toSend);
        items += toSend.length;
      };

      try {
        for await (const raw of config.stream(ctx)) {
          const rec = config.map(raw, ctx);
          if (rec == null) continue;
          batch.push(rec);
          if (batch.length >= batchSize) await flush();
        }
        await flush();
      } catch (e) {
        // Collected, not thrown: the engine holds the cursor (window replays). Rejections
        // reported by `push` still feed the engine's reject sink independently.
        errors.push(`bulk step '${config.entity}': ${e instanceof Error ? e.message : String(e)}`);
        return { items, errors };
      }

      // Clean run: advance to window.until by default (E12), unless overridden/null.
      const advanceTo = config.advanceTo ? config.advanceTo(ctx) : ctx.window.until;
      return advanceTo == null ? { items, errors } : { items, errors, advanceCursorTo: advanceTo };
    },
  };
  return step;
}
