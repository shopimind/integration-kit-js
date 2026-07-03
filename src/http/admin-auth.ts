import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request } from '@hapi/hapi';

/**
 * Admin authentication primitives, shared by the admin HTTP routes and the
 * admin session manager. A single, audited place
 * owns how the admin token is compared and how the client IP is derived.
 */

/** Ephemeral (per-process) HMAC key to compare the admin token at fixed length. */
const ADMIN_CMP_KEY = randomBytes(32);

/**
 * Constant-time comparison WITHOUT length leakage: both sides are hashed to a
 * fixed-size HMAC digest first, so neither the timing nor the comparison reveals
 * the secret's length. Use for any token/secret equality check.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHmac('sha256', ADMIN_CMP_KEY).update(a).digest();
  const db = createHmac('sha256', ADMIN_CMP_KEY).update(b).digest();
  return timingSafeEqual(da, db);
}

/** The admin token presented by the request via `x-admin-token` or `Authorization: Bearer`, or ''. */
export function presentedToken(req: Request): string {
  const x = req.headers['x-admin-token'];
  if (typeof x === 'string' && x) return x;
  const auth = req.headers.authorization;
  return typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : '';
}

/**
 * True when the request carries the admin token, read from `x-admin-token` or an
 * `Authorization: Bearer <token>` header and compared timing-safe. Returns false
 * when no token is configured (fail-closed) or none is presented.
 */
export function adminOk(req: Request, token?: string | null): boolean {
  if (!token) return false;
  const presented = presentedToken(req);
  if (!presented) return false;
  return constantTimeEqual(presented, token);
}

/** Best-effort client IP for the per-IP admin/webhook rate limiters. */
export const clientIp = (req: Request): string => req.info?.remoteAddress || 'unknown';
