import {
  SpmOrdersStatuses,
  SpmApiError,
  SpmHelpers,
  type SpmEnvelope,
  type SpmHttpClient,
} from '@shopimind/sdk-js';
import type { ProvisioningPlan } from '../integration/types.js';
import type { NewCustomDataDefinition } from '../contracts/index.js';
import { validateProvisioningEvents, validateCustomDataDefinition } from '../integration/define-integration.js';
import { ensureDataSource, ensureCustomDataDefinition, ensureEvent } from './ensure.js';
import type { Logger } from '../logging/logger.js';

/**
 * Runs a `ProvisioningPlan` (idempotent find-or-create). Best-effort per
 * resource: an error is collected without interrupting the others. Returns the
 * resolved ids (sources by `key`, definitions by `name`) that the integration
 * then reuses during sync.
 */
export interface ProvisioningResult {
  sourceIds: Record<string, number>;
  defIds: Record<string, number>;
  events: number;
  orderStatuses: number;
  errors: string[];
}

export async function runProvisioning(
  client: SpmHttpClient,
  plan: ProvisioningPlan,
  logger?: Logger,
): Promise<ProvisioningResult> {
  const result: ProvisioningResult = { sourceIds: {}, defIds: {}, events: 0, orderStatuses: 0, errors: [] };

  for (const ds of plan.dataSources ?? []) {
    try {
      const parentId = ds.parentKey ? result.sourceIds[ds.parentKey] : undefined;
      const decl = parentId != null ? { ...ds.decl, parent_id: parentId } : ds.decl;
      result.sourceIds[ds.key] = await ensureDataSource(client, decl);
    } catch (e) {
      result.errors.push(`source ${ds.key}: ${errMsg(e)}`);
    }
  }

  // Order the custom-data plan so every custom→custom target is CREATED BEFORE
  // the definition that references it (its id must exist to resolve the relationship).
  // A topological sort removes the "declare X before Y" foot-gun entirely; a genuine
  // dependency CYCLE is a hard error (unresolvable). A relationship to an out-of-plan
  // custom name is left as-is and warned about (see resolveCustomRelationTargets).
  const orderedCustomData = topoSortCustomData(plan.customData ?? []);
  for (const def of orderedCustomData) {
    try {
      // Structural guards before the network call: unique_keys ⊆ fields and
      // relationships.sourceField ∈ fields. A misconfig fails here with a precise
      // message instead of an opaque API rejection.
      validateCustomDataDefinition(def);
      result.defIds[def.name] = await ensureCustomDataDefinition(
        client,
        resolveCustomRelationTargets(def, result.defIds, logger),
        logger,
        // Non-fatal problems (e.g. a stale custom->custom relationship the API cannot
        // repair) are REPORTED, not thrown: the definition itself is usable, so the
        // id must still be resolved — but the operator has to see the issue.
        (message) => result.errors.push(`def ${def.name}: ${message}`),
      );
    } catch (e) {
      result.errors.push(`def ${def.name}: ${errMsg(e)}`);
    }
  }

  for (const ev of plan.events ?? []) {
    try {
      // Contract guard: reject a malformed event (missing code_name) before the
      // network call. Collected per-resource (best-effort), like other errors.
      validateProvisioningEvents([ev]);
      await ensureEvent(client, ev);
      result.events += 1;
    } catch (e) {
      result.errors.push(`event ${ev.code_name}: ${errMsg(e)}`);
    }
  }

  if (plan.orderStatuses && plan.orderStatuses.length > 0) {
    try {
      // Fill the technical bookkeeping fields the API needs but the author
      // should not have to hand-write. Explicit values are preserved.
      const nowIso = new Date().toISOString();
      const statuses = plan.orderStatuses.map((s) => ({
        ...s,
        is_deleted: s.is_deleted ?? false,
        created_at: s.created_at ?? nowIso,
        updated_at: s.updated_at ?? nowIso,
      }));
      const env = await SpmOrdersStatuses.bulkSave(client, statuses, { chunk: true });
      result.orderStatuses = SpmHelpers.extractCounts(env).sent;
    } catch (e) {
      result.errors.push(`order statuses: ${errMsg(e)}`);
    }
  }

  return result;
}

