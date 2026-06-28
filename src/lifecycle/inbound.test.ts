import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestApp, type TestApp } from '../testing/harness.js';
import type { Integration } from '../integration/types.js';

type S = Record<string, never>;

let received: unknown[] = [];
/** Counts how many times the always-failing handler actually ran (re-execution proof). */
let boomCount = 0;

const integration: Integration<S> = {
  slug: 'test-inbound',
  meta: { name: 'Test', version: '1.0.0' },
  configSchema: { fields: [] },
  parseSettings: () => ({}),
  testConnection: async () => true,
  syncSteps: [],
  inbound: {
    ping: async (_ctx, payload) => {
      received.push(payload);
    },
    boom: async () => {
      boomCount += 1;
      throw new Error('kaboom');
    },
  },
};

/** Activates an installation (stores the token -> buildContext OK + inbound secret generated). */
async function activate(app: TestApp, id: string): Promise<void> {
  const w = app.signWebhook({ event: 'integration.activated', installation_id: id, access_token: 'int_T', configs: {} });
  await app.server.inject({ method: 'POST', url: '/webhook/receive', payload: w.body, headers: w.headers });
}

describe('inbound routes (/inbound)', () => {
  let app: TestApp;
  beforeEach(async () => {
    received = [];
    boomCount = 0;
    app = makeTestApp(integration);
    await activate(app, 'inst1');
  });

  it('valid signed call -> handler executed -> 200', async () => {
    const i = app.signInbound('inst1', { hi: 1 });
    const res = await app.server.inject({ method: 'POST', url: '/inbound/ping', payload: i.body, headers: i.headers });
    expect(res.statusCode).toBe(200);
    expect(received).toEqual([{ hi: 1 }]);
  });

  it('bad signature -> 401', async () => {
    const i = app.signInbound('inst1', { hi: 1 });
    const res = await app.server.inject({
      method: 'POST',
      url: '/inbound/ping',
      payload: i.body,
      headers: { ...i.headers, 'x-integration-signature': 'deadbeef' },
    });
    expect(res.statusCode).toBe(401);
    expect(received).toEqual([]);
  });

  it('missing installation header -> 400', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/inbound/ping',
      payload: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('unknown installation (no secret) -> 401', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/inbound/ping',
      payload: '{}',
      headers: {
        'content-type': 'application/json',
        'x-integration-installation': 'nope',
        'x-integration-timestamp': '1700000000',
        'x-integration-signature': 'ab',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('unknown action -> 404', async () => {
    const i = app.signInbound('inst1', {});
    const res = await app.server.inject({ method: 'POST', url: '/inbound/nope', payload: i.body, headers: i.headers });
    expect(res.statusCode).toBe(404);
  });

  it('idempotency: a replay (same key) does not re-execute the handler', async () => {
    const i = app.signInbound('inst1', { n: 1 });
    const headers = { ...i.headers, 'x-idempotency-key': 'key-1' };
    const r1 = await app.server.inject({ method: 'POST', url: '/inbound/ping', payload: i.body, headers });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.server.inject({ method: 'POST', url: '/inbound/ping', payload: i.body, headers });
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r2.payload).replayed).toBe(true);
    expect(received).toEqual([{ n: 1 }]); // executed only once
  });

  it('MANDATORY anti-replay: same signed request replayed WITHOUT idempotency key -> executed only once', async () => {
    const i = app.signInbound('inst1', { n: 7 });
    const r1 = await app.server.inject({ method: 'POST', url: '/inbound/ping', payload: i.body, headers: i.headers });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.server.inject({ method: 'POST', url: '/inbound/ping', payload: i.body, headers: i.headers });
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r2.payload).replayed).toBe(true);
    expect(received).toEqual([{ n: 7 }]); // dedup derived from the signature, header absent
  });

  it('failing handler -> 500 (and marked failed for replay)', async () => {
    const i = app.signInbound('inst1', {});
    const res = await app.server.inject({ method: 'POST', url: '/inbound/boom', payload: i.body, headers: i.headers });
    expect(res.statusCode).toBe(500);
  });

  it('authenticated installation without a context (no access_token) -> 409 no_context', async () => {
    // 'inst2' is never activated: it has an inbound secret (created on the fly by
    // signInbound) so auth passes, but no __access_token -> buildContext() returns
    // null. The call is authenticated yet cannot be served right now.
    const i = app.signInbound('inst2', { hi: 1 });
    const res = await app.server.inject({ method: 'POST', url: '/inbound/ping', payload: i.body, headers: i.headers });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).error).toBe('no_context');
    expect(received).toEqual([]); // handler never ran
  });

  it('replay of a previously FAILED call re-executes the handler (claim non-fresh, status failed)', async () => {
    const i = app.signInbound('inst1', { n: 1 });
    const headers = { ...i.headers, 'x-idempotency-key': 'retry-1' };
    // First attempt: handler throws -> 500, attempt persisted 'failed'.
    const r1 = await app.server.inject({ method: 'POST', url: '/inbound/boom', payload: i.body, headers });
    expect(r1.statusCode).toBe(500);
    expect(boomCount).toBe(1);
    // Second attempt with the SAME dedup key: prior status is 'failed' (not 'done'),
    // so it is NOT short-circuited as a replay -> the handler runs AGAIN.
    const r2 = await app.server.inject({ method: 'POST', url: '/inbound/boom', payload: i.body, headers });
    expect(r2.statusCode).toBe(500);
    expect(boomCount).toBe(2); // re-executed, not deduped
    expect(JSON.parse(r2.payload).success).toBe(false);
  });
});
