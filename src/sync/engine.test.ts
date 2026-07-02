import { describe, it, expect } from 'vitest';
import { openDatabase } from '../store/db.js';
import { createRepositories } from '../store/repositories.js';
import { SecretCipher } from '../security/crypto.js';
import { createLogger, type LogLine } from '../logging/logger.js';
import { runIntegrationSync, computeWindow, backoffWindowMs, rejectsTolerated } from './engine.js';
import { makeWithSource } from '../sdk/source-scope.js';
import { makeCustomData } from '../sdk/custom-data-scope.js';
import { makeSendBulk, type SendBulk } from '../sdk/send-bulk.js';
import { PROVISIONING_KEY } from '../lifecycle/dispatcher.js';
import type { IntegrationContext, SyncStep } from '../integration/types.js';

const cipher = new SecretCipher({ key: 'c'.repeat(64) });
const at = new Date('2026-06-21T00:00:00.000Z');

function setup(sink: (line: LogLine) => void = () => {}) {
  const repos = createRepositories(openDatabase(':memory:'), cipher);
  const logger = createLogger({ sink });
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
    rejectedItems: repos.rejectedItems,
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

describe('runIntegrationSync - E2 "silent step" warning', () => {
  it('warns when a clean step returns no advanceCursorTo (forgotten advance)', async () => {
    const lines: LogLine[] = [];
    const { base, deps } = setup((l) => lines.push(l));
    const step: SyncStep<Record<string, never>> = {
      entity: 'customers',
      cursorScope: 'global',
      enabled: () => true,
      // Clean run (no error) but NO advanceCursorTo -> the window can never move.
      run: async () => ({ items: 5, errors: [] }),
    };
    await runIntegrationSync({ syncSteps: [step] }, base, deps, { now: () => at });
    const warn = lines.find((l) => l.level === 'warn' && l.message.includes('without advanceCursorTo'));
    expect(warn).toBeDefined();
    expect(warn?.message).toContain("'customers'");
  });

  it('does NOT warn when a clean step advances the cursor', async () => {
    const lines: LogLine[] = [];
    const { base, deps } = setup((l) => lines.push(l));
    const step: SyncStep<Record<string, never>> = {
      entity: 'customers',
      cursorScope: 'global',
      enabled: () => true,
      run: async () => ({ items: 5, errors: [], advanceCursorTo: at }),
    };
    await runIntegrationSync({ syncSteps: [step] }, base, deps, { now: () => at });
    expect(lines.find((l) => l.message.includes('without advanceCursorTo'))).toBeUndefined();
  });

  it('does NOT warn when a step reports an error (the error, not the missing advance, is the signal)', async () => {
    const lines: LogLine[] = [];
    const { base, deps } = setup((l) => lines.push(l));
    const step: SyncStep<Record<string, never>> = {
      entity: 'customers',
      cursorScope: 'global',
      enabled: () => true,
      run: async () => ({ items: 0, errors: ['boom'] }),
    };
    await runIntegrationSync({ syncSteps: [step] }, base, deps, { now: () => at });
    expect(lines.find((l) => l.message.includes('without advanceCursorTo'))).toBeUndefined();
  });
});

describe('rejectsTolerated (E8)', () => {
  it('false/undefined never tolerates; true always tolerates', () => {
    expect(rejectsTolerated(undefined, 1, 10)).toBe(false);
    expect(rejectsTolerated(false, 1, 10)).toBe(false);
    expect(rejectsTolerated(true, 5, 5)).toBe(true);
  });

  it('{ maxRatio } tolerates within budget, holds beyond it', () => {
    // 1 rejected of 10 attempted (9 accepted + 1 rejected) -> ratio 0.1
    expect(rejectsTolerated({ maxRatio: 0.2 }, 1, 9)).toBe(true);
    // 5 rejected of 10 attempted -> ratio 0.5 > 0.2 -> hold
    expect(rejectsTolerated({ maxRatio: 0.2 }, 5, 5)).toBe(false);
    // exactly at the boundary -> tolerated (<=)
    expect(rejectsTolerated({ maxRatio: 0.5 }, 5, 5)).toBe(true);
  });
});

describe('runIntegrationSync - E8 tolerateRejects ratio', () => {
  const rejectingStep = (rejectCount: number, accepted: number, policy: boolean | { maxRatio: number }): SyncStep<Record<string, never>> => ({
    entity: 'products',
    cursorScope: 'global',
    tolerateRejects: policy,
    enabled: () => true,
    run: async (ctx) => {
      const total = rejectCount + accepted;
      await ctx.sendBulk(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (_c, items: any[]) =>
          Promise.resolve({
            ok: true,
            statusCode: 200,
            data: { sent_count: accepted, rejected_count: rejectCount, rejected_items: items.slice(0, rejectCount) },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any),
        Array.from({ length: total }, (_v, i) => ({ id: i })),
      );
      return { items: accepted, errors: [], advanceCursorTo: at };
    },
  });

  it('advances when the reject ratio is within maxRatio', async () => {
    const { repos, base, deps } = setup();
    const sum = await runIntegrationSync({ syncSteps: [rejectingStep(1, 9, { maxRatio: 0.2 })] }, base, deps, { now: () => at });
    expect(sum.status).toBe('ok');
    expect(repos.cursors.get('inst', 'products', '')?.last_synced_at).toBe(at.toISOString());
  });

  it('holds the cursor when the reject ratio exceeds maxRatio', async () => {
    const { repos, base, deps } = setup();
    const sum = await runIntegrationSync({ syncSteps: [rejectingStep(5, 5, { maxRatio: 0.2 })] }, base, deps, { now: () => at });
    expect(sum.status).toBe('partial');
    expect(repos.cursors.get('inst', 'products', '')?.last_synced_at).toBeNull();
  });
});

describe('backoffWindowMs (E3)', () => {
  it('is 0 with no failures, then exponential (2^(k-1) minutes), capped at 24h', () => {
    expect(backoffWindowMs(0)).toBe(0);
    expect(backoffWindowMs(1)).toBe(60_000); // 1 min
    expect(backoffWindowMs(2)).toBe(120_000); // 2 min
    expect(backoffWindowMs(3)).toBe(240_000); // 4 min
    expect(backoffWindowMs(100)).toBe(24 * 60 * 60_000); // capped at 24h
  });
});

describe('runIntegrationSync - E3 failure escalation & backoff', () => {
  it('counts consecutive failures and resets on a clean advance', async () => {
    const { repos, base, deps } = setup();
    const failing: SyncStep<Record<string, never>> = {
      entity: 'orders',
      cursorScope: 'global',
      enabled: () => true,
      run: async () => ({ items: 0, errors: ['boom'] }),
    };
    // Force `full` so backoff never skips (we want the step to actually run each time).
    await runIntegrationSync({ syncSteps: [failing] }, base, deps, { now: () => at, fullBackfill: true });
    expect(repos.cursors.get('inst', 'orders', '')?.consecutive_failures).toBe(1);
    await runIntegrationSync({ syncSteps: [failing] }, base, deps, { now: () => at, fullBackfill: true });
    expect(repos.cursors.get('inst', 'orders', '')?.consecutive_failures).toBe(2);

    const clean: SyncStep<Record<string, never>> = {
      entity: 'orders',
      cursorScope: 'global',
      enabled: () => true,
      run: async () => ({ items: 3, errors: [], advanceCursorTo: at }),
    };
    await runIntegrationSync({ syncSteps: [clean] }, base, deps, { now: () => at, fullBackfill: true });
    expect(repos.cursors.get('inst', 'orders', '')?.consecutive_failures).toBe(0);
  });

  it('logs ERROR at the 3rd consecutive failure', async () => {
    const lines: LogLine[] = [];
    const { base, deps } = setup((l) => lines.push(l));
    const failing: SyncStep<Record<string, never>> = {
      entity: 'orders',
      cursorScope: 'global',
      enabled: () => true,
      run: async () => ({ items: 0, errors: ['boom'] }),
    };
    for (let i = 0; i < 2; i += 1) {
      lines.length = 0;
      await runIntegrationSync({ syncSteps: [failing] }, base, deps, { now: () => at, fullBackfill: true });
    }
    // 1st and 2nd failures: no ERROR escalation yet.
    expect(lines.find((l) => l.level === 'error' && l.message.includes('failing repeatedly'))).toBeUndefined();
    lines.length = 0;
    await runIntegrationSync({ syncSteps: [failing] }, base, deps, { now: () => at, fullBackfill: true });
    // 3rd failure escalates to ERROR.
    expect(lines.find((l) => l.level === 'error' && l.message.includes('failing repeatedly'))).toBeDefined();
  });

  it('skips a step in backoff on an incremental tick (cursor untouched)', async () => {
    const { repos, base, deps } = setup();
    let ran = 0;
    const failing: SyncStep<Record<string, never>> = {
      entity: 'orders',
      cursorScope: 'global',
      enabled: () => true,
      run: async () => {
        ran += 1;
        return { items: 0, errors: ['boom'] };
      },
    };
    const clock = () => new Date(Date.now()); // real time ~ the cursor's updated_at
    // First tick: the step fails (consecutive_failures -> 1, updated_at ~ now).
    await runIntegrationSync({ syncSteps: [failing] }, base, deps, { now: clock });
    expect(ran).toBe(1);
    // Second tick immediately after (well within the 1-minute backoff): SKIPPED.
    const sum = await runIntegrationSync({ syncSteps: [failing] }, base, deps, { now: clock });
    expect(ran).toBe(1); // not re-run
    expect(sum.steps[0]?.skippedBackoff).toBe(true);
    // Cursor untouched: still 1 failure, no error added to the run.
    expect(repos.cursors.get('inst', 'orders', '')?.consecutive_failures).toBe(1);
    expect(sum.errors).toHaveLength(0);
  });
});

describe('runIntegrationSync - E4 dead-letter of rejects', () => {
  it('records rejected items to the dead-letter sink (bounded per run)', async () => {
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
              data: { sent_count: items.length - 2, rejected_count: 2, rejected_items: [items[0], items[1]] },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any),
          [{ id: 1 }, { id: 2 }, { id: 3 }],
        );
        return { items: 3, errors: [], advanceCursorTo: at };
      },
    };
    const sum = await runIntegrationSync({ syncSteps: [step] }, base, deps, { now: () => at });
    const dead = repos.rejectedItems.listByInstallation('inst');
    expect(dead).toHaveLength(2);
    expect(dead[0]?.entity).toBe('products');
    expect(dead[0]?.run_id).toBe(sum.runId);
    expect(JSON.parse(dead[1]?.payload_json ?? '{}')).toHaveProperty('id');
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

  it('E9: applies overlapSeconds to an incremental window (shifts since back)', () => {
    const w = computeWindow('2026-06-10T00:00:00.000Z', { now: () => at, full: false, backfillDays: 30, overlapSeconds: 120 });
    expect(w.since?.toISOString()).toBe('2026-06-09T23:58:00.000Z'); // 2 minutes earlier
  });

  it('E9: does NOT shift a backfill window', () => {
    const w = computeWindow(null, { now: () => at, full: false, backfillDays: 30, overlapSeconds: 120 });
    expect(w.since?.toISOString()).toBe('2026-05-22T00:00:00.000Z'); // unchanged backfill start
  });
});
