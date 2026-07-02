import { randomBytes } from 'node:crypto';
import type { ServerRoute, Request, ResponseToolkit } from '@hapi/hapi';
import { adminOk, clientIp, constantTimeEqual, presentedToken } from './admin-auth.js';
import { AdminSessionManager } from './admin-session.js';
import { ADMIN_UI_HTML } from './admin-ui.generated.js';
import type { AdminData } from '../runtime/admin-data.js';
import type { AdminActions } from '../runtime/admin-actions.js';

/**
 * The admin surface: read endpoints backing the operations UI (installations,
 * cursors, runs, webhooks, inbound, state, rejected, audit) plus the legacy E5/E4
 * operator endpoints (`/admin/overview`, scoped `/rejected`) and the sync/status
 * actions — all moved here verbatim so a single builder owns everything under
 * `/admin`. Every route is gated by the per-IP rate limiter AND the admin token.
 *
 * These routes are registered on the main server by default; in two-port mode
 * (J4) they move to a dedicated admin listener while the public routes stay put.
 */
export interface AdminRouteDeps {
  adminToken?: string | null;
  /** Limiter (per IP) for /admin/* — bounds token brute-forcing + backfill abuse. */
  adminRateLimit?(key: string): boolean;
  /** Read provider (installations, cursors, runs, webhooks, inbound, state, rejected, audit). */
  data: AdminData;
  /** Session manager backing the browser UI (token -> cookie + CSRF). Absent -> API-token only. */
  sessions?: AdminSessionManager;
  /** Write-side provider (purge, reveal, reprovision, audit). Absent -> mutations return 501. */
  actions?: AdminActions;
  /** E5 — JSON overview across installations (moved verbatim). */
  overview?(): object;
  /** E4 — scoped dead-letter for one installation, RAW payloads, operator-only (moved verbatim). */
  rejectedItems?(id: string, limit: number): unknown;
  /** Triggers a sync for an installation (`full` = full backfill). */
  runSyncForInstall(id: string, full: boolean): Promise<unknown>;
  /** Recent runs for an installation (moved verbatim). */
  recentRuns(id: string): unknown;
}

const query = (req: Request): Record<string, unknown> => (req.query as Record<string, unknown> | undefined) ?? {};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const clampInt = (v: unknown, def: number, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(Math.floor(n), max));
};
/** Standard pagination params: `limit` (1..max, default `defLimit`) and `offset` (>=0). */
function pageParams(req: Request, defLimit = 50, maxLimit = 200): { limit: number; offset: number } {
  const q = query(req);
  const limit = clampInt(q.limit, defLimit, 1, maxLimit);
  const offset = clampInt(q.offset, 0, 0, 5_000_000);
  return { limit, offset };
}
const boolParam = (v: unknown): boolean | undefined => {
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return undefined;
};

/** True when the request carries a valid admin token OR a live admin session cookie. */
function isAuthed(req: Request, deps: AdminRouteDeps): boolean {
  if (adminOk(req, deps.adminToken)) return true;
  if (deps.sessions && deps.sessions.check(req)) return true;
  return false;
}

/** Rate-limit + auth gate (admin token OR session). Returns a ready error response, or null when allowed. */
function denied(req: Request, h: ResponseToolkit, deps: AdminRouteDeps): ReturnType<ResponseToolkit['response']> | null {
  if (deps.adminRateLimit && !deps.adminRateLimit(clientIp(req)))
    return h.response({ success: false, error: 'rate_limited' }).code(429);
  if (!isAuthed(req, deps)) return h.response({ success: false, error: 'unauthorized' }).code(401);
  return null;
}

/** Reads the raw request body as a UTF-8 string (payload parsing is disabled on these routes). */
function rawBody(req: Request): string {
  const p = req.payload as Buffer | string | undefined;
  return p == null ? '' : Buffer.isBuffer(p) ? p.toString('utf8') : String(p);
}

