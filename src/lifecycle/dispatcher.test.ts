import { describe, it, expect, vi } from 'vitest';
import { openDatabase } from '../store/db.js';
import { createRepositories } from '../store/repositories.js';
import { SecretCipher } from '../security/crypto.js';
import { createLogger } from '../logging/logger.js';
import { signShopimindBody } from '../security/signature.js';
import { handleWebhook, handleTestConnection, type DispatcherDeps } from './dispatcher.js';
import { loadConfigs } from '../config/config-store.js';
import { makeScriptedSpmClient, type SpmStubReply, type SpmStubRequest } from '../testing/harness.js';
import type { Integration } from '../integration/types.js';
import type { SpmHttpClient } from '@shopimind/sdk-js';

const cipher = new SecretCipher({ key: 'e'.repeat(64) });
const SECRET = 'whsec';
const ts = 1_700_000_000;
const now = (): number => ts * 1000;

type S = { account: string; apiKey: string; syncOrders: boolean };

const read = (data: unknown): SpmStubReply => ({ body: { statusCode: 200, data } });

/**
 * Stub SDK happy-path: empty lists, `POST data-sources` -> id 11,
 * `POST custom-data-definitions` -> id 22, events/bulk ok. `over` injects a
 * targeted error (e.g. 500 on an endpoint) for the failure paths.
 */
function fakeSpm(over: (req: SpmStubRequest) => SpmStubReply | undefined = () => undefined): SpmHttpClient {
  return makeScriptedSpmClient((req) => {
    const o = over(req);
    if (o) return o;
    const { method, url } = req;
    if (method === 'get' && /custom-data-definitions\/\d+$/.test(url)) return read({ id_definition: 1, name: 'def', fields: [] });
    if (method === 'get') return read([]);
    if (method === 'post' && url === 'data-sources') return read({ id_data_source: 11 });
    if (method === 'post' && url === 'custom-data-definitions') return read({ id_definition: 22 });
    if (method === 'patch') return read({});
    if (method === 'post' && url === 'events') return read({});
    return { body: { sent_count: 0, rejected_count: 0, failed_count: 0, rejected_items: [] } };
  });
}

const integration = (testOk = true): Integration<S> => ({
  slug: 'hiboutik',
  meta: { name: 'Hiboutik', version: '1.0.0' },
  configSchema: {
    steps: [
      {
        key: 'c',
        label: { fr: 'Connexion' },
        fields: [
          { key: 'account', type: 'text', label: { fr: 'Compte' } },
          { key: 'hiboutik_api_key', type: 'password', sensitive: true, label: { fr: 'Clé' } },
        ],
      },
    ],
  },
  parseSettings: (raw) => ({
    account: String(raw.account ?? ''),
    apiKey: String(raw.hiboutik_api_key ?? ''),
    syncOrders: Boolean(raw.sync_orders),
  }),
  testConnection: async () => testOk,
  provisioning: () => ({ dataSources: [{ key: 'parent', decl: { label: 'Hiboutik POS', type: 'api' } }] }),
  syncSteps: [],
});

function setup(testOk = true, afterActivate: (id: string) => void = () => {}) {
  const db = openDatabase(':memory:');
  const repos = createRepositories(db, cipher);
  const deps: DispatcherDeps<S> = {
    integration: integration(testOk),
    repos,
    secret: SECRET,
    logger: createLogger({ sink: () => {} }),
    makeSpmClient: () => fakeSpm(),
    afterActivate,
    now,
  };
  return { db, repos, deps };
}

function signed(payload: object): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(payload);
  return { body, headers: { 'x-shopimind-timestamp': String(ts), 'x-shopimind-signature': signShopimindBody(body, SECRET, ts) } };
}

