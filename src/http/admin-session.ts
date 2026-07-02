import { randomBytes } from 'node:crypto';
import type { Request } from '@hapi/hapi';
import { constantTimeEqual } from './admin-auth.js';

/**
 * In-memory session manager for the admin operations UI. A browser exchanges the
 * admin token ONCE (`POST /admin/session`) for an opaque session id (HttpOnly,
 * SameSite=Strict cookie) plus a CSRF token returned in the body. The token itself
 * is never stored in the browser, and every state-changing call must echo the CSRF
 * token in the `x-csrf-token` header (double-submit, verified constant-time).
 *
 * Bounded on purpose: sliding 12h TTL and a hard cap of concurrent sessions with
 * LRU eviction, so a long-lived integrator process cannot accumulate sessions. All
 * state is process-local — restarting the integration invalidates every session.
 */

const SID_COOKIE = 'spm_admin_sid';
const COOKIE_PATH = '/admin';

/** Hardened cookie options passed to Hapi's `response.state()`. */
export interface AdminCookieOptions {
  ttl: number;
  isHttpOnly: true;
  isSameSite: 'Strict';
  path: string;
  isSecure: boolean;
  encoding: 'none';
}

export interface AdminSession {
  sid: string;
  csrf: string;
  ip: string;
  createdAt: number;
  lastSeen: number;
}

export interface AdminSessionOptions {
  now?: () => number;
  /** Sliding inactivity TTL in ms (default 12h). */
  ttlMs?: number;
  /** Hard cap on concurrent sessions; LRU-evicted past this. Default 20. */
  maxSessions?: number;
  /** Adds `Secure` to the cookie (serve the admin UI over HTTPS). Default false. */
  secureCookie?: boolean;
}

export class AdminSessionManager {
  private readonly sessions = new Map<string, AdminSession>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly secure: boolean;

  constructor(opts: AdminSessionOptions = {}) {
    this.now = opts.now ?? ((): number => Date.now());
    this.ttlMs = opts.ttlMs ?? 12 * 60 * 60 * 1000;
    this.maxSessions = Math.max(1, opts.maxSessions ?? 20);
    this.secure = opts.secureCookie ?? false;
  }

  /** The cookie name (exposed for tests and the routes). */
  static get cookieName(): string {
    return SID_COOKIE;
  }

  /** The cookie path (used to clear the cookie via `response.unstate()`). */
  static get cookiePath(): string {
    return COOKIE_PATH;
  }

  /** Creates a session (call only AFTER a successful token check). Returns sid + csrf. */
  create(ip: string): { sid: string; csrf: string } {
    this.evictExpired();
    while (this.sessions.size >= this.maxSessions) this.evictOldest();
    const sid = randomBytes(32).toString('hex');
    const csrf = randomBytes(32).toString('hex');
    const t = this.now();
    this.sessions.set(sid, { sid, csrf, ip, createdAt: t, lastSeen: t });
    return { sid, csrf };
  }

  /** Returns the live session for a request (sliding-TTL refresh), or null. */
  check(req: Request): AdminSession | null {
    const sid = readCookie(req, SID_COOKIE);
    if (!sid) return null;
    const s = this.sessions.get(sid);
    if (!s) return null;
    if (this.now() - s.lastSeen > this.ttlMs) {
      this.sessions.delete(sid);
      return null;
    }
    s.lastSeen = this.now(); // sliding refresh on activity
    return s;
  }

  /** Constant-time CSRF check for a state-changing request tied to a session. */
  csrfOk(req: Request, s: AdminSession): boolean {
    const header = req.headers['x-csrf-token'];
    const presented = typeof header === 'string' ? header : '';
    if (!presented) return false;
    return constantTimeEqual(presented, s.csrf);
  }

  destroy(sid: string): void {
    this.sessions.delete(sid);
  }

  /** Hapi cookie options for `response.state()` — the hardened, HttpOnly session cookie. */
  stateOptions(): AdminCookieOptions {
    return { ttl: this.ttlMs, isHttpOnly: true, isSameSite: 'Strict', path: COOKIE_PATH, isSecure: this.secure, encoding: 'none' };
  }

  /** Live session count (tests / diagnostics). */
  get size(): number {
    return this.sessions.size;
  }

  private evictExpired(): void {
    const t = this.now();
    for (const [sid, s] of this.sessions) {
      if (t - s.lastSeen > this.ttlMs) this.sessions.delete(sid);
    }
  }

  private evictOldest(): void {
    let oldestSid: string | null = null;
    let oldest = Infinity;
    for (const [sid, s] of this.sessions) {
      if (s.lastSeen < oldest) {
        oldest = s.lastSeen;
        oldestSid = sid;
      }
    }
    if (oldestSid) this.sessions.delete(oldestSid);
  }
}

/** Reads a single cookie value from the raw `Cookie` header (Hapi state parsing is off). */
function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}
