import type { Integration } from './types.js';

/**
 * Entry point of the author contract. Identity + boot-time validation: a
 * malformed spec throws early (rather than behaving silently wrong).
 */
export function defineIntegration<S>(integration: Integration<S>): Integration<S> {
  validateIntegration(integration);
  return integration;
}

export function validateIntegration<S>(c: Integration<S>): void {
  if (!c.slug || !/^[a-z0-9_-]+$/.test(c.slug)) {
    throw new Error(`invalid integration.slug: "${c.slug}" (expected [a-z0-9_-]+)`);
  }
  // meta.version must be present and a strict semver-ish `x.y.z` (it feeds the manifest).
  if (!c.meta || !/^\d+\.\d+\.\d+$/.test(c.meta.version ?? '')) {
    throw new Error(`invalid integration.meta.version: "${c.meta?.version}" (expected x.y.z)`);
  }
  const entities = c.syncSteps.map((s) => s.entity);
  // Each sync step must declare a non-empty entity (whitespace-only is rejected).
  for (const step of c.syncSteps) {
    if (typeof step.entity !== 'string' || step.entity.trim() === '') {
      throw new Error('sync step has an empty entity');
    }
  }
  const dup = entities.find((e, i) => entities.indexOf(e) !== i);
  if (dup) {
    throw new Error(`duplicate sync step for entity "${dup}"`);
  }
  for (const step of c.syncSteps) {
    if (step.cursorScope === 'per-source' && !step.sources) {
      throw new Error(`step "${step.entity}" has scope 'per-source' but does not declare sources()`);
    }
  }
  // NOTE: provisioned events live in the ProvisioningPlan returned by the
  // `provisioning(ctx)` function, which needs a runtime ctx and is therefore not
  // reachable from this static, boot-time validator. Each event's `code_name` is
  // validated by `validateProvisioningEvents` when the plan is materialized.
}

/**
 * Validates the events of a materialized ProvisioningPlan: each event must carry
 * a non-empty `code_name`. Called by the provisioning runner once the (async)
 * plan has been produced — `validateIntegration` cannot do this because the plan
 * depends on a runtime context.
 */
export function validateProvisioningEvents(events: ReadonlyArray<{ code_name?: string }>): void {
  for (const ev of events) {
    if (typeof ev.code_name !== 'string' || ev.code_name.trim() === '') {
      throw new Error('provisioning event is missing a code_name');
    }
  }
}
