import { describe, it, expect } from 'vitest';
import { makeTestApp } from '../testing/harness.js';
import { defineIntegration } from '../integration/define-integration.js';
import { createIntegrationApp } from './create-app.js';
import { createLogger } from '../logging/logger.js';
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

  it('GET /health enriched -> 200 { status: ok } with DB ping + counters (E5)', async () => {
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

  it('GET /admin/overview requires the admin token, returns JSON synthesis (E5)', async () => {
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
