import { SpmOrdersStatuses, SpmHelpers, type SpmHttpClient } from '@shopimind/sdk-js';
import type { ProvisioningPlan } from '../integration/types.js';
import { validateProvisioningEvents } from '../integration/define-integration.js';
import { ensureDataSource, ensureCustomDataDefinition, ensureEvent } from './ensure.js';

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

export async function runProvisioning(client: SpmHttpClient, plan: ProvisioningPlan): Promise<ProvisioningResult> {
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

  for (const def of plan.customData ?? []) {
    try {
      result.defIds[def.name] = await ensureCustomDataDefinition(client, def);
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
      const env = await SpmOrdersStatuses.bulkSave(client, plan.orderStatuses, { chunk: true });
      result.orderStatuses = SpmHelpers.extractCounts(env).sent;
    } catch (e) {
      result.errors.push(`order statuses: ${errMsg(e)}`);
    }
  }

  return result;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
