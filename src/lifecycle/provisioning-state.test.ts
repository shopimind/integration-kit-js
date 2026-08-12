import { describe, it, expect } from 'vitest';
import { persistProvisioningMap, PROVISIONING_KEY } from './provisioning-state.js';
import type { Repositories } from '../store/repositories.js';

/** Minimal in-memory stand-in for the state repository (only get/set are used). */
function fakeState(initial?: string): { state: Repositories['state']; read: () => string | undefined } {
  let stored = initial;
  const state = {
    get: async (_id: string, key: string) => (key === PROVISIONING_KEY ? (stored ?? null) : null),
    set: async (_id: string, key: string, value: string) => {
      if (key === PROVISIONING_KEY) stored = value;
    },
  } as unknown as Repositories['state'];
  return { state, read: () => stored };
}

const parse = (raw: string | undefined): { sourceIds: Record<string, number>; defIds: Record<string, number> } =>
  JSON.parse(raw ?? '{}') as { sourceIds: Record<string, number>; defIds: Record<string, number> };

describe('persistProvisioningMap', () => {
  it('writes the map when nothing was stored yet', async () => {
    const { state, read } = fakeState();
    await persistProvisioningMap(state, 'inst', { sourceIds: { parent: 1 }, defIds: { stores: 40 } });
    expect(parse(read())).toEqual({ sourceIds: { parent: 1 }, defIds: { stores: 40 } });
  });

  it('MERGES: a partial run never erases ids resolved by a previous successful run', async () => {
    // A healthy install: both definitions resolved.
    const { state, read } = fakeState(
      JSON.stringify({ sourceIds: { parent: 1, store_7: 2 }, defIds: { stores: 40, contact_store: 41 } }),
    );
    // A re-activation where `contact_store` failed: its key is absent from the result.
    await persistProvisioningMap(state, 'inst', { sourceIds: { parent: 1 }, defIds: { stores: 40 } });
    // Resolving a custom data definition THROWS on a missing id: overwriting here
    // would have broken every subsequent sync of a previously working installation.
    expect(parse(read())).toEqual({
      sourceIds: { parent: 1, store_7: 2 },
      defIds: { stores: 40, contact_store: 41 },
    });
  });

  it('keys resolved by THIS run win over the stored ones', async () => {
    const { state, read } = fakeState(JSON.stringify({ sourceIds: {}, defIds: { stores: 40 } }));
    await persistProvisioningMap(state, 'inst', { sourceIds: {}, defIds: { stores: 99 } });
    expect(parse(read()).defIds.stores).toBe(99);
  });

  it('treats a corrupted stored blob as absent instead of aborting the run', async () => {
    const { state, read } = fakeState('{not json');
    await persistProvisioningMap(state, 'inst', { sourceIds: {}, defIds: { stores: 40 } });
    expect(parse(read())).toEqual({ sourceIds: {}, defIds: { stores: 40 } });
  });
});
