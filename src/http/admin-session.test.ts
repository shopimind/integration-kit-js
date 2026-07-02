import { describe, it, expect } from 'vitest';
import type { Request } from '@hapi/hapi';
import { AdminSessionManager } from './admin-session.js';

const reqWith = (cookie?: string, csrf?: string): Request =>
  ({ headers: { ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) } }) as unknown as Request;
const cookie = (sid: string): string => `${AdminSessionManager.cookieName}=${sid}`;

describe('AdminSessionManager', () => {
  it('creates opaque hex sid + csrf and resolves a live session by cookie', () => {
    const mgr = new AdminSessionManager({ now: () => 1000 });
    const { sid, csrf } = mgr.create('1.2.3.4');
    expect(sid).toMatch(/^[0-9a-f]{64}$/);
    expect(csrf).toMatch(/^[0-9a-f]{64}$/);
    expect(sid).not.toBe(csrf);
    expect(mgr.check(reqWith(cookie(sid)))?.sid).toBe(sid);
    expect(mgr.check(reqWith(cookie('deadbeef')))).toBeNull();
    expect(mgr.check(reqWith())).toBeNull();
  });

  it('enforces a SLIDING inactivity TTL (activity refreshes, inactivity expires)', () => {
    let t = 1000;
    const mgr = new AdminSessionManager({ now: () => t, ttlMs: 100 });
    const { sid } = mgr.create('ip');
    t = 1050;
    expect(mgr.check(reqWith(cookie(sid)))).not.toBeNull(); // refreshes lastSeen -> 1050
    t = 1140;
    expect(mgr.check(reqWith(cookie(sid)))).not.toBeNull(); // 90ms since last activity -> ok, refresh -> 1140
    t = 1300;
    expect(mgr.check(reqWith(cookie(sid)))).toBeNull(); // 160ms idle > TTL -> expired + purged
    expect(mgr.size).toBe(0);
  });

  it('checks CSRF constant-time against the session token', () => {
    const mgr = new AdminSessionManager({ now: () => 1 });
    const { sid, csrf } = mgr.create('ip');
    const s = mgr.check(reqWith(cookie(sid)))!;
    expect(mgr.csrfOk(reqWith(cookie(sid), csrf), s)).toBe(true);
    expect(mgr.csrfOk(reqWith(cookie(sid), 'wrong'), s)).toBe(false);
    expect(mgr.csrfOk(reqWith(cookie(sid)), s)).toBe(false); // header absent
  });

  it('caps concurrent sessions with LRU eviction', () => {
    let t = 0;
    const mgr = new AdminSessionManager({ now: () => t, maxSessions: 2 });
    t = 1;
    const a = mgr.create('ip');
    t = 2;
    mgr.create('ip');
    t = 3;
    const c = mgr.create('ip'); // evicts the oldest (a)
    expect(mgr.size).toBe(2);
    expect(mgr.check(reqWith(cookie(a.sid)))).toBeNull();
    expect(mgr.check(reqWith(cookie(c.sid)))).not.toBeNull();
  });

  it('exposes hardened Hapi cookie options (HttpOnly, SameSite=Strict, Path=/admin)', () => {
    const secure = new AdminSessionManager({ secureCookie: true }).stateOptions();
    expect(secure.isHttpOnly).toBe(true);
    expect(secure.isSameSite).toBe('Strict');
    expect(secure.path).toBe('/admin');
    expect(secure.encoding).toBe('none');
    expect(secure.isSecure).toBe(true);
    // Secure is opt-in (default off for plain-HTTP local dev).
    expect(new AdminSessionManager().stateOptions().isSecure).toBe(false);
    expect(AdminSessionManager.cookiePath).toBe('/admin');
  });
});
