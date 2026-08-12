import type { SpmEnvelope, SpmHttpClient } from '@shopimind/sdk-js';
import type { BulkResult, SendBulk, SendBulkOptions } from './send-bulk.js';

/**
 * Handle for a PROVISIONED source. Exposes its `id_data_source` plus a `tag()`
 * that injects it into every item — the recommended way to ensure an integration
 * NEVER overwrites the merchant's native catalog. The SDK is not re-wrapped: the
 * integration tags items then pushes them itself via the SDK
 * (`SpmProducts.bulkSave(ctx.spm, tagged)`).
 *
 * Note: the source alone is not enough. On the core side, `id_data_source` is NOT
 * part of the upsert key. You must ALSO namespace your identifiers (prefix/offset)
 * so the upsert lands on rows distinct from the native ones. `tag()` guarantees the
 * tag; namespacing remains the responsibility of your mappers.
 */
export interface SourceHandle {
  /** `id_data_source` of the provisioned source (resolved by key). */
  readonly id: number;
  /** Tags each item with `id_data_source` (to be pushed afterwards via the SDK). */
  tag<T extends object>(items: T[]): Array<T & { id_data_source: number }>;
  /**
   * Tags then pushes via the safe bulk primitive: source tagging + envelope/rejection
   * safety in one call (flat `(client, data, opts)` shape). For path-param bulks
   * (variations/images/addresses), use `ctx.sendBulk(() => fn(ctx.spm, parentId, src.tag(items)))`.
   */
  send<T extends object>(
    fn: (client: SpmHttpClient, data: Array<T & { id_data_source: number }>, opts?: SendBulkOptions) => Promise<SpmEnvelope>,
    items: T[],
    opts?: SendBulkOptions,
  ): Promise<BulkResult>;
}

/**
 * Builds `ctx.withSource`: resolves the `id_data_source` of a PROVISIONED source
 * and returns a {@link SourceHandle}. Throws if the source was not declared in
 * `provisioning.dataSources` (guard: pushing catalog data without a dedicated
 * source is not allowed).
 *
 * `provisioningRaw` is the persisted provisioning blob, PRE-LOADED by the runtime
 * when the context is built (the port is async; pre-loading keeps `ctx.withSource`
 * synchronous for integrations). Safe: a reprovision never runs concurrently with
 * a sync on the same installation (the runtime's per-installation lock).
 */
export function makeWithSource(
  provisioningRaw: string | null,
  sendBulk: SendBulk,
): (sourceKey: string) => SourceHandle {
  return (sourceKey: string): SourceHandle => {
    // Parse defensively: corrupt/unreadable persisted state must surface as the
    // business error "source not provisioned" (below), never as an opaque
    // SyntaxError. An unparseable blob is treated as "no sources provisioned".
    let sourceIds: Record<string, number> = {};
    if (provisioningRaw) {
      try {
        sourceIds = (JSON.parse(provisioningRaw) as { sourceIds?: Record<string, number> }).sourceIds ?? {};
      } catch {
        sourceIds = {};
      }
    }
    const id = sourceIds[sourceKey];
    if (id == null) {
      throw new Error(
        `withSource("${sourceKey}"): source not provisioned — declare it in provisioning.dataSources`,
      );
    }
    const tag = <T extends object>(items: T[]): Array<T & { id_data_source: number }> =>
      items.map((i) => ({ ...i, id_data_source: id }));
    return {
      id,
      tag,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      send: (fn, items, opts) => sendBulk(fn as any, tag(items), opts),
    };
  };
}