describe('handleWebhook', () => {
  it('rejects a bad signature AND logs a REDACTED payload', async () => {
    const { db, deps } = setup();
    const body = JSON.stringify({
      event: 'integration.activated',
      id_shop_integration: 1,
      access_token: 'int_TOKEN',
      configs: { hiboutik_api_key: 'SECRETKEY' },
    });
    const res = await handleWebhook(body, { 'x-shopimind-timestamp': String(ts), 'x-shopimind-signature': 'deadbeef' }, deps);
    expect(res.status).toBe(401);

    const row = db.prepare('SELECT * FROM webhook_log ORDER BY id DESC LIMIT 1').get() as { payload_json: string; signature_ok: number };
    expect(row.signature_ok).toBe(0);
    expect(row.payload_json).not.toContain('int_TOKEN');
    expect(row.payload_json).not.toContain('SECRETKEY');
    expect(row.payload_json).toContain('[redacted]');
  });

  it('activates: install active, secret encrypted, provisioning run, afterActivate called', async () => {
    const after = vi.fn();
    const { repos, deps } = setup(true, after);
    const { body, headers } = signed({
      event: 'integration.activated',
      id_shop_integration: 1,
      id_shop: 10,
      access_token: 'int_TOKEN',
      configs: { account: 'demo', hiboutik_api_key: 'SECRETKEY' },
    });
    const res = await handleWebhook(body, headers, deps);
    expect(res.body.success).toBe(true);
    expect(repos.installs.find('1')?.status).toBe('active');
    expect(loadConfigs(repos.state, '1', deps.integration.configSchema).hiboutik_api_key).toBe('SECRETKEY');
    expect(after).toHaveBeenCalledWith('1');
    const prov = JSON.parse(repos.state.get('1', '__provisioning') ?? '{}') as { sourceIds: Record<string, number> };
    expect(prov.sourceIds.parent).toBe(11);
  });

  it('activates: testConnection KO -> success:false', async () => {
    const { deps } = setup(false);
    const { body, headers } = signed({ event: 'integration.activated', id_shop_integration: 1, access_token: 'int_T', configs: {} });
    const res = await handleWebhook(body, headers, deps);
    expect(res.body).toEqual({ success: false, error: 'connection_failed' });
  });

  it('anti-replay: a signed webhook replayed verbatim is processed only once', async () => {
    const after = vi.fn();
    const { deps } = setup(true, after);
    const args = signedArgs({ event: 'integration.activated', id_shop_integration: 1, access_token: 'int_T', configs: { account: 'demo', hiboutik_api_key: 'k' } });
    const r1 = await handleWebhook(...args, deps);
    const r2 = await handleWebhook(...args, deps); // same signature -> replay
    expect(r1.body.success).toBe(true);
    expect(r2.body.success).toBe(true);
    expect(after).toHaveBeenCalledTimes(1); // post-activation backfill only once
  });

  it('activates: provisioning FULLY failed -> success:false (inactive)', async () => {
    const db = openDatabase(':memory:');
    const repos = createRepositories(db, cipher);
    const spm = fakeSpm((req) => (req.method === 'post' && req.url === 'data-sources' ? { status: 500, body: { message: 'boom' } } : undefined));
    const deps: DispatcherDeps<S> = {
      integration: integration(true), repos, secret: SECRET, logger: createLogger({ sink: () => {} }), makeSpmClient: () => spm, now,
    };
    const res = await handleWebhook(...signedArgs({ event: 'integration.activated', id_shop_integration: 1, access_token: 'int_T', configs: { account: 'demo', hiboutik_api_key: 'k' } }), deps);
    expect(res.body.success).toBe(false);
    expect(String(res.body.error)).toContain('provisioning_failed');
    expect(repos.installs.find('1')?.status).toBe('inactive');
  });

  it('activates: PARTIAL provisioning (>=1 resource OK) -> activated despite an error', async () => {
    const db = openDatabase(':memory:');
    const repos = createRepositories(db, cipher);
    const spm = fakeSpm((req) => (req.method === 'post' && req.url === 'events' ? { status: 500, body: { message: 'event boom' } } : undefined));
    const intg: Integration<S> = {
      ...integration(true),
      provisioning: () => ({
        dataSources: [{ key: 'parent', decl: { label: 'P', type: 'api' } }],
        events: [{ code_name: 'pts', name: { fr: 'Points' } }],
      }),
    };
    const deps: DispatcherDeps<S> = {
      integration: intg, repos, secret: SECRET, logger: createLogger({ sink: () => {} }), makeSpmClient: () => spm, now,
    };
    const res = await handleWebhook(...signedArgs({ event: 'integration.activated', id_shop_integration: 1, access_token: 'int_T', configs: { account: 'demo', hiboutik_api_key: 'k' } }), deps);
    expect(res.body.success).toBe(true);
    expect(repos.installs.find('1')?.status).toBe('active');
  });

  it('activates with the REAL NestJS payload (opaque installation_id, no legacy fields)', async () => {
    // The current wire format sends { event, installation_id, access_token, configs }
    // and NOTHING legacy (no id_shop_integration / id_shop / integration_slug). The
    // dispatcher must key entirely off the opaque installation_id.
    const after = vi.fn();
    const { repos, deps } = setup(true, after);
    const { body, headers } = signed({
      event: 'integration.activated',
      installation_id: 'inst_opaque_abc123',
      access_token: 'int_TOKEN',
      configs: { account: 'demo', hiboutik_api_key: 'SECRETKEY' },
    });
    const res = await handleWebhook(body, headers, deps);
    expect(res.body.success).toBe(true);
    expect(repos.installs.find('inst_opaque_abc123')?.status).toBe('active');
    expect(after).toHaveBeenCalledWith('inst_opaque_abc123');
    // installation_id wins even if a legacy id_shop_integration is NOT provided.
    expect(repos.installs.find('1')).toBeUndefined();
  });

  it('prefers installation_id over the legacy id_shop_integration when both are present', async () => {
    const { repos, deps } = setup();
    const { body, headers } = signed({
      event: 'integration.installed',
      installation_id: 'inst_opaque_xyz',
      id_shop_integration: 42, // legacy alias — must be ignored in favour of the opaque token
      access_token: 'int_T',
      configs: {},
    });
    const res = await handleWebhook(body, headers, deps);
    expect(res.body.success).toBe(true);
    expect(repos.installs.find('inst_opaque_xyz')?.status).toBe('inactive');
    expect(repos.installs.find('42')).toBeUndefined();
  });

  it('unknown event -> success:false', async () => {
    const { deps } = setup();
    const { body, headers } = signed({ event: 'integration.frobnicated', id_shop_integration: 1 });
    const res = await handleWebhook(body, headers, deps);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: false, error: 'unknown_event' });
  });

  it('deactivation then uninstall change the status', async () => {
    const { repos, deps } = setup();
    await handleWebhook(...signedArgs({ event: 'integration.activated', id_shop_integration: 1, access_token: 'int_T', configs: {} }), deps);
    await handleWebhook(...signedArgs({ event: 'integration.deactivated', id_shop_integration: 1 }), deps);
    expect(repos.installs.find('1')?.status).toBe('inactive');
    await handleWebhook(...signedArgs({ event: 'integration.uninstalled', id_shop_integration: 1 }), deps);
    expect(repos.installs.find('1')?.status).toBe('uninstalled');
  });
});

describe('handleTestConnection', () => {
  it('validates the credentials', async () => {
    const { deps } = setup(true);
    expect(await handleTestConnection({ account: 'x', hiboutik_api_key: 'y' }, deps)).toEqual({ success: true });
  });
});

// small helper to sign + destructure into arguments
function signedArgs(payload: object): [string, Record<string, string>] {
  const { body, headers } = signed(payload);
  return [body, headers];
}
