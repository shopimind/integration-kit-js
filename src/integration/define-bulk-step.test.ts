import { describe, it, expect } from 'vitest';
import { createSqliteStore } from '../store/sqlite/index.js';
import { createRepositories } from '../store/repositories.js';
import { SecretCipher } from '../security/crypto.js';
import { createLogger } from '../logging/logger.js';
import { runIntegrationSync } from '../sync/engine.js';
import { makeWithSource } from '../sdk/source-scope.js';
import { makeCustomData } from '../sdk/custom-data-scope.js';
import { makeSendBulk, type SendBulk } from '../sdk/send-bulk.js';
import { defineBulkStep } from './define-bulk-step.js';
import type { IntegrationContext } from './types.js';

const cipher = new SecretCipher({ key: 'd'.repeat(64) });
const at = new Date('2026-06-21T00:00:00.000Z');

const makeStore = async () => {
  const s = await createSqliteStore({ path: ':memory:' });
  await s.migrate();
  return s;
};

async function setup() {
  const repos = createRepositories(await makeStore(), cipher);
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
    setExternalAccount: async () => {},
    inboundSecret: '',
    withSource: () => { throw new Error('n/a'); },
    customData: () => { throw new Error('n/a'); },
  };
  const deps = {
    cursors: repos.cursors,
    runs: repos.runs,
    // No provisioning blob here: no step in these tests resolves a source/definition.
    makeSource: (sb: SendBulk) => makeWithSource(null, sb),
    makeCustomData: (sb: SendBulk) => makeCustomData(null, sb, spm),
    rejectedItems: repos.rejectedItems,
  };
  return { repos, base, deps };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const okPush = (_c: any, items: any[]) =>
  Promise.resolve({ ok: true, statusCode: 200, data: { sent_count: items.length, rejected_count: 0, rejected_items: [] } } as any);

describe('defineBulkStep', () => {
  it('batches/flushes, counts items, and advances the cursor to window.until by default', async () => {
    const { repos, base, deps } = await setup();
    const pushed: number[] = [];
    const step = defineBulkStep<Record<string, never>, number, { id: number }>({
      entity: 'products',
      batchSize: 2,
      stream: async function* () {
        yield 1; yield 2; yield 3;
      },
      map: (n) => ({ id: n }),
      push: async (ctx, records) => {
        pushed.push(records.length);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return ctx.sendBulk(okPush as any, records);
      },
    });
    const sum = await runIntegrationSync({ syncSteps: [step] }, base, deps, { now: () => at });
    expect(sum.status).toBe('ok');
    expect(sum.steps[0]?.items).toBe(3);
    expect(pushed).toEqual([2, 1]); // batches of 2 then the remaining 1
    expect((await repos.cursors.get('inst', 'products', ''))?.last_synced_at).toBe(at.toISOString());
  });

  it('skips items when map returns null', async () => {
    const { base, deps } = await setup();
    const step = defineBulkStep<Record<string, never>, number, { id: number }>({
      entity: 'products',
      stream: async function* () { yield 1; yield 2; yield 3; },
      map: (n) => (n === 2 ? null : { id: n }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      push: async (ctx, records) => ctx.sendBulk(okPush as any, records),
    });
    const sum = await runIntegrationSync({ syncSteps: [step] }, base, deps, { now: () => at });
    expect(sum.steps[0]?.items).toBe(2);
  });

  it('collects a stream/push error and HOLDS the cursor (no advance)', async () => {
    const { repos, base, deps } = await setup();
    const step = defineBulkStep<Record<string, never>, number, { id: number }>({
      entity: 'products',
      stream: async function* () { yield 1; throw new Error('stream boom'); },
      map: (n) => ({ id: n }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      push: async (ctx, records) => ctx.sendBulk(okPush as any, records),
    });
    const sum = await runIntegrationSync({ syncSteps: [step] }, base, deps, { now: () => at });
    expect(sum.status).toBe('partial');
    expect(sum.errors[0]).toContain('stream boom');
    expect((await repos.cursors.get('inst', 'products', ''))?.last_synced_at).toBeNull();
  });

  it('defaults enabled to true and cursorScope to global', () => {
    const step = defineBulkStep<Record<string, never>, number, number>({
      entity: 'x',
      stream: async function* () {},
      map: (n) => n,
      push: async () => ({ sent: 0, rejected: 0, rejected_items: [] }),
    });
    expect(step.cursorScope).toBe('global');
    expect(step.enabled({})).toBe(true);
  });
});
