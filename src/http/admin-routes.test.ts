import { describe, it, expect } from 'vitest';
import { makeTestApp } from '../testing/harness.js';
import { defineIntegration } from '../integration/define-integration.js';
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

const TOKEN = 'admintok';
const auth = { 'x-admin-token': TOKEN };

/** Every admin read endpoint refuses an unauthenticated request. */
describe('admin read endpoints — auth', () => {
  const paths = [
    '/admin/meta',
    '/admin/installations',
    '/admin/installations/x',
    '/admin/installations/x/cursors',
    '/admin/installations/x/runs',
    '/admin/installations/x/webhooks',
    '/admin/installations/x/inbound',
    '/admin/installations/x/state',
    '/admin/rejected',
    '/admin/audit',
  ];
  it('returns 401 without the admin token', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    for (const url of paths) {
      const res = await app.server.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
    await app.stop();
  });
});

describe('GET /admin/meta', () => {
  it('returns the dashboard synthesis with the token', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    app.repos.installs.upsert({ installation_id: 'a', status: 'active' });
    const res = await app.server.inject({ method: 'GET', url: '/admin/meta', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.installations.total).toBe(1);
    expect(body).toHaveProperty('kitVersion');
    expect(body).toHaveProperty('webhooks24h');
    expect(body.integration).toEqual({ name: 'Demo', slug: 'demo', version: '1.0.0' });
    await app.stop();
  });
});

describe('GET /admin/definition', () => {
  it('401 without token; returns the integration definition with the token', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    expect((await app.server.inject({ method: 'GET', url: '/admin/definition' })).statusCode).toBe(401);
    const res = await app.server.inject({ method: 'GET', url: '/admin/definition', headers: auth });
    expect(res.statusCode).toBe(200);
    const d = JSON.parse(res.payload);
    expect(d.slug).toBe('demo');
    expect(d.meta.name).toBe('Demo');
    expect(Array.isArray(d.syncSteps)).toBe(true);
    expect(d).toHaveProperty('capabilities');
    await app.stop();
  });
});

describe('GET /admin/installations + detail', () => {
  it('lists installations and returns an aggregate detail', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    app.repos.installs.upsert({ installation_id: 'a', shop_name: 'Alpha', status: 'active' });

    const list = await app.server.inject({ method: 'GET', url: '/admin/installations', headers: auth });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.payload).total).toBe(1);

    const detail = await app.server.inject({ method: 'GET', url: '/admin/installations/a', headers: auth });
    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload).install.shop_name).toBe('Alpha');
    await app.stop();
  });

  it('returns 404 for an unknown installation', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    const res = await app.server.inject({ method: 'GET', url: '/admin/installations/ghost', headers: auth });
    expect(res.statusCode).toBe(404);
    await app.stop();
  });
});

describe('GET /admin/installations/{id}/state — SECURITY', () => {
  it('exposes state metadata but NEVER a secret value', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    app.repos.installs.upsert({ installation_id: 'a', status: 'active' });
    app.repos.state.set('a', 'pref', 'fr');
    app.repos.state.setSecret('a', 'api_key', 'S3CR3T-do-not-leak');

    const res = await app.server.inject({ method: 'GET', url: '/admin/installations/a/state', headers: auth });
    expect(res.statusCode).toBe(200);
    // The raw secret must appear NOWHERE in the response payload.
    expect(res.payload).not.toContain('S3CR3T-do-not-leak');
    const items = JSON.parse(res.payload).items as Array<{ key: string; encrypted: number; value_preview: string | null }>;
    const secret = items.find((i) => i.key === 'api_key');
    expect(secret?.encrypted).toBe(1);
    expect(secret?.value_preview).toBeNull();
    await app.stop();
  });
});

