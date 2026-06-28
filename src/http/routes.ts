import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServerRoute, Request, ResponseToolkit, RouteOptionsPayload } from '@hapi/hapi';
import type { RawConfigs } from '../contracts/index.js';
import {
  handleWebhook,
  handleTestConnection,
  handleRemoteData,
  type DispatcherDeps,
} from '../lifecycle/dispatcher.js';
import { handleInbound, type InboundDeps } from '../lifecycle/inbound.js';
import { verifyShopimindSignature, type SignatureOptions } from '../security/signature.js';

export interface RouteDeps<S> {
  dispatcher: DispatcherDeps<S>;
  inbound: InboundDeps<S>;
  adminToken?: string | null;
  /** Limiter (per IP) for /admin/* routes -- bounds token brute-forcing + backfill abuse. */
  adminRateLimit?(key: string): boolean;
  /**
   * Limiter (per IP) for POST /webhook/receive -- bounds a flood of unsigned requests
   * before the (relatively costly) HMAC verification runs. Returns true if allowed.
   */
  webhookRateLimit?(key: string): boolean;
  runSyncForInstall(id: string, full: boolean): Promise<unknown>;
  recentRuns(id: string): unknown;
}

/** Ephemeral (per-process) HMAC key to compare the admin token at fixed length. */
const ADMIN_CMP_KEY = randomBytes(32);

/** Constant-time comparison WITHOUT length leakage (compares HMAC digests). */
function constantTimeEqual(a: string, b: string): boolean {
  const da = createHmac('sha256', ADMIN_CMP_KEY).update(a).digest();
  const db = createHmac('sha256', ADMIN_CMP_KEY).update(b).digest();
  return timingSafeEqual(da, db);
}

const webhookPayload: RouteOptionsPayload = {
  parse: false,
  output: 'data',
  allow: 'application/json',
  maxBytes: 1024 * 1024,
};
const smallPayload: RouteOptionsPayload = {
  parse: false,
  output: 'data',
  allow: 'application/json',
  maxBytes: 64 * 1024,
};

const rawBody = (req: Request): string => {
  const p = req.payload as Buffer | string | undefined;
  if (p == null) return '';
  return Buffer.isBuffer(p) ? p.toString('utf8') : String(p);
};

function sigOptsOf<S>(d: DispatcherDeps<S>): SignatureOptions {
  const o: SignatureOptions = { secret: d.secret };
  if (d.toleranceSeconds != null) o.toleranceSeconds = d.toleranceSeconds;
  if (d.now) o.now = d.now;
  return o;
}

function parseConfigs(body: string): RawConfigs {
  try {
    return body ? (JSON.parse(body) as RawConfigs) : {};
  } catch {
    return {};
  }
}

function adminOk(req: Request, token?: string | null): boolean {
  if (!token) return false;
  const x = req.headers['x-admin-token'];
  const auth = req.headers.authorization;
  const presented =
    typeof x === 'string' && x
      ? x
      : typeof auth === 'string'
        ? auth.replace(/^Bearer\s+/i, '')
        : '';
  if (!presented) return false;
  return constantTimeEqual(presented, token);
}

const clientIp = (req: Request): string => req.info?.remoteAddress || 'unknown';

export function buildRoutes<S>(deps: RouteDeps<S>): ServerRoute[] {
  return [
    {
      method: 'POST',
      path: '/webhook/receive',
      options: { payload: webhookPayload },
      handler: async (req: Request, h: ResponseToolkit) => {
        // Per-IP rate limit BEFORE HMAC verification: caps the cost of a flood of
        // unsigned (or forged) requests, each of which would otherwise force an HMAC.
        if (deps.webhookRateLimit && !deps.webhookRateLimit(clientIp(req)))
          return h.response({ success: false, error: 'rate_limited' }).code(429);
        const res = await handleWebhook(rawBody(req), req.headers, deps.dispatcher);
        return h.response(res.body).code(res.status);
      },
    },
    {
      method: 'POST',
      path: '/webhook/test-connection',
      options: { payload: smallPayload },
      handler: async (req: Request, h: ResponseToolkit) => {
        const body = rawBody(req);
        const sig = verifyShopimindSignature(body, req.headers, sigOptsOf(deps.dispatcher));
        if (!sig.ok) return h.response({ success: false, error: 'unauthorized' }).code(401);
        return h.response(await handleTestConnection(parseConfigs(body), deps.dispatcher)).code(200);
      },
    },
    {
      method: 'POST',
      path: '/webhook/remote-data/{resource}',
      options: { payload: smallPayload },
      handler: async (req: Request, h: ResponseToolkit) => {
        const body = rawBody(req);
        const sig = verifyShopimindSignature(body, req.headers, sigOptsOf(deps.dispatcher));
        if (!sig.ok) return h.response({ success: false, error: 'unauthorized' }).code(401);
        const resource = String(req.params.resource);
        return h.response(await handleRemoteData(resource, parseConfigs(body), deps.dispatcher)).code(200);
      },
    },
    {
      method: 'POST',
      path: '/inbound/{action}',
      options: { payload: smallPayload },
      handler: async (req: Request, h: ResponseToolkit) => {
        const action = String(req.params.action);
        const res = await handleInbound(action, rawBody(req), req.headers, deps.inbound);
        return h.response(res.body).code(res.status);
      },
    },
    {
      method: 'GET',
      path: '/health',
      handler: (_req: Request, h: ResponseToolkit) => h.response({ status: 'ok' }).code(200),
    },
    {
      method: 'POST',
      path: '/admin/sync/{id}',
      options: { payload: { parse: false, maxBytes: 4 * 1024 } },
      handler: async (req: Request, h: ResponseToolkit) => {
        if (deps.adminRateLimit && !deps.adminRateLimit(clientIp(req))) return h.response({ success: false, error: 'rate_limited' }).code(429);
        if (!adminOk(req, deps.adminToken)) return h.response({ success: false, error: 'unauthorized' }).code(401);
        const id = String(req.params.id ?? '');
        if (!id) return h.response({ success: false, error: 'invalid_id' }).code(400);
        // `?full=true` forces a full backfill (initial re-sync); default = incremental.
        const full = String((req.query as Record<string, unknown> | undefined)?.full ?? '') === 'true';
        const summary = await deps.runSyncForInstall(id, full);
        return h.response({ success: true, summary }).code(200);
      },
    },
    {
      method: 'GET',
      path: '/admin/status/{id}',
      handler: (req: Request, h: ResponseToolkit) => {
        if (deps.adminRateLimit && !deps.adminRateLimit(clientIp(req))) return h.response({ success: false, error: 'rate_limited' }).code(429);
        if (!adminOk(req, deps.adminToken)) return h.response({ success: false, error: 'unauthorized' }).code(401);
        const id = String(req.params.id ?? '');
        if (!id) return h.response({ success: false, error: 'invalid_id' }).code(400);
        return h.response({ runs: deps.recentRuns(id) }).code(200);
      },
    },
  ];
}
