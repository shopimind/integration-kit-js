import type { Repositories } from '../store/repositories.js';

/**
 * Persistence of the provisioning id map (source keys and definition names -> ids).
 *
 * Kept in its own module, deliberately NOT re-exported by the package index: this is
 * kit-internal plumbing, not part of the authoring contract. `PROVISIONING_KEY` is
 * re-exported by the dispatcher, which has always exposed it.
 */

/** State key where the provisioning result (sourceIds/defIds) is stored. */
export const PROVISIONING_KEY = '__provisioning';

export interface ProvisioningMap {
  sourceIds: Record<string, number>;
  defIds: Record<string, number>;
}

/**
 * Persists the provisioning id map, MERGING it with what is already stored instead
 * of replacing it.
 *
 * Provisioning is best-effort per resource: a run where one definition fails still
 * returns a map, only without that key. Writing that partial map over the previous
 * one ERASES ids a previous successful run had resolved — and resolving a source or
 * a custom data definition THROWS when its id is missing, so a single transient
 * provisioning failure would turn a healthy installation into a permanently broken
 * sync (cursor held, exponential backoff). Merging makes a failed run inert instead
 * of destructive.
 *
 * Keys resolved by THIS run always win. Trade-off accepted: an id for a resource
 * REMOVED from the plan survives — harmless, where a missing id is not.
 */
export async function persistProvisioningMap(
  state: Repositories['state'],
  installationId: string,
  prov: ProvisioningMap,
): Promise<void> {
  let previous: Partial<ProvisioningMap> = {};
  try {
    const raw = await state.get(installationId, PROVISIONING_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') previous = parsed as Partial<ProvisioningMap>;
    }
  } catch {
    // Unreadable or corrupted blob: treat it as absent rather than aborting the run.
    previous = {};
  }
  await state.set(
    installationId,
    PROVISIONING_KEY,
    JSON.stringify({
      sourceIds: { ...(previous.sourceIds ?? {}), ...prov.sourceIds },
      defIds: { ...(previous.defIds ?? {}), ...prov.defIds },
    }),
  );
}