describe('GET /admin/installations/{id}/webhooks — PII masking', () => {
  it('masks emails/phones in the returned payloads', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    app.repos.installs.upsert({ installation_id: 'a', status: 'active' });
    app.repos.webhookLog.log({
      event: 'installed',
      installation_id: 'a',
      signature_ok: true,
      payload_json: '{"email":"buyer@shop.com"}',
    });
    const res = await app.server.inject({ method: 'GET', url: '/admin/installations/a/webhooks', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('buyer@shop.com');
    expect(res.payload).toContain('b•••@•••.com');
    await app.stop();
  });
});

describe('GET /admin/rejected — global dead-letter (masked)', () => {
  it('lists rejected items across installations with PII masked', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    app.repos.rejectedItems.add({ installation_id: 'a', entity: 'customers', payload_json: '{"email":"x@y.io"}' });
    const res = await app.server.inject({ method: 'GET', url: '/admin/rejected', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.total).toBe(1);
    expect(res.payload).not.toContain('x@y.io');
    await app.stop();
  });
});

const sidFromSetCookie = (setCookie: string[] | undefined): string => {
  const raw = (setCookie ?? [])[0] ?? '';
  return raw.split(';')[0]?.split('=')[1] ?? '';
};

describe('GET /admin/ui — UI shell', () => {
  it('serves HTML with a per-request nonce CSP and no leftover placeholder', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    const res = await app.server.inject({ method: 'GET', url: '/admin/ui' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const csp = String(res.headers['content-security-policy'] ?? '');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    expect(res.payload).not.toContain('__CSP_NONCE__'); // every placeholder substituted
    await app.stop();
  });
});

describe('admin session flow (token -> cookie -> read -> logout)', () => {
  it('rejects a wrong token and issues a hardened cookie for the right one', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    const bad = await app.server.inject({ method: 'POST', url: '/admin/session', payload: JSON.stringify({ token: 'nope' }) });
    expect(bad.statusCode).toBe(401);

    const ok = await app.server.inject({ method: 'POST', url: '/admin/session', payload: JSON.stringify({ token: TOKEN }) });
    expect(ok.statusCode).toBe(200);
    const setCookie = ok.headers['set-cookie'] as string[] | undefined;
    expect(String(setCookie?.[0])).toContain('HttpOnly');
    expect(String(setCookie?.[0])).toContain('SameSite=Strict');
    expect(JSON.parse(ok.payload).csrf).toMatch(/^[0-9a-f]{64}$/);
    await app.stop();
  });

  it('a session cookie authorizes reads WITHOUT the raw token, and logout revokes it', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    app.repos.installs.upsert({ installation_id: 'a', status: 'active' });

    const login = await app.server.inject({ method: 'POST', url: '/admin/session', payload: JSON.stringify({ token: TOKEN }) });
    const sid = sidFromSetCookie(login.headers['set-cookie'] as string[] | undefined);
    expect(sid).toMatch(/^[0-9a-f]{64}$/);
    const cookie = `${'spm_admin_sid'}=${sid}`;

    // Read with the cookie only (no x-admin-token).
    const read = await app.server.inject({ method: 'GET', url: '/admin/meta', headers: { cookie } });
    expect(read.statusCode).toBe(200);

    // Logout, then the same cookie no longer authorizes.
    const out = await app.server.inject({ method: 'DELETE', url: '/admin/session', headers: { cookie } });
    expect(out.statusCode).toBe(200);
    const after = await app.server.inject({ method: 'GET', url: '/admin/meta', headers: { cookie } });
    expect(after.statusCode).toBe(401);
    await app.stop();
  });

  it('admin login is per-IP rate-limited (bounds token brute-forcing)', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    let saw429 = false;
    for (let i = 0; i < 15; i++) {
      const res = await app.server.inject({ method: 'POST', url: '/admin/session', payload: JSON.stringify({ token: 'wrong' }) });
      if (res.statusCode === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true); // the limiter kicks in before unbounded guessing
    await app.stop();
  });
});

const login = async (app: ReturnType<typeof makeTestApp>): Promise<{ cookie: string; csrf: string }> => {
  const res = await app.server.inject({ method: 'POST', url: '/admin/session', payload: JSON.stringify({ token: TOKEN }) });
  const sid = sidFromSetCookie(res.headers['set-cookie'] as string[] | undefined);
  return { cookie: `spm_admin_sid=${sid}`, csrf: JSON.parse(res.payload).csrf };
};

