import { describe, it, expect } from 'vitest';
import { makeTestApp } from '../testing/harness.js';
import { defineIntegration } from '../integration/define-integration.js';
import { createIntegrationApp } from './create-app.js';
import { createLogger } from '../logging/logger.js';
import { signShopimindBody } from '../security/signature.js';
import { randomBytes } from 'node:crypto';
import type { Integration } from '../integration/types.js';

type S = { ok: boolean };

const integration: Integration<S> = defineIntegration({
  slug: 'demo',
  meta: { name: 'Demo', version: '1.0.0' },
  configSchema: { fields: [{ key: 'token', type: 'password', sensitive: true, label: { fr: 'T' } }] },
  parseSettings: () => ({ ok: true }),
  testConnection: async () => true,
  syncSteps: [],
});

describe('HTTP runtime (server.inject)', () => {
  it('GET /health -> 200 (status ok)', async () => {
    const app = makeTestApp(integration);
    const res = await app.server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    // E5 enriched the shape; the coarse contract remains `status: 'ok'` on a healthy probe.
    expect(JSON.parse(res.payload).status).toBe('ok');
    await app.stop();
  });

  it('POST /webhook/receive (signed) -> 200 + install persisted', async () => {
    const app = makeTestApp(integration);
    const { body, headers } = app.signWebhook({
      event: 'integration.installed',
      id_shop_integration: 1,
      access_token: 'int_T',
      configs: { token: 'SECRET' },
    });
    const res = await app.server.inject({ method: 'POST', url: '/webhook/receive', payload: body, headers });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).success).toBe(true);
    expect(app.repos.installs.find('1')?.status).toBe('inactive');
    await app.stop();
  });

  it('POST /webhook/receive (bad signature) -> 401', async () => {
    const app = makeTestApp(integration);
    const res = await app.server.inject({
      method: 'POST',
      url: '/webhook/receive',
      payload: JSON.stringify({ event: 'integration.installed', id_shop_integration: 1 }),
      headers: { 'content-type': 'application/json', 'x-shopimind-timestamp': '1700000000', 'x-shopimind-signature': 'bad' },
    });
    expect(res.statusCode).toBe(401);
    await app.stop();
  });

  it('POST /admin/sync/1 without token -> 401', async () => {
    const app = makeTestApp(integration);
    const res = await app.server.inject({ method: 'POST', url: '/admin/sync/1' });
    expect(res.statusCode).toBe(401);
    await app.stop();
  });

  it('POST /webhook/test-connection (signed) -> success', async () => {
    const app = makeTestApp(integration);
    const { body, headers } = app.signWebhook({ account: 'x' });
    const res = await app.server.inject({ method: 'POST', url: '/webhook/test-connection', payload: body, headers });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).success).toBe(true);
    await app.stop();
  });

  it('GET /health enriched -> 200 { status: ok } with DB ping + counters', async () => {
    const app = makeTestApp(integration);
    const res = await app.server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
    expect(body).toHaveProperty('cursors_in_error', 0);
    expect(body).toHaveProperty('active_installations');
    await app.stop();
  });

  it('GET /admin/overview requires the admin token, returns JSON synthesis', async () => {
    const app = createIntegrationApp(integration, {
      databasePath: ':memory:',
      webhookSecret: 'whsec',
      credentialsKey: randomBytes(32).toString('hex'),
      adminToken: 'admintok',
      autoBackfillOnActivate: false,
      autoSync: false,
      logger: createLogger({ sink: () => {} }),
    });
    const noAuth = await app.server.inject({ method: 'GET', url: '/admin/overview' });
    expect(noAuth.statusCode).toBe(401);
    const ok = await app.server.inject({ method: 'GET', url: '/admin/overview', headers: { 'x-admin-token': 'admintok' } });
    expect(ok.statusCode).toBe(200);
    const body = JSON.parse(ok.payload);
    expect(body).toHaveProperty('installations');
    expect(body).toHaveProperty('recent_webhooks');
    await app.stop();
  });

  it('GET /admin/installations/{id}/rejected returns dead-lettered items (E4, admin)', async () => {
    const app = createIntegrationApp(integration, {
      databasePath: ':memory:',
      webhookSecret: 'whsec',
      credentialsKey: randomBytes(32).toString('hex'),
      adminToken: 'admintok',
      autoBackfillOnActivate: false,
      autoSync: false,
      logger: createLogger({ sink: () => {} }),
    });
    app.repos.rejectedItems.add({ installation_id: 'inst1', run_id: 7, entity: 'orders', payload_json: '{"id":1}', reason: 'bad' });
    const noAuth = await app.server.inject({ method: 'GET', url: '/admin/installations/inst1/rejected' });
    expect(noAuth.statusCode).toBe(401);
    const ok = await app.server.inject({ method: 'GET', url: '/admin/installations/inst1/rejected', headers: { 'x-admin-token': 'admintok' } });
    expect(ok.statusCode).toBe(200);
    const body = JSON.parse(ok.payload);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].entity).toBe('orders');
    await app.stop();
  });

  it('E6: accepts a webhook signed with EITHER secret during a rotation window', async () => {
    const app = createIntegrationApp(integration, {
      databasePath: ':memory:',
      webhookSecret: ['old_secret', 'new_secret'], // rotation window
      credentialsKey: randomBytes(32).toString('hex'),
      autoBackfillOnActivate: false,
      autoSync: false,
      now: () => 1_700_000_000_000,
      logger: createLogger({ sink: () => {} }),
    });
    const ts = 1_700_000_000;
    const sign = (secret: string, payload: object): { body: string; headers: Record<string, string> } => {
      const body = JSON.stringify(payload);
      return {
        body,
        headers: {
          'content-type': 'application/json',
          'x-shopimind-timestamp': String(ts),
          'x-shopimind-signature': signShopimindBody(body, secret, ts),
        },
      };
    };
    const withOld = sign('old_secret', { event: 'integration.installed', installation_id: 'r1', access_token: 'int_T', configs: {} });
    const rOld = await app.server.inject({ method: 'POST', url: '/webhook/receive', payload: withOld.body, headers: withOld.headers });
    expect(rOld.statusCode).toBe(200);
    expect(JSON.parse(rOld.payload).success).toBe(true);

    const withNew = sign('new_secret', { event: 'integration.installed', installation_id: 'r2', access_token: 'int_T', configs: {} });
    const rNew = await app.server.inject({ method: 'POST', url: '/webhook/receive', payload: withNew.body, headers: withNew.headers });
    expect(JSON.parse(rNew.payload).success).toBe(true);

    const withBad = sign('unknown_secret', { event: 'integration.installed', installation_id: 'r3' });
    const rBad = await app.server.inject({ method: 'POST', url: '/webhook/receive', payload: withBad.body, headers: withBad.headers });
    expect(rBad.statusCode).toBe(401);
    await app.stop();
  });

  it('J4: adminPort moves the admin surface OFF the public listener', async () => {
    const token = 'a'.repeat(40);
    const app = createIntegrationApp(integration, {
      databasePath: ':memory:',
      webhookSecret: 'whsec',
      credentialsKey: randomBytes(32).toString('hex'),
      adminToken: token,
      adminPort: 9931,
      autoBackfillOnActivate: false,
      autoSync: false,
      logger: createLogger({ sink: () => {} }),
    });
    // Public server keeps /health but no longer answers /admin/* (moved to the admin listener).
    expect((await app.server.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const admin = await app.server.inject({ method: 'GET', url: '/admin/meta', headers: { 'x-admin-token': token } });
    expect(admin.statusCode).toBe(404);
    // …and the dedicated admin listener IS where /admin now lives and answers.
    expect(app.adminServer).toBeDefined();
    const onAdmin = await app.adminServer!.inject({ method: 'GET', url: '/admin/meta', headers: { 'x-admin-token': token } });
    expect(onAdmin.statusCode).toBe(200);
    await app.stop();
  });

  it('J4: single-listener (default) keeps /admin on the public server', async () => {
    const token = 'a'.repeat(40);
    const app = makeTestApp(integration, { adminToken: token });
    const admin = await app.server.inject({ method: 'GET', url: '/admin/meta', headers: { 'x-admin-token': token } });
    expect(admin.statusCode).toBe(200);
    await app.stop();
  });

  it('J4: adminSecureCookie marks the session cookie Secure', async () => {
    const token = 'a'.repeat(40);
    const app = createIntegrationApp(integration, {
      databasePath: ':memory:',
      webhookSecret: 'whsec',
      credentialsKey: randomBytes(32).toString('hex'),
      adminToken: token,
      adminSecureCookie: true,
      autoBackfillOnActivate: false,
      autoSync: false,
      logger: createLogger({ sink: () => {} }),
    });
    const res = await app.server.inject({ method: 'POST', url: '/admin/session', payload: JSON.stringify({ token }) });
    expect(res.statusCode).toBe(200);
    expect(String((res.headers['set-cookie'] as string[])[0])).toContain('Secure');
    await app.stop();
  });

  it('reprovision refuses (busy) while a sync holds the per-installation lock', async () => {
    const token = 'a'.repeat(40);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const c = defineIntegration({
      slug: 'demo-repro',
      meta: { name: 'Repro', version: '1.0.0' },
      configSchema: { fields: [{ key: 'token', type: 'password', sensitive: true, label: { fr: 'T' } }] },
      parseSettings: () => ({ ok: true }),
      testConnection: async () => true,
      provisioning: () => ({ dataSources: [] }),
      syncSteps: [
        { entity: 'x', cursorScope: 'global', enabled: () => true, run: async () => { await gate; return { items: 0, errors: [] }; } },
      ],
    });
    const app = makeTestApp(c, { adminToken: token });
    app.repos.installs.upsert({ installation_id: '1', status: 'active' });
    app.repos.state.setSecret('1', '__access_token', 'int_T');

    const syncing = app.runSyncOnce('1', { full: false }); // holds the lock (step awaits the gate)
    const res = await app.server.inject({ method: 'POST', url: '/admin/installations/1/reprovision', headers: { 'x-admin-token': token } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toContain('busy');
    release();
    await syncing;
    await app.stop();
  });

  it('runSyncOnce: per-installation overlap lock', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let runs = 0;
    const c = defineIntegration({
      slug: 'demo-lock',
      meta: { name: 'DemoLock', version: '1.0.0' },
      configSchema: { fields: [{ key: 'token', type: 'password', sensitive: true, label: { fr: 'T' } }] },
      parseSettings: () => ({ ok: true }),
      testConnection: async () => true,
      syncSteps: [
        {
          entity: 'x',
          cursorScope: 'global',
          enabled: () => true,
          run: async () => { runs += 1; await gate; return { items: 0, errors: [] }; },
        },
      ],
    });
    const app = makeTestApp(c);
    const { body, headers } = app.signWebhook({
      event: 'integration.activated',
      id_shop_integration: 1,
      access_token: 'int_T',
      configs: { token: 'S' },
    });
    await app.server.inject({ method: 'POST', url: '/webhook/receive', payload: body, headers });

    const p1 = app.runSyncOnce('1', { full: false });
    const p2 = app.runSyncOnce('1', { full: false });
    release();
    const results = await Promise.all([p1, p2]);
    expect(runs).toBe(1); // only one run actually started
    expect(results.filter((r) => r === null)).toHaveLength(1); // the other was skipped (lock)
    await app.stop();
  });
});
