import {
  SpmApiError, SpmHelpers, type SpmEnvelope, type SpmHttpClient,
} from '@shopimind/sdk-js';
import type { Logger } from '../logging/logger.js';

/**
 * Normalized result of a safe bulk push. Note there is no `failed` field: a
 * transport-level failure (`failed_count > 0`) THROWS (it must replay), so a
 * resolved result only ever carries successfully-attempted + per-item-rejected items.
 */
export interface BulkResult {
  sent: number;
  /** Items the API REJECTED (validation, per-item, permanent-ish). Returned, not thrown. */
  rejected: number;
  /** The rejected items (bounded by chunk size) — for logging / targeted retry. */
  rejected_items: unknown[];
}

/** Options forwarded to the SDK bulk call (chunking is ON by default). */
export interface SendBulkOptions {
  chunk?: boolean;
  chunkSize?: number;
}

type FlatBulkFn<T> = (client: SpmHttpClient, data: T[], opts?: SendBulkOptions) => Promise<SpmEnvelope>;

/**
 * Safe bulk push. The SAFETY primitive of the kit, usable everywhere (sync steps
 * AND real-time inbound handlers). Two call forms:
 *  - flat:  `sendBulk(SpmProducts.bulkSave, items, opts?)`  — for the `(client, data, opts)` shape
 *  - thunk: `sendBulk(() => SpmProductsVariations.bulkSave(client, productId, items, { chunk: true }))`
 *           — for path-param shapes the flat form cannot express.
 *
 * Throws `SpmApiError` on any TRANSPORT failure — a global `!ok` OR `failed_count > 0`
 * (a chunk that errored): transport is transient, so the caller must REPLAY. Per-item
 * REJECTIONS (validation) are NOT a throw (one bad item must not abort the whole batch):
 * they are RETURNED (and surfaced via the optional `onReject` sink + a warn log). The
 * sync engine uses the sink to hold the cursor. Nothing is ever dropped silently.
 */
export interface SendBulk {
  <T>(fn: FlatBulkFn<T>, items: T[], opts?: SendBulkOptions): Promise<BulkResult>;
  (thunk: () => Promise<SpmEnvelope>): Promise<BulkResult>;
}

function rejectedItemsOf(env: SpmEnvelope): unknown[] {
  const d = env.data && typeof env.data === 'object' ? (env.data as Record<string, unknown>) : {};
  return Array.isArray(d.rejected_items) ? d.rejected_items : [];
}

/**
 * Builds a {@link SendBulk}. `onReject`, when provided, is called with the REJECTED
 * (validation) count + items so the sync engine can hold the cursor. Transport
 * failures (`failed_count`) THROW instead — they can never reach the sink, so
 * `tolerateRejects` cannot tolerate them. A warn log fires regardless, so neither
 * rejections nor failures are ever invisible.
 */
export function makeSendBulk(
  client: SpmHttpClient,
  logger: Logger,
  onReject?: (count: number, items: unknown[]) => void,
): SendBulk {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async (fnOrThunk: any, items?: any, opts?: SendBulkOptions): Promise<BulkResult> => {
    const env: SpmEnvelope = items === undefined
      ? await fnOrThunk()
      : await fnOrThunk(client, items, { chunk: true, ...opts });

    // Transport/HTTP failure -> throw (the caller replays). Never a silent drop.
    if (!env.ok) throw new SpmApiError(env, 'sendBulk');

    const { sent, rejected, failed } = SpmHelpers.extractCounts(env);
    const rejected_items = rejectedItemsOf(env);

    // FAILED = transport-level chunk failure (transient). The merged envelope couples
    // failed_count>0 to ok:false (so the !ok throw above usually fires first), but a
    // single bulk could still report failed_count on a 200 — so re-assert it here.
    // Transport must REPLAY -> throw; `tolerateRejects` can therefore never tolerate it.
    if (failed > 0) {
      logger.warn('bulk push had failed chunks (transport) — replay required', { sent, rejected, failed });
      throw new SpmApiError(env, `sendBulk (${failed} transport failure(s))`);
    }

    // REJECTED = per-item validation (permanent-ish): surfaced (warn + sink) and
    // RETURNED, not thrown — one bad item must not abort the whole batch.
    if (rejected > 0) {
      logger.warn('bulk push had rejected items (validation)', { sent, rejected });
      onReject?.(rejected, rejected_items);
    }
    return { sent, rejected, rejected_items };
  }) as SendBulk;
}