describe('admin mutations — auth, CSRF, audit, scoping', () => {
  it('POST /admin/sync: 401 unauth, 200 via token (no CSRF), and writes an audit entry', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    app.repos.installs.upsert({ installation_id: 'a', status: 'active' });
    expect((await app.server.inject({ method: 'POST', url: '/admin/sync/a' })).statusCode).toBe(401);
    const ok = await app.server.inject({ method: 'POST', url: '/admin/sync/a', headers: auth });
    expect(ok.statusCode).toBe(200);
    const audit = await app.server.inject({ method: 'GET', url: '/admin/audit', headers: auth });
    const actions = (JSON.parse(audit.payload).items as Array<{ action: string }>).map((i) => i.action);
    expect(actions).toContain('sync');
    await app.stop();
  });

  it('session mutations require a matching CSRF token (403 without, 200 with)', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    app.repos.installs.upsert({ installation_id: 'a', status: 'active' });
    const { cookie, csrf } = await login(app);
    const noCsrf = await app.server.inject({ method: 'POST', url: '/admin/sync/a', headers: { cookie } });
    expect(noCsrf.statusCode).toBe(403);
    const ok = await app.server.inject({ method: 'POST', url: '/admin/sync/a', headers: { cookie, 'x-csrf-token': csrf } });
    expect(ok.statusCode).toBe(200);
    await app.stop();
  });

  it('reveals a rejected item RAW payload (audited), 404 for unknown id', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    app.repos.rejectedItems.add({ installation_id: 'a', entity: 'customers', payload_json: '{"email":"real@x.io"}' });
    const id = app.repos.rejectedItems.list({ installationId: 'a', limit: 1, offset: 0 }).items[0]!.id;
    const res = await app.server.inject({ method: 'POST', url: `/admin/rejected/${id}/reveal`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('real@x.io'); // raw + audited
    expect((await app.server.inject({ method: 'POST', url: '/admin/rejected/999999/reveal', headers: auth })).statusCode).toBe(404);
    // The reveal is recorded in the audit trail.
    const audit = await app.server.inject({ method: 'GET', url: '/admin/audit', headers: auth });
    expect((JSON.parse(audit.payload).items as Array<{ action: string }>).map((i) => i.action)).toContain('rejected.reveal');
    await app.stop();
  });

  it('webhook reveal is SCOPED to the installation (404 on mismatch)', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    app.repos.webhookLog.log({ event: 'installed', installation_id: 'a', signature_ok: true, payload_json: '{"y":9}' });
    const logId = app.repos.webhookLog.listByInstallation('a', { limit: 1, offset: 0 }).items[0]!.id;
    expect((await app.server.inject({ method: 'POST', url: `/admin/installations/a/webhook-log/${logId}/reveal`, headers: auth })).statusCode).toBe(200);
    expect((await app.server.inject({ method: 'POST', url: `/admin/installations/b/webhook-log/${logId}/reveal`, headers: auth })).statusCode).toBe(404);
    await app.stop();
  });

  it('purge deletes ONLY within the named installation', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    app.repos.rejectedItems.add({ installation_id: 'a', entity: 'orders', payload_json: '{}' });
    app.repos.rejectedItems.add({ installation_id: 'b', entity: 'orders', payload_json: '{}' });
    const bId = app.repos.rejectedItems.list({ installationId: 'b', limit: 1, offset: 0 }).items[0]!.id;
    const res = await app.server.inject({
      method: 'POST',
      url: '/admin/rejected/purge',
      headers: auth,
      payload: JSON.stringify({ installationId: 'a', ids: [bId] }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).removed).toBe(0); // cross-tenant no-op
    expect(app.repos.rejectedItems.count({ installationId: 'b' })).toBe(1);
    await app.stop();
  });
});

