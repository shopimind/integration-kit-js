import { randomBytes } from 'node:crypto';
import { SpmClient, type SpmHttpClient } from '@shopimind/sdk-js';
import { createIntegrationApp, type IntegrationApp } from '../runtime/create-app.js';
import { createLogger } from '../logging/logger.js';
import { signShopimindBody } from '../security/signature.js';
import { ensureInboundSecret } from '../lifecycle/inbound.js';
import type { Integration } from '../integration/types.js';

export interface TestAppOptions {
  /** Simulated SDK client (default: an offline stub returning empty ok responses). */
  spm?: SpmHttpClient;
  secret?: string;
  /** Fixed clock (default). */
  now?: () => number;
}

export interface TestApp extends IntegrationApp {
  /** Signs a webhook payload (body + headers ready for `server.inject`). */
  signWebhook(payload: object, ts?: number): { body: string; headers: Record<string, string> };
  /** Signs an INBOUND call (route /inbound) with the per-installation secret. */
  signInbound(installationId: string, payload: object, ts?: number): { body: string; headers: Record<string, string> };
}

/** Builds a test app: in-memory store, stub SDK client, webhook signing. */
export function makeTestApp<S>(integration: Integration<S>, opts: TestAppOptions = {}): TestApp {
  // Guard: this harness is NEVER intended for production (test keys/server).
  if (process.env.NODE_ENV === 'production') {
    throw new Error('makeTestApp() is for tests only and forbidden in production');
  }
  const secret = opts.secret ?? 'test_' + randomBytes(16).toString('hex');
  const fixedNow = opts.now ?? ((): number => 1_700_000_000_000);
  const stub = opts.spm ?? makeStubSpmClient();
  const app = createIntegrationApp(integration, {
    databasePath: ':memory:',
    webhookSecret: secret,
    credentialsKey: randomBytes(32).toString('hex'),
    makeSpmClient: () => stub,
    autoBackfillOnActivate: false,
    autoSync: false,
    now: fixedNow,
    logger: createLogger({ sink: () => {} }),
  });

  return {
    ...app,
    signWebhook(payload: object, ts: number = Math.floor(fixedNow() / 1000)) {
      const body = JSON.stringify(payload);
      return {
        body,
        headers: {
          'content-type': 'application/json',
          'x-shopimind-timestamp': String(ts),
          'x-shopimind-signature': signShopimindBody(body, secret, ts),
        },
      };
    },
    signInbound(installationId: string, payload: object, ts: number = Math.floor(fixedNow() / 1000)) {
      const inboundSecret = ensureInboundSecret(app.repos.state, installationId);
      const body = JSON.stringify(payload);
      return {
        body,
        headers: {
          'content-type': 'application/json',
          'x-integration-installation': installationId,
          'x-integration-timestamp': String(ts),
          'x-integration-signature': signShopimindBody(body, inboundSecret, ts),
        },
      };
    },
  };
}

/**
 * Offline STUB SDK client: a real client whose axios adapter is replaced by a
 * function returning empty `ok` envelopes (empty lists, create→id 1, bulk→counters
 * at 0). Enough to exercise the lifecycle / provisioning without network access.
 * Can be overridden via `opts.spm`.
 */
export function makeStubSpmClient(): SpmHttpClient {
  const client = SpmClient.getClient('v1', 'test', { baseUrl: 'http://localhost', retry: false, labelSource: null });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client.defaults as any).adapter = async (config: { method?: string; url?: string }) => {
    const method = (config.method ?? 'get').toLowerCase();
    const url = config.url ?? '';
    const body = stubBody(method, url);
    return { data: { statusCode: 200, data: body }, status: 200, statusText: 'OK', headers: {}, config };
  };
  return client;
}

function stubBody(method: string, url: string): unknown {
  if (method === 'get') {
    if (/custom-data-definitions\/\d+$/.test(url)) return { id_definition: 1, name: 'noop', fields: [] };
    return []; // list endpoints
  }
  if (url === 'data-sources') return { id_data_source: 1, label: 'noop', type: 'api' };
  if (url === 'custom-data-definitions') return { id_definition: 1, name: 'noop' };
  // bulk-save / other writes → neutral counters
  return { sent_count: 0, rejected_count: 0, failed_count: 0, rejected_items: [] };
}

/** Request seen by a scriptable stub (request body already deserialized). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SpmStubRequest = { method: string; url: string; body: any };

/** Scripted reply: `body` = RAW HTTP body. `status >= 400` → error (axios rejection). */
export interface SpmStubReply {
  status?: number;
  body?: unknown;
}

/**
 * SCRIPTABLE STUB SDK client: the axios adapter delegates to `handler(method,url,body)`.
 * Statuses < 300 resolve; statuses >= 400 REJECT like axios (the SDK then encodes
 * `{ ok:false, statusCode }`). Required to test error paths (4xx/5xx, 409 idempotent)
 * that `makeStubSpmClient` (always 200) does not cover.
 */
export function makeScriptedSpmClient(handler: (req: SpmStubRequest) => SpmStubReply): SpmHttpClient {
  const client = SpmClient.getClient('v1', 'test', { baseUrl: 'http://localhost', retry: false, labelSource: null });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client.defaults as any).adapter = async (config: any) => {
    const method = String(config.method ?? 'get').toLowerCase();
    const url = String(config.url ?? '');
    const body = config.data ? JSON.parse(config.data) : undefined;
    const r = handler({ method, url, body });
    const status = r.status ?? 200;
    const response = { data: r.body ?? {}, status, statusText: '', headers: {}, config };
    if (status >= 200 && status < 300) return response;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err: any = new Error(`Request failed with status code ${status}`);
    err.isAxiosError = true;
    err.response = response;
    err.config = config;
    throw err;
  };
  return client;
}
