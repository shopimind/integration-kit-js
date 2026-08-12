import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createIntegrationApp } from './create-app.js';
import { buildHealthReport } from './health.js';
import { defineIntegration } from '../integration/define-integration.js';
import { createLogger } from '../logging/logger.js';
import { makeStubSpmClient } from '../testing/harness.js';
import { createSqliteStore } from '../store/sqlite/index.js';
import { createRepositories } from '../store/repositories.js';
import { SecretCipher } from '../security/crypto.js';
import type { Integration } from '../integration/types.js';
import type { IntegrationStore } from '../store/port.js';

/**
 * Failure-path behaviour of the runtime: what happens when the store is broken,
 * when a shutdown lands mid-sync, and when the configuration is wrong. These are
 * the paths that only show up in production, so they are pinned here.
 */

type S = { ok: boolean };
const base = {
  slug: 'resilience',
  meta: { name: 'Resilience', version: '1.0.0' },
  configSchema: { fields: [{ key: 'token', type: 'password' as const, sensitive: true, label: { fr: 'T' } }] },
  parseSettings: (): S => ({ ok: true }),
  testConnection: async (): Promise<boolean> => true,
};
const integration: Integration<S> = defineIntegration({ ...base, syncSteps: [] });

const appOpts = {
  webhookSecret: 'whsec',
  credentialsKey: randomBytes(32).toString('hex'),
  makeSpmClient: () => makeStubSpmClient(),
  autoBackfillOnActivate: false,
  autoSync: false,
  logger: createLogger({ sink: () => {} }),
};

describe('configuration is validated before the store is touched', () => {
  it('a bad credentialsKey fails BEFORE migrate() runs (the store stays untouched)', async () => {
    let migrated = 0;
    const store = { migrate: async () => void migrated++, close: async () => {}, ping: async () => {} } as unknown as IntegrationStore;
    await expect(
      createIntegrationApp(integration, { ...appOpts, store, credentialsKey: 'too-short' }),
    ).rejects.toThrow();
    // The migration can rewrite data and is not reversible: a boot doomed by a
    // config typo must not have converted anything.
    expect(migrated).toBe(0);
  });

  it('an empty webhookSecret is refused at construction', async () => {
    const store = await createSqliteStore({ path: ':memory:' });
    await expect(createIntegrationApp(integration, { ...appOpts, store, webhookSecret: '' })).rejects.toThrow(/webhookSecret/);
    await expect(createIntegrationApp(integration, { ...appOpts, store, webhookSecret: [] })).rejects.toThrow(/webhookSecret/);
    await store.close();
  });

  it('requires exactly one of store / databasePath', async () => {
    await expect(createIntegrationApp(integration, { ...appOpts } as never)).rejects.toThrow(/persistence backend is required/);
    const store = await createSqliteStore({ path: ':memory:' });
    await expect(
      createIntegrationApp(integration, { ...appOpts, store, databasePath: ':memory:' }),
    ).rejects.toThrow(/not both/);
    await store.close();
  });
});

describe('/health always answers, even when the store misbehaves', () => {
  it('reports db:error (not a throw) when a query fails AFTER a successful ping', async () => {
    // `SELECT 1` can pass while the kit's own tables are unreachable: revoked
    // grants, dropped schema, failover to a standby mid-DDL.
    const store = {
      ping: async () => {},
      installs: {
        listActive: async () => {
          throw new Error('permission denied for table installs');
        },
      },
      cursors: { countInError: async () => 0 },
      runs: { recent: async () => [] },
    } as unknown as IntegrationStore;
    const repos = createRepositories(store, new SecretCipher({ key: 'a'.repeat(64), production: true }));
    const report = await buildHealthReport(store, repos, Date.now());
    expect(report.status).toBe('degraded');
    expect(report.db).toBe('error');
  });

  it('reports db:error when the ping itself fails', async () => {
    const store = {
      ping: async () => {
        throw new Error('connection refused');
      },
    } as unknown as IntegrationStore;
    const repos = createRepositories(store, new SecretCipher({ key: 'a'.repeat(64), production: true }));
    const report = await buildHealthReport(store, repos, Date.now());
    expect(report.db).toBe('error');
    expect(report.installations).toEqual([]);
  });
});

describe('stop() drains in-flight syncs before closing the store', () => {
  it('waits for a running sync, and refuses to start new ones while stopping', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let finished = false;
    const slow: Integration<S> = defineIntegration({
      ...base,
      slug: 'slow',
      syncSteps: [
        {
          entity: 'x',
          cursorScope: 'global',
          enabled: () => true,
          run: async () => {
            await gate;
            finished = true;
            return { items: 0, errors: [] };
          },
        },
      ],
    });
    const store = await createSqliteStore({ path: ':memory:' });
    const app = await createIntegrationApp(slow, { ...appOpts, store });
    await app.repos.installs.upsert({ installation_id: 'i1', status: 'active' });
    await app.repos.state.setSecret('i1', '__access_token', 'int_T');

    const syncing = app.runSyncOnce('i1');
    await new Promise((r) => setImmediate(r)); // let the step reach the gate

    const stopping = app.stop();
    // A late call must be refused while shutting down rather than racing the close.
    expect(await app.runSyncOnce('i1')).toBe(null);
    expect(finished).toBe(false); // stop() has not closed anything yet — it is draining

    release();
    await syncing;
    await stopping;
    expect(finished).toBe(true);
    // The run was recorded before the store closed (no row stuck in 'running').
    expect(() => store.db.prepare('SELECT 1').get()).toThrow(); // store really is closed
  });

  it('does not hang forever on a wedged sync (bounded drain)', async () => {
    const wedged: Integration<S> = defineIntegration({
      ...base,
      slug: 'wedged',
      syncSteps: [
        { entity: 'x', cursorScope: 'global', enabled: () => true, run: () => new Promise(() => {}) },
      ],
    });
    const store = await createSqliteStore({ path: ':memory:' });
    const app = await createIntegrationApp(wedged, { ...appOpts, store, stopDrainTimeoutMs: 150 });
    await app.repos.installs.upsert({ installation_id: 'i1', status: 'active' });
    await app.repos.state.setSecret('i1', '__access_token', 'int_T');
    void app.runSyncOnce('i1');
    await new Promise((r) => setImmediate(r));

    const t0 = Date.now();
    await app.stop(); // must return despite the never-resolving step
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});