describe('admin — audited actions & masking end-to-end', () => {
  it('state over HTTP: large secret preview is NULL, large plaintext truncated to 200', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    app.repos.installs.upsert({ installation_id: 'a', status: 'active' });
    app.repos.state.set('a', 'big', 'z'.repeat(400));
    app.repos.state.setSecret('a', 'api_key', 'S'.repeat(400));
    const res = await app.server.inject({ method: 'GET', url: '/admin/installations/a/state', headers: auth });
    expect(res.statusCode).toBe(200);
    const items = JSON.parse(res.payload).items as Array<{ key: string; value_preview: string | null }>;
    expect(items.find((i) => i.key === 'big')?.value_preview?.length).toBe(200);
    expect(items.find((i) => i.key === 'api_key')?.value_preview).toBeNull();
    await app.stop();
  });

  it('webhook reveal returns RAW payload and is audited; the list stays masked', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    app.repos.installs.upsert({ installation_id: 'a', status: 'active' });
    app.repos.webhookLog.log({ event: 'installed', installation_id: 'a', signature_ok: true, payload_json: '{"email":"real@corp.io"}' });
    const logId = app.repos.webhookLog.listByInstallation('a', { limit: 1, offset: 0 }).items[0]!.id;
    const masked = await app.server.inject({ method: 'GET', url: '/admin/installations/a/webhooks', headers: auth });
    expect(masked.payload).not.toContain('real@corp.io');
    const revealed = await app.server.inject({ method: 'POST', url: `/admin/installations/a/webhook-log/${logId}/reveal`, headers: auth });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.payload).toContain('real@corp.io');
    const audit = await app.server.inject({ method: 'GET', url: '/admin/audit', headers: auth });
    expect((JSON.parse(audit.payload).items as Array<{ action: string }>).map((i) => i.action)).toContain('webhook.reveal');
    await app.stop();
  });

  it('purge is audited with {requested, removed}', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    app.repos.rejectedItems.add({ installation_id: 'a', entity: 'orders', payload_json: '{}' });
    const id = app.repos.rejectedItems.list({ installationId: 'a', limit: 1, offset: 0 }).items[0]!.id;
    const purge = await app.server.inject({ method: 'POST', url: '/admin/rejected/purge', headers: auth, payload: JSON.stringify({ installationId: 'a', ids: [id] }) });
    expect(JSON.parse(purge.payload).removed).toBe(1);
    const audit = await app.server.inject({ method: 'GET', url: '/admin/audit', headers: auth });
    const entry = (JSON.parse(audit.payload).items as Array<{ action: string; details_json: string | null }>).find((i) => i.action === 'rejected.purge');
    expect(JSON.parse(entry?.details_json ?? '{}')).toMatchObject({ requested: 1, removed: 1 });
    await app.stop();
  });

  it('reprovision returns an outcome and is audited', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    app.repos.installs.upsert({ installation_id: 'a', status: 'active' });
    app.repos.state.setSecret('a', '__access_token', 'int_T'); // buildContext needs a token
    const res = await app.server.inject({ method: 'POST', url: '/admin/installations/a/reprovision', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).outcome).toHaveProperty('sources');
    const audit = await app.server.inject({ method: 'GET', url: '/admin/audit', headers: auth });
    expect((JSON.parse(audit.payload).items as Array<{ action: string }>).map((i) => i.action)).toContain('reprovision');
    await app.stop();
  });

  it('login and login.failed are recorded in the audit trail', async () => {
    const app = makeTestApp(integration, { adminToken: TOKEN });
    await app.server.inject({ method: 'POST', url: '/admin/session', payload: JSON.stringify({ token: 'wrong' }) });
    await app.server.inject({ method: 'POST', url: '/admin/session', payload: JSON.stringify({ token: TOKEN }) });
    const audit = await app.server.inject({ method: 'GET', url: '/admin/audit', headers: auth });
    const actions = (JSON.parse(audit.payload).items as Array<{ action: string }>).map((i) => i.action);
    expect(actions).toContain('login');
    expect(actions).toContain('login.failed');
    await app.stop();
  });
});