/**
 * Resolves a custom relationship's `targetSchema` declared by NAME (a sibling
 * definition in the same plan) to the sibling's numeric id — mirroring how
 * dataSources resolve `parentKey` -> `parent_id`. Thanks to the topological sort
 * the sibling is always created before this definition. A `targetSchema` that
 * is already numeric is left untouched; a custom target that is NON-NUMERIC and NOT
 * in the plan cannot be resolved to an id — it is left as-is and WARNED about.
 */
function resolveCustomRelationTargets(
  def: NewCustomDataDefinition,
  defIds: Record<string, number>,
  logger?: Logger,
): NewCustomDataDefinition {
  if (!def.relationships?.length) return def;
  return {
    ...def,
    relationships: def.relationships.map((r) => {
      if (r.targetSchemaType !== 'custom') return r;
      if (defIds[r.targetSchema] != null) return { ...r, targetSchema: String(defIds[r.targetSchema]) };
      // Not resolved by name. If it is not already a numeric id, it references an
      // out-of-plan definition we cannot resolve here — surface it rather than
      // silently shipping an unresolvable target to the API.
      if (!/^\d+$/.test(String(r.targetSchema))) {
        logger?.warn(
          `custom data '${def.name}': relationship target '${r.targetSchema}' is not in this plan and not a numeric id — left unresolved`,
          { definition: def.name, sourceField: r.sourceField, targetSchema: r.targetSchema },
        );
      }
      return r;
    }),
  };
}

/**
 * Topologically sorts the custom-data plan so a definition is always emitted AFTER
 * the sibling definitions it references via custom→custom relationships. Only
 * intra-plan custom targets create an edge; system targets and out-of-plan/numeric
 * targets do not. Throws on a dependency cycle (unresolvable ordering). Definitions
 * without in-plan dependencies keep their declaration order (stable).
 */
export function topoSortCustomData(defs: NewCustomDataDefinition[]): NewCustomDataDefinition[] {
  if (defs.length <= 1) return defs;
  const byName = new Map(defs.map((d) => [d.name, d]));
  const deps = new Map<string, string[]>();
  for (const d of defs) {
    const targets = (d.relationships ?? [])
      .filter((r) => r.targetSchemaType === 'custom' && byName.has(r.targetSchema) && r.targetSchema !== d.name)
      .map((r) => r.targetSchema);
    deps.set(d.name, [...new Set(targets)]);
  }

  const sorted: NewCustomDataDefinition[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (name: string): void => {
    const s = state.get(name);
    if (s === 'done') return;
    if (s === 'visiting') {
      throw new Error(`custom data: dependency cycle detected (${[...stack, name].join(' -> ')})`);
    }
    state.set(name, 'visiting');
    stack.push(name);
    for (const dep of deps.get(name) ?? []) visit(dep);
    stack.pop();
    state.set(name, 'done');
    const def = byName.get(name);
    if (def) sorted.push(def);
  };

  // Iterate in declaration order so independent definitions keep their relative order.
  for (const d of defs) visit(d.name);
  return sorted;
}

/**
 * The BUSINESS message carried by a failed call.
 *
 * `env.error.message` is NOT it: the SDK fills it with the transport-level text
 * ("Request failed with status code 400"). What the API actually wrote sits in the
 * raw body, at `env.data.message` — a string, or a string[] for validation errors.
 */
function apiMessage(env: SpmEnvelope | null | undefined): string {
  const body = env?.data as { message?: unknown } | null | undefined;
  const raw = body?.message;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map((m) => String(m)).join('; ');
  return '';
}

/**
 * Message pushed into `result.errors` — the only operator-facing rendering of a
 * provisioning failure (logged by the dispatcher, returned by the admin reprovision
 * route). For an SDK failure `e.message` carries only the generic transport text, so
 * without the envelope body the operator gets a string that names the call which
 * failed but never the reason.
 */
function errMsg(e: unknown): string {
  if (e instanceof SpmApiError) {
    const detail = apiMessage(e.envelope);
    return detail ? `${e.message} -- ${detail}` : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
