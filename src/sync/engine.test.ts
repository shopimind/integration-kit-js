import { describe, it, expect } from 'vitest';
import { openDatabase } from '../store/db.js';
import { createRepositories } from '../store/repositories.js';
import { SecretCipher } from '../security/crypto.js';
import { createLogger } from '../logging/logger.js';
import { runIntegrationSync, computeWindow } from './engine.js';
import { makeWithSource } from '../sdk/source-scope.js';
import { makeCustomData } from '../sdk/custom-data-scope.js';
import { makeSendBulk, type SendBulk } from '../sdk/send-bulk.js';
import { PROVISIONING_KEY } from '../lifecycle/dispatcher.js';
import type { IntegrationContext, SyncStep } from '../integration/types.js';

const cipher = new SecretCipher({ key: 'c'.repeat(64) });
const at = new Date('2026-06-21T00:00:00.000Z');

function setup() {
  const repos = createRepositories(openDatabase(':memory:'), cipher);
  const logger = createLogger({ sink: () => {} });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spm = {} as any;
  const base: IntegrationContext<Record<string, never>> = {
    installationId: 'inst',
    settings: {},
    spm,
    sendBulk: makeSendBulk(spm, logger),
    state: repos.state,
    logger,
    setExternalAccount: () => {},
    inboundSecret: '',
    withSource: () => {
      throw new Error('n/a');
    },
    customData: () => {
      throw new Error('n/a');
    },
  };
  const deps = {
    cursors: repos.cursors,
    runs: repos.runs,
    makeSource: (sb: SendBulk) => makeWithSource(repos.state, 'inst', PROVISIONING_KEY, sb),
    makeCustomData: (sb: SendBulk) => makeCustomData(repos.state, 'inst', PROVISIONING_KEY, sb, spm),
  };
  return { repos, base, deps };
}

