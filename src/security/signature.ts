import { SpmWebhookSignature } from '@shopimind/sdk-js';

/**
 * HMAC signature verification for incoming webhooks.
 *
 * The algorithm (HMAC-SHA256 over `${timestamp}.${rawBody}`, constant-time
 * comparison, asymmetric anti-replay window) is provided by `SpmWebhookSignature`
 * from the SDK. This module only binds the headers to that scheme:
 *  - ShopiMind -> integration (lifecycle webhooks): `x-shopimind-*` headers,
 *    secret = `webhook_secret` (shared between ShopiMind and the integration);
 *  - Integrator app -> integration (inbound routes / middleware): `x-integration-*`
 *    headers, PER-INSTALLATION secret (never the ShopiMind API token).
 */

export interface SignatureCheck {
  ok: boolean;
  reason?: string;
}

export interface SignatureOptions {
  secret: string;
  /** Anti-replay window in seconds (default 300). */
  toleranceSeconds?: number;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
}

const SHOPIMIND_TIMESTAMP_HEADER = 'x-shopimind-timestamp';
const SHOPIMIND_SIGNATURE_HEADER = 'x-shopimind-signature';
const INTEGRATION_TIMESTAMP_HEADER = 'x-integration-timestamp';
const INTEGRATION_SIGNATURE_HEADER = 'x-integration-signature';

/** Verifies a ShopiMind -> integration webhook (`x-shopimind-*` headers). */
export function verifyShopimindSignature(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  opts: SignatureOptions,
): SignatureCheck {
  return SpmWebhookSignature.verifyFromHeaders(rawBody, headers, opts.secret, {
    timestampHeader: SHOPIMIND_TIMESTAMP_HEADER,
    signatureHeader: SHOPIMIND_SIGNATURE_HEADER,
    toleranceSeconds: opts.toleranceSeconds,
    now: opts.now,
  });
}

/**
 * Verifies an inbound integrator-app -> integration call (`x-integration-*` headers).
 * The `secret` is resolved PER-INSTALLATION by the caller.
 */
export function verifyIntegratorSignature(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  opts: SignatureOptions,
): SignatureCheck {
  return SpmWebhookSignature.verifyFromHeaders(rawBody, headers, opts.secret, {
    timestampHeader: INTEGRATION_TIMESTAMP_HEADER,
    signatureHeader: INTEGRATION_SIGNATURE_HEADER,
    toleranceSeconds: opts.toleranceSeconds,
    now: opts.now,
  });
}

/** Builds the signature for a body (`${ts}.${body}`). */
export function signShopimindBody(rawBody: string, secret: string, timestampSeconds: number): string {
  return SpmWebhookSignature.sign(rawBody, secret, timestampSeconds);
}
