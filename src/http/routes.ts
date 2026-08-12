import type { ServerRoute, Request, ResponseToolkit, RouteOptionsPayload } from '@hapi/hapi';
import type { RawConfigs } from '../contracts/index.js';
import {
  handleWebhook,
  handleTestConnection,
  handleRemoteData,
  type DispatcherDeps,
} from '../lifecycle/dispatcher.js';
import { handleInbound, type InboundDeps } from '../lifecycle/inbound.js';
import { verifyShopimindSignatureMulti } from '../security/signature.js';
import { clientIp } from './admin-auth.js';

export interface RouteDeps<S> {
  dispatcher: DispatcherDeps<S>;
  inbound: InboundDeps<S>;
  /**
   * Limiter (per IP) for POST /webhook/receive -- bounds a flood of unsigned requests
   * before the (relatively costly) HMAC verification runs. Returns true if allowed.
   */
  webhookRateLimit?(key: string): boolean;
  /**
   * Enriched health snapshot (DB ping, run ages, cursors in error). Routes
   * only reads `status` (to pick 200 vs 503) and forwards the whole object as JSON.
   */
  healthReport?(): Promise<{ status: 'ok' | 'degraded' }>;
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

/** Verifies a ShopiMind signature against the dispatcher's secret(s) (E6 rotation-aware). */
function verifyDispatcherSignature<S>(
  d: DispatcherDeps<S>,
  body: string,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  return verifyShopimindSignatureMulti(body, headers, d.secret, {
    ...(d.toleranceSeconds != null ? { toleranceSeconds: d.toleranceSeconds } : {}),
    ...(d.now ? { now: d.now } : {}),
  }).ok;
}

function parseConfigs(body: string): RawConfigs {
  try {
    return body ? (JSON.parse(body) as RawConfigs) : {};
  } catch {
    return {};
  }
}

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
        if (!verifyDispatcherSignature(deps.dispatcher, body, req.headers))
          return h.response({ success: false, error: 'unauthorized' }).code(401);
        return h.response(await handleTestConnection(parseConfigs(body), deps.dispatcher)).code(200);
      },
    },
    {
      method: 'POST',
      path: '/webhook/remote-data/{resource}',
      options: { payload: smallPayload },
      handler: async (req: Request, h: ResponseToolkit) => {
        const body = rawBody(req);
        if (!verifyDispatcherSignature(deps.dispatcher, body, req.headers))
          return h.response({ success: false, error: 'unauthorized' }).code(401);
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
      handler: async (_req: Request, h: ResponseToolkit) => {
        // Enriched health: DB ping + last-run age per active installation +
        // cursors in error. A degraded snapshot returns 503 so an orchestrator's
        // readiness/liveness probe can act on it. UNAUTHENTICATED and
        // deliberately COARSE (no secrets, no per-shop identifiers beyond ids) — it
        // is a probe endpoint. If no report provider is wired, fall back to the
        // original always-ok shape (backward compatible).
        if (!deps.healthReport) return h.response({ status: 'ok' }).code(200);
        const report = await deps.healthReport();
        return h.response(report).code(report.status === 'degraded' ? 503 : 200);
      },
    },
  ];
}
