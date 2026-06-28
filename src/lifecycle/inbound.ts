import { randomBytes } from 'node:crypto';
import { verifyIntegratorSignature, type SignatureOptions } from '../security/signature.js';
import type { Integration, IntegrationContext } from '../integration/types.js';
import type { IntegrationStateRepo, Repositories } from '../store/repositories.js';
import type { Logger } from '../logging/logger.js';

/** State key where the PER-INSTALLATION HMAC secret for inbound routes lives. */
export const INBOUND_SECRET_KEY = '__inbound_secret';

const INSTALLATION_HEADER = 'x-integration-installation';
const SIGNATURE_HEADER = 'x-integration-signature';
const IDEMPOTENCY_HEADER = 'x-idempotency-key';
/**
 * Dummy secret to pay the HMAC cost on an unknown installation (anti-timing).
 * NON-SENSITIVE CONSTANT: this value is not a credential and never validates any
 * request. It exists solely to spend the same CPU as a real verification so an
 * attacker cannot distinguish "unknown installation" from "bad signature" by
 * timing. Leaking it is harmless; it grants no access.
 */
const DUMMY_SECRET = 'insec_unknown_installation_constant_time_guard';

/** Lazily ensures a per-installation inbound secret, encrypted at rest; returns it. */
export function ensureInboundSecret(state: IntegrationStateRepo, installationId: string): string {
  const existing = state.get(installationId, INBOUND_SECRET_KEY);
  if (existing) return existing;
  const secret = 'insec_' + randomBytes(24).toString('hex');
  state.setSecret(installationId, INBOUND_SECRET_KEY, secret);
  return secret;
}

export interface InboundDeps<S> {
  integration: Integration<S>;
  repos: Repositories;
  logger: Logger;
  /** Builds the context for an installation (decrypted token, `ctx.spm` ready) or null. */
  buildContext(installationId: string): IntegrationContext<S> | null;
  toleranceSeconds?: number;
  /** Returns true if the call is allowed (per-installation rate limit). */
  rateLimit?(installationId: string): boolean;
  now?: () => number;
}

export interface InboundResult {
  status: number;
  body: { success: boolean; error?: string; replayed?: boolean };
}

const ok = (extra: { replayed?: boolean } = {}): InboundResult => ({ status: 200, body: { success: true, ...extra } });
const fail = (status: number, error: string): InboundResult => ({ status, body: { success: false, error } });

/**
 * Handles an INBOUND call (integrator app -> integration). Enforced pipeline:
 * per-installation HMAC auth -> rate limit -> idempotency (persisted) -> handler
 * with a ready `ctx`. The ShopiMind API token is NEVER exposed to the caller.
 *
 * Return codes:
 * - 200 'success': handler ran and finished 'done' (status 'done'); OR an
 *   already-processed replay (`replayed: true`) short-circuited via the prior
 *   'done' fast-path, or via a non-fresh claim whose status is 'done'
 *   (replayed) or 'received' (a concurrent attempt is still in progress).
 * - 400 'missing_installation_header' / 'invalid_json': malformed request.
 * - 401 'unauthorized': unknown installation (no secret) OR signature mismatch.
 *   The reason is opaque to the caller and only logged server-side.
 * - 404 'unknown_action': no inbound handler registered for `action`.
 * - 409 'no_context': `buildContext` returned null — the installation exists and
 *   is authenticated, but its context cannot be built right now (e.g. missing
 *   access_token / not activated). The caller MAY retry later once activated;
 *   nothing is claimed or executed in this case.
 * - 429 'rate_limited': per-installation rate limit tripped.
 * - 500 'internal_error': the handler threw. The attempt is persisted 'failed'
 *   so a later identical call (same dedup key) RE-EXECUTES the handler; the
 *   caller can safely retry. Idempotency only dedupes on success ('done').
 */
export async function handleInbound<S>(
  action: string,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  deps: InboundDeps<S>,
): Promise<InboundResult> {
  const installationId = headerValue(headers, INSTALLATION_HEADER);
  if (!installationId) return fail(400, 'missing_installation_header');

  const secret = deps.repos.state.get(installationId, INBOUND_SECRET_KEY);
  if (!secret) {
    // OPAQUE 401 + still pay the HMAC cost (anti timing/installation-enumeration
    // oracle). The precise reason stays in the server logs, never in the response.
    verifyIntegratorSignature(rawBody, headers, { secret: DUMMY_SECRET, ...(deps.now ? { now: deps.now } : {}) });
    deps.logger.warn('inbound rejected', { reason: 'unknown_installation', installationId });
    return fail(401, 'unauthorized');
  }

  const sigOpts: SignatureOptions = { secret };
  if (deps.toleranceSeconds != null) sigOpts.toleranceSeconds = deps.toleranceSeconds;
  if (deps.now) sigOpts.now = deps.now;
  const sig = verifyIntegratorSignature(rawBody, headers, sigOpts);
  if (!sig.ok) {
    deps.logger.warn('inbound rejected', { reason: sig.reason ?? 'signature_mismatch', installationId });
    return fail(401, 'unauthorized');
  }

  if (deps.rateLimit && !deps.rateLimit(installationId)) return fail(429, 'rate_limited');

  const handler = deps.integration.inbound?.[action];
  if (!handler) return fail(404, 'unknown_action');

  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return fail(400, 'invalid_json');
  }

  // MANDATORY anti-replay, enforced by the server (never opt-in). The dedup key
  // is, by default, derived from the SIGNATURE (which uniquely binds timestamp+body
  // under the secret) -> any verbatim replay is short-circuited, even without an
  // idempotency header. An `x-idempotency-key` provided by the caller takes
  // precedence (application-level idempotency across possible re-signatures).
  const sigRaw = headerValue(headers, SIGNATURE_HEADER) ?? '';
  const dedupKey = headerValue(headers, IDEMPOTENCY_HEADER) ?? `sig:${action}:${sigRaw}`;

  // Fast path: replay of a call already processed successfully (avoids building the ctx).
  const prior = deps.repos.inboundEvents.find(installationId, dedupKey);
  if (prior && prior.status === 'done') return ok({ replayed: true });

  // Context build BEFORE claiming: if it fails we return 409 'no_context' and
  // claim NOTHING, so a later retry (once the installation is activated) is not
  // wrongly short-circuited as an already-seen replay.
  const ctx = deps.buildContext(installationId);
  if (!ctx) return fail(409, 'no_context');

  // ATOMIC claim before execution (anti-TOCTOU): two concurrent calls cannot
  // execute the handler twice.
  const claim = deps.repos.inboundEvents.claim(installationId, dedupKey, action);
  if (!claim.fresh && claim.status === 'done') return ok({ replayed: true });
  if (!claim.fresh && claim.status === 'received') return ok({ replayed: true }); // already in progress
  // fresh, or a previous 'failed' attempt -> (re)execute by reusing the claimed row.

  try {
    await handler(ctx, payload);
    deps.repos.inboundEvents.finish(claim.rowId, 'done');
    return ok();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.repos.inboundEvents.finish(claim.rowId, 'failed', msg);
    deps.logger.error('inbound handler failed', { action, error: msg });
    return fail(500, 'internal_error');
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}