/** Reads the admin token from the JSON body `{token}`, then the `x-admin-token` / Bearer header. */
function readToken(req: Request): string {
  const body = parseJsonBody(req);
  if (typeof body.token === 'string' && body.token) return body.token;
  return presentedToken(req);
}

/**
 * Gate for STATE-CHANGING admin routes. The admin token grants access directly (an
 * API client is not cookie-based, so it is not exposed to CSRF). A browser session
 * additionally MUST present a matching CSRF token (double-submit) — a valid session
 * without the CSRF header is refused 403.
 */
function deniedMutation(req: Request, h: ResponseToolkit, deps: AdminRouteDeps): ReturnType<ResponseToolkit['response']> | null {
  if (deps.adminRateLimit && !deps.adminRateLimit(clientIp(req)))
    return h.response({ success: false, error: 'rate_limited' }).code(429);
  if (adminOk(req, deps.adminToken)) return null;
  if (deps.sessions) {
    const s = deps.sessions.check(req);
    if (s) {
      if (!deps.sessions.csrfOk(req, s)) return h.response({ success: false, error: 'csrf' }).code(403);
      return null;
    }
  }
  return h.response({ success: false, error: 'unauthorized' }).code(401);
}

/** Parses a small JSON request body into a plain object (empty object on any failure). */
function parseJsonBody(req: Request): Record<string, unknown> {
  const raw = rawBody(req);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const idOf = (req: Request): string => String(req.params.id ?? '');

export function buildAdminRoutes(deps: AdminRouteDeps): ServerRoute[] {
  return [
    // ---- Operations UI shell (public HTML; the APIs it calls ARE gated) ------
    {
      method: 'GET',
      path: '/admin/ui',
      handler: (req: Request, h: ResponseToolkit) => {
        const nonce = randomBytes(16).toString('base64');
        const html = ADMIN_UI_HTML.split('__CSP_NONCE__').join(nonce);
        const csp = [
          "default-src 'none'",
          `script-src 'nonce-${nonce}'`,
          `style-src 'nonce-${nonce}'`,
          // The UI uses inline style="" attributes for layout; nonces do not cover
          // attributes, so allow inline style ATTRIBUTES (never inline scripts).
          "style-src-attr 'unsafe-inline'",
          "connect-src 'self'",
          "img-src 'self' data:",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join('; ');
        return h
          .response(html)
          .type('text/html; charset=utf-8')
          .header('content-security-policy', csp)
          // Never cache the nonce'd HTML: a cached body paired with a fresh header
          // nonce would have its scripts/styles blocked.
          .header('cache-control', 'no-store')
          .header('x-content-type-options', 'nosniff')
          .header('referrer-policy', 'no-referrer')
          .header('x-frame-options', 'DENY');
      },
    },
    // ---- Session: exchange the admin token for a cookie + CSRF token ---------
    {
      method: 'POST',
      path: '/admin/session',
      options: { payload: { parse: false, maxBytes: 4 * 1024 } },
      handler: (req: Request, h: ResponseToolkit) => {
        if (deps.adminRateLimit && !deps.adminRateLimit(clientIp(req)))
          return h.response({ success: false, error: 'rate_limited' }).code(429);
        if (!deps.sessions) return h.response({ success: false, error: 'not_supported' }).code(501);
        const token = readToken(req);
        if (!deps.adminToken || !token || !constantTimeEqual(token, deps.adminToken)) {
          if (deps.actions) deps.actions.audit({ action: 'login.failed', ip: clientIp(req) });
          return h.response({ success: false, error: 'unauthorized' }).code(401);
        }
        const { sid, csrf } = deps.sessions.create(clientIp(req));
        if (deps.actions) deps.actions.audit({ action: 'login', ip: clientIp(req) });
        return h
          .response({ success: true, csrf })
          .code(200)
          .state(AdminSessionManager.cookieName, sid, deps.sessions.stateOptions());
      },
    },
    // ---- Session: logout (ends the current session) --------------------------
    {
      method: 'DELETE',
      path: '/admin/session',
      options: { payload: { parse: false, maxBytes: 4 * 1024 } },
      handler: (req: Request, h: ResponseToolkit) => {
        if (deps.sessions) {
          const s = deps.sessions.check(req);
          if (s) deps.sessions.destroy(s.sid);
        }
        const res = h.response({ success: true }).code(200);
        if (deps.sessions) res.unstate(AdminSessionManager.cookieName, { path: AdminSessionManager.cookiePath });
        return res;
      },
    },
    // ---- Read: dashboard meta ------------------------------------------------
    {
      method: 'GET',
      path: '/admin/meta',
      handler: (req: Request, h: ResponseToolkit) => {
        const no = denied(req, h, deps);
        if (no) return no;
        return h.response(deps.data.meta()).code(200);
      },
    },
    // ---- Read: installations list -------------------------------------------
    {
      method: 'GET',
      path: '/admin/installations',
      handler: (req: Request, h: ResponseToolkit) => {
        const no = denied(req, h, deps);
        if (no) return no;
        const q = query(req);
        const { limit, offset } = pageParams(req);
        return h
          .response(
            deps.data.listInstallations({
              ...(str(q.status) ? { status: str(q.status) } : {}),
              ...(str(q.q) ? { q: str(q.q) } : {}),
              limit,
              offset,
            }),
          )
          .code(200);
      },
    },
    // ---- Read: one installation (aggregate detail) --------------------------
    {
      method: 'GET',
      path: '/admin/installations/{id}',
      handler: (req: Request, h: ResponseToolkit) => {
        const no = denied(req, h, deps);
        if (no) return no;
        const id = idOf(req);
        if (!id) return h.response({ success: false, error: 'invalid_id' }).code(400);
        const detail = deps.data.installation(id);
        if (!detail) return h.response({ success: false, error: 'not_found' }).code(404);
        return h.response(detail).code(200);
      },
    },
    // ---- Read: cursors of an installation -----------------------------------
    {
      method: 'GET',
      path: '/admin/installations/{id}/cursors',
      handler: (req: Request, h: ResponseToolkit) => {
        const no = denied(req, h, deps);
        if (no) return no;
        const id = idOf(req);
        if (!id) return h.response({ success: false, error: 'invalid_id' }).code(400);
        return h.response({ items: deps.data.cursors(id) }).code(200);
      },
    },
    // ---- Read: sync runs of an installation ---------------------------------
    {
      method: 'GET',
      path: '/admin/installations/{id}/runs',
      handler: (req: Request, h: ResponseToolkit) => {
        const no = denied(req, h, deps);
        if (no) return no;
        const id = idOf(req);
        if (!id) return h.response({ success: false, error: 'invalid_id' }).code(400);
        return h.response(deps.data.runs(id, pageParams(req))).code(200);
      },
    },
    // ---- Read: webhook log of an installation (PII masked) ------------------
    {
      method: 'GET',
      path: '/admin/installations/{id}/webhooks',
      handler: (req: Request, h: ResponseToolkit) => {
        const no = denied(req, h, deps);
        if (no) return no;
        const id = idOf(req);
        if (!id) return h.response({ success: false, error: 'invalid_id' }).code(400);
        const q = query(req);
        const sig = boolParam(q.signatureOk);
        return h
          .response(
            deps.data.webhooks(id, {
              ...(str(q.event) ? { event: str(q.event) } : {}),
              ...(sig !== undefined ? { signatureOk: sig } : {}),
              ...pageParams(req),
            }),
          )
          .code(200);
      },
    },
    // ---- Read: inbound events of an installation ----------------------------
    {
      method: 'GET',
      path: '/admin/installations/{id}/inbound',
      handler: (req: Request, h: ResponseToolkit) => {
        const no = denied(req, h, deps);
        if (no) return no;
        const id = idOf(req);
        if (!id) return h.response({ success: false, error: 'invalid_id' }).code(400);
        return h.response(deps.data.inbound(id, pageParams(req))).code(200);
      },
    },
    // ---- Read: state metadata (NEVER the secret values) ---------------------
    {
      method: 'GET',
      path: '/admin/installations/{id}/state',
      handler: (req: Request, h: ResponseToolkit) => {
        const no = denied(req, h, deps);
        if (no) return no;
        const id = idOf(req);
        if (!id) return h.response({ success: false, error: 'invalid_id' }).code(400);
        return h.response({ items: deps.data.state(id) }).code(200);
      },
    },
    // ---- Read: global dead-letter (filterable, PII masked) ------------------
    {
      method: 'GET',
      path: '/admin/rejected',
      handler: (req: Request, h: ResponseToolkit) => {
        const no = denied(req, h, deps);
        if (no) return no;
        const q = query(req);
        const sinceDays = clampInt(q.sinceDays, 0, 0, 3650);
        return h
          .response(
            deps.data.rejected({
              ...(str(q.installationId) ? { installationId: str(q.installationId) } : {}),
              ...(str(q.entity) ? { entity: str(q.entity) } : {}),
              ...(sinceDays > 0 ? { sinceDays } : {}),
              ...(str(q.q) ? { q: str(q.q) } : {}),
              ...pageParams(req, 50, 500),
            }),
          )
          .code(200);
      },
    },
    // ---- Read: admin audit trail --------------------------------------------
    {
      method: 'GET',
      path: '/admin/audit',
      handler: (req: Request, h: ResponseToolkit) => {
        const no = denied(req, h, deps);
        if (no) return no;
        return h.response(deps.data.audit(pageParams(req))).code(200);
      },
    },

    // ---- Legacy operator endpoints (moved verbatim) -------------------------
    {
      method: 'GET',
      path: '/admin/overview',
      handler: (req: Request, h: ResponseToolkit) => {
        const no = denied(req, h, deps);
        if (no) return no;
        if (!deps.overview) return h.response({ success: false, error: 'not_supported' }).code(501);
        return h.response(deps.overview()).code(200);
      },
    },
    {
      method: 'GET',
      path: '/admin/installations/{id}/rejected',
      handler: (req: Request, h: ResponseToolkit) => {
        const no = denied(req, h, deps);
        if (no) return no;
        if (!deps.rejectedItems) return h.response({ success: false, error: 'not_supported' }).code(501);
        const id = idOf(req);
        if (!id) return h.response({ success: false, error: 'invalid_id' }).code(400);
        // Bounded: default 100, hard cap 500 (the repo clamps again defensively).
        const rawLimit = Number(query(req).limit ?? 100);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 100;
        return h.response({ items: deps.rejectedItems(id, limit) }).code(200);
      },
    },
    {
      method: 'POST',
      path: '/admin/sync/{id}',
      options: { payload: { parse: false, maxBytes: 4 * 1024 } },
      handler: async (req: Request, h: ResponseToolkit) => {
        const no = deniedMutation(req, h, deps);
        if (no) return no;
        const id = idOf(req);
        if (!id) return h.response({ success: false, error: 'invalid_id' }).code(400);
        // `?full=true` forces a full backfill (initial re-sync); default = incremental.
        const full = String(query(req).full ?? '') === 'true';
        const summary = await deps.runSyncForInstall(id, full);
        if (deps.actions) deps.actions.audit({ action: 'sync', installationId: id, target: id, details: { full }, ip: clientIp(req) });
        return h.response({ success: true, summary }).code(200);
      },
    },
    {
      method: 'GET',
      path: '/admin/status/{id}',
      handler: (req: Request, h: ResponseToolkit) => {
        const no = denied(req, h, deps);
        if (no) return no;
        const id = idOf(req);
        if (!id) return h.response({ success: false, error: 'invalid_id' }).code(400);
        return h.response({ runs: deps.recentRuns(id) }).code(200);
      },
    },

    // ---- Mutations (CSRF-guarded for browser-session clients) ---------------
    {
      method: 'POST',
      path: '/admin/installations/{id}/reprovision',
      options: { payload: { parse: false, maxBytes: 4 * 1024 } },
      handler: async (req: Request, h: ResponseToolkit) => {
        const no = deniedMutation(req, h, deps);
        if (no) return no;
        if (!deps.actions) return h.response({ success: false, error: 'not_supported' }).code(501);
        const id = idOf(req);
        if (!id) return h.response({ success: false, error: 'invalid_id' }).code(400);
        try {
          const outcome = await deps.actions.reprovision(id);
          deps.actions.audit({
            action: 'reprovision',
            installationId: id,
            target: id,
            details: { sources: outcome.sources, defs: outcome.defs, errors: outcome.errors.length },
            ip: clientIp(req),
          });
          return h.response({ success: true, outcome }).code(200);
        } catch (e) {
          return h.response({ success: false, error: e instanceof Error ? e.message : 'reprovision_failed' }).code(400);
        }
      },
    },
    {
      method: 'POST',
      path: '/admin/rejected/purge',
      options: { payload: { parse: false, maxBytes: 32 * 1024 } },
      handler: (req: Request, h: ResponseToolkit) => {
        const no = deniedMutation(req, h, deps);
        if (no) return no;
        if (!deps.actions) return h.response({ success: false, error: 'not_supported' }).code(501);
        const body = parseJsonBody(req);
        const installationId = typeof body.installationId === 'string' ? body.installationId : '';
        const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).filter((n): n is number => Number.isInteger(n)) : [];
        if (!installationId || ids.length === 0) return h.response({ success: false, error: 'invalid_request' }).code(400);
        const removed = deps.actions.purgeRejected(installationId, ids);
        deps.actions.audit({ action: 'rejected.purge', installationId, target: installationId, details: { requested: ids.length, removed }, ip: clientIp(req) });
        return h.response({ success: true, removed }).code(200);
      },
    },
    {
      method: 'POST',
      path: '/admin/rejected/{id}/reveal',
      options: { payload: { parse: false, maxBytes: 4 * 1024 } },
      handler: (req: Request, h: ResponseToolkit) => {
        const no = deniedMutation(req, h, deps);
        if (no) return no;
        if (!deps.actions) return h.response({ success: false, error: 'not_supported' }).code(501);
        const rid = Number(req.params.id);
        if (!Number.isInteger(rid)) return h.response({ success: false, error: 'invalid_id' }).code(400);
        const row = deps.actions.revealRejected(rid);
        if (!row) return h.response({ success: false, error: 'not_found' }).code(404);
        deps.actions.audit({ action: 'rejected.reveal', installationId: row.installation_id, target: String(rid), ip: clientIp(req) });
        return h.response({ success: true, payload_json: row.payload_json }).code(200);
      },
    },
    {
      method: 'POST',
      path: '/admin/installations/{id}/webhook-log/{logId}/reveal',
      options: { payload: { parse: false, maxBytes: 4 * 1024 } },
      handler: (req: Request, h: ResponseToolkit) => {
        const no = deniedMutation(req, h, deps);
        if (no) return no;
        if (!deps.actions) return h.response({ success: false, error: 'not_supported' }).code(501);
        const id = idOf(req);
        const logId = Number(req.params.logId);
        if (!id || !Number.isInteger(logId)) return h.response({ success: false, error: 'invalid_id' }).code(400);
        const row = deps.actions.revealWebhook(id, logId);
        if (!row) return h.response({ success: false, error: 'not_found' }).code(404);
        deps.actions.audit({ action: 'webhook.reveal', installationId: id, target: String(logId), ip: clientIp(req) });
        return h.response({ success: true, payload_json: row.payload_json }).code(200);
      },
    },
  ];
}
