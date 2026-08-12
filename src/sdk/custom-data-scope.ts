import { SpmCustomDataRecords, type SpmEnvelope, type SpmHttpClient } from '@shopimind/sdk-js';
import type { BulkResult, SendBulk, SendBulkOptions } from './send-bulk.js';

/**
 * Handle for a PROVISIONED custom data definition. Exposes its numeric `id`
 * (resolved by name) plus a `save()` that upserts records into it through the
 * safe bulk primitive (chunked, throws on a transport failure, surfaces per-item
 * rejections). The counterpart of {@link SourceHandle} for custom data: a data
 * source tags base entities, whereas a custom data definition stores its own
 * records — so the handle exposes `save()` rather than `tag()`.
 */
export interface CustomDataHandle {
  /** Numeric `id` of the provisioned custom data definition (resolved by name). */
  readonly id: number;
  /** Safe upsert of records into this definition (matched by its unique keys). */
  save<T extends object>(records: T[], opts?: SendBulkOptions): Promise<BulkResult>;
}

/**
 * Builds `ctx.customData`: resolves the numeric id of a PROVISIONED custom data
 * definition (by `name`) and returns a {@link CustomDataHandle}. Throws if the
 * definition was not declared in `provisioning.customData` (the symmetric guard
 * of {@link makeWithSource}).
 *
 * `provisioningRaw` is the persisted provisioning blob, PRE-LOADED by the runtime
 * when the context is built (see {@link makeWithSource} for why).
 */
export function makeCustomData(
  provisioningRaw: string | null,
  sendBulk: SendBulk,
  spm: SpmHttpClient,
): (name: string) => CustomDataHandle {
  return (name: string): CustomDataHandle => {
    // Parse defensively: a corrupt/unreadable persisted blob is treated as
    // "nothing provisioned" and surfaces as the business error below, never as
    // an opaque SyntaxError.
    let defIds: Record<string, number> = {};
    if (provisioningRaw) {
      try {
        defIds = (JSON.parse(provisioningRaw) as { defIds?: Record<string, number> }).defIds ?? {};
      } catch {
        defIds = {};
      }
    }
    const id = defIds[name];
    if (id == null) {
      throw new Error(
        `customData("${name}"): custom data definition not provisioned — declare it in provisioning.customData`,
      );
    }
    return {
      id,
      save: <T extends object>(records: T[], opts?: SendBulkOptions): Promise<BulkResult> =>
        sendBulk(() =>
          SpmCustomDataRecords.bulkSave(
            spm,
            id,
            records as unknown as Parameters<typeof SpmCustomDataRecords.bulkSave>[2],
            { chunk: true, ...opts },
          ) as Promise<SpmEnvelope>,
        ),
    };
  };
}