describe('runIntegrationSync - safe cursor (prevents data loss)', () => {
  it('advances the cursor on a clean run', async () => {
    const { repos, base, deps } = setup();
    const step: SyncStep<Record<string, never>> = {
      entity: 'customers',
      cursorScope: 'global',
      enabled: () => true,
      run: async () => ({ items: 3, errors: [], advanceCursorTo: at }),
    };
    const sum = await runIntegrationSync({ syncSteps: [step] }, base, deps, { now: () => at });
    expect(sum.status).toBe('ok');
    expect(repos.cursors.get('inst', 'customers', '')?.last_synced_at).toBe(at.toISOString());
  });

  it('DOES NOT advance the cursor on a partial run', async () => {
    const { repos, base, deps } = setup();
    repos.cursors.set('inst', 'orders', '', { last_synced_at: '2026-06-01T00:00:00.000Z' });
    const step: SyncStep<Record<string, never>> = {
      entity: 'orders',
      cursorScope: 'global',
      enabled: () => true,
      run: async () => ({ items: 1, errors: ['store 3 timeout'], advanceCursorTo: at }),
    };
    const sum = await runIntegrationSync({ syncSteps: [step] }, base, deps, { now: () => at });
    expect(sum.status).toBe('partial');
    expect(repos.cursors.get('inst', 'orders', '')?.last_synced_at).toBe('2026-06-01T00:00:00.000Z');
  });

  it('isolates per-source cursors: a failing store does not block the others', async () => {
    const { repos, base, deps } = setup();
    const step: SyncStep<Record<string, never>> = {
      entity: 'orders',
      cursorScope: 'per-source',
      enabled: () => true,
      sources: () => ['101', '102'],
      run: async (ctx) =>
        ctx.sourceKey === '102'
          ? { items: 0, errors: ['102 failed'] }
          : { items: 5, errors: [], advanceCursorTo: at },
    };
    const sum = await runIntegrationSync({ syncSteps: [step] }, base, deps, { now: () => at });
    expect(sum.status).toBe('partial');
    expect(repos.cursors.get('inst', 'orders', '101')?.last_synced_at).toBe(at.toISOString());
    // 102 failed: a failure row is recorded but the cursor is NOT advanced.
    const failed = repos.cursors.get('inst', 'orders', '102');
    expect(failed?.last_status).toBe('error');
    expect(failed?.last_synced_at).toBeNull();
  });

  it('writes a failure cursor row WITHOUT advancing last_synced_at', async () => {
    const { repos, base, deps } = setup();
    repos.cursors.set('inst', 'orders', '', { last_synced_at: '2026-06-01T00:00:00.000Z', last_status: 'ok' });
    const step: SyncStep<Record<string, never>> = {
      entity: 'orders',
      cursorScope: 'global',
      enabled: () => true,
      run: async () => ({ items: 2, errors: ['store 3 timeout', 'store 4 timeout'], advanceCursorTo: at }),
    };
    const sum = await runIntegrationSync({ syncSteps: [step] }, base, deps, { now: () => at });
    expect(sum.status).toBe('partial');
    const row = repos.cursors.get('inst', 'orders', '');
    // The old cursor value is preserved (window replayed next run).
    expect(row?.last_synced_at).toBe('2026-06-01T00:00:00.000Z');
    expect(row?.last_status).toBe('error');
    expect(row?.last_error).toBe('store 3 timeout; store 4 timeout');
  });

  it('writes a failure cursor row with a null last_synced_at on a never-synced source', async () => {
    const { repos, base, deps } = setup();
    const step: SyncStep<Record<string, never>> = {
      entity: 'orders',
      cursorScope: 'global',
      enabled: () => true,
      run: async () => ({ items: 0, errors: ['boom'] }),
    };
    const sum = await runIntegrationSync({ syncSteps: [step] }, base, deps, { now: () => at });
    expect(sum.status).toBe('partial');
    const row = repos.cursors.get('inst', 'orders', '');
    expect(row).toBeDefined();
    expect(row?.last_synced_at).toBeNull();
    expect(row?.last_status).toBe('error');
    expect(row?.last_error).toBe('boom');
  });

  it('surfaces an explicit error for a per-source step without sources()', async () => {
    const { repos, base, deps } = setup();
    let ran = false;
    const step: SyncStep<Record<string, never>> = {
      entity: 'orders',
      cursorScope: 'per-source',
      enabled: () => true,
      // no sources() -> misconfigured, must NOT be skipped silently
      run: async () => {
        ran = true;
        return { items: 0, errors: [] };
      },
    };
    const sum = await runIntegrationSync({ syncSteps: [step] }, base, deps, { now: () => at });
    expect(ran).toBe(false);
    expect(sum.status).toBe('partial');
    expect(sum.errors).toContain("per-source step 'orders' has no sources()");
  });

  it('skips disabled steps', async () => {
    const { repos, base, deps } = setup();
    let ran = false;
    const step: SyncStep<Record<string, never>> = {
      entity: 'products',
      cursorScope: 'global',
      enabled: () => false,
      run: async () => {
        ran = true;
        return { items: 0, errors: [] };
      },
    };
    await runIntegrationSync({ syncSteps: [step] }, base, deps, { now: () => at });
    expect(ran).toBe(false);
  });

  it('captures a step exception as an error (partial run, no crash)', async () => {
    const { repos, base, deps } = setup();
    const step: SyncStep<Record<string, never>> = {
      entity: 'loyalty',
      cursorScope: 'global',
      enabled: () => true,
      run: async () => {
        throw new Error('boom');
      },
    };
    const sum = await runIntegrationSync({ syncSteps: [step] }, base, deps, { now: () => at });
    expect(sum.status).toBe('partial');
    expect(sum.errors[0]).toContain('boom');
    // The thrown step records a failure row (not advanced) for observability.
    const row = repos.cursors.get('inst', 'loyalty', '');
    expect(row?.last_status).toBe('error');
    expect(row?.last_error).toContain('boom');
  });

  it('HOLDS the cursor when a push reports rejections (no silent data loss)', async () => {
    const { repos, base, deps } = setup();
    const step: SyncStep<Record<string, never>> = {
      entity: 'products',
      cursorScope: 'global',
      enabled: () => true,
      run: async (ctx) => {
        // The push rejects 1 of 2 items; the step naively reports a clean run.
        await ctx.sendBulk(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (_c, items: any[]) =>
            Promise.resolve({
              ok: true,
              statusCode: 200,
              data: { sent_count: items.length - 1, rejected_count: 1, rejected_items: [items[0]] },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any),
          [{ id: 1 }, { id: 2 }],
        );
        return { items: 2, errors: [], advanceCursorTo: at };
      },
    };
    const sum = await runIntegrationSync({ syncSteps: [step] }, base, deps, { now: () => at });
    // Even though the step returned no error, the rejection holds the cursor.
    expect(sum.status).toBe('partial');
    expect(sum.steps[0]?.rejected).toBe(1);
    const row = repos.cursors.get('inst', 'products', '');
    expect(row?.last_status).toBe('error');
    expect(row?.last_synced_at).toBeNull();
  });

  it('tolerateRejects advances the cursor despite rejections (still surfaced)', async () => {
    const { repos, base, deps } = setup();
    const step: SyncStep<Record<string, never>> = {
      entity: 'products',
      cursorScope: 'global',
      tolerateRejects: true,
      enabled: () => true,
      run: async (ctx) => {
        await ctx.sendBulk(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (_c, items: any[]) =>
            Promise.resolve({
              ok: true,
              statusCode: 200,
              data: { sent_count: items.length - 1, rejected_count: 1, rejected_items: [items[0]] },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any),
          [{ id: 1 }, { id: 2 }],
        );
        return { items: 2, errors: [], advanceCursorTo: at };
      },
    };
    const sum = await runIntegrationSync({ syncSteps: [step] }, base, deps, { now: () => at });
    // Poison-pill escape hatch: the cursor advances, but the rejection is still counted.
    expect(sum.status).toBe('ok');
    expect(sum.steps[0]?.rejected).toBe(1);
    expect(repos.cursors.get('inst', 'products', '')?.last_synced_at).toBe(at.toISOString());
  });

  it('tolerateRejects does NOT tolerate transport failures (failed -> cursor held)', async () => {
    const { repos, base, deps } = setup();
    const step: SyncStep<Record<string, never>> = {
      entity: 'products',
      cursorScope: 'global',
      tolerateRejects: true, // tolerates validation rejects — but never transport failures
      enabled: () => true,
      run: async (ctx) => {
        await ctx.sendBulk(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (_c, items: any[]) =>
            Promise.resolve({
              ok: true,
              statusCode: 200,
              data: { sent_count: items.length - 1, rejected_count: 0, failed_count: 1 },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any),
          [{ id: 1 }, { id: 2 }],
        );
        return { items: 2, errors: [], advanceCursorTo: at };
      },
    };
    const sum = await runIntegrationSync({ syncSteps: [step] }, base, deps, { now: () => at });
    // The push throws (transport) -> step error -> cursor NOT advanced despite tolerateRejects.
    expect(sum.status).toBe('partial');
    expect(repos.cursors.get('inst', 'products', '')?.last_synced_at).toBeNull();
  });
});

describe('computeWindow', () => {
  it('backfills on the first run', () => {
    const w = computeWindow(null, { now: () => at, full: false, backfillDays: 30 });
    expect(w.until).toEqual(at);
    expect(w.since?.toISOString()).toBe('2026-05-22T00:00:00.000Z');
  });

  it('is incremental from the cursor', () => {
    const w = computeWindow('2026-06-10T00:00:00.000Z', { now: () => at, full: false, backfillDays: 30 });
    expect(w.since?.toISOString()).toBe('2026-06-10T00:00:00.000Z');
  });
});
