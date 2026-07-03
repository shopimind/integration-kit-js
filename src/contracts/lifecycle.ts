import type { RawConfigs } from './common.js';

/**
 * Lifecycle events sent by ShopiMind (discriminant `event`, in the past tense),
 * HMAC-signed.
 */
export type LifecycleEvent =
  | 'integration.installed'
  | 'integration.activated'
  | 'integration.deactivated'
  | 'integration.uninstalled'
  | 'integration.config_updated';

/**
 * Common fields of a lifecycle webhook payload.
 *
 * IDENTITY CONTRACT — `installation_id` is the SINGLE source of truth. It is the
 * OPAQUE token ShopiMind issues per installation; the integration never
 * interprets it, it only correlates by it (see the store schema). ShopiMind sends
 * `{ event, installation_id, ... }` — nothing else is required to route the event.
 *
 * The `id_shop_integration` numeric alias is LEGACY: it predates the opaque token
 * and is kept ONLY so an older ShopiMind deployment (or an old fixture) that still
 * emits it keeps working. The dispatcher reads `installation_id` FIRST and falls
 * back to `id_shop_integration` only when the opaque token is absent. New payloads
 * must not rely on it.
 */
export interface LifecyclePayloadBase {
  event: LifecycleEvent;
  /** OPAQUE installation token — the required identity of the installation. */
  installation_id: string;
  /**
   * @deprecated Legacy numeric alias for `installation_id`. Retained for
   * backward compatibility with older ShopiMind deployments/fixtures; the
   * dispatcher only uses it as a fallback when `installation_id` is absent.
   */
  id_shop_integration?: number;
  /**
   * @deprecated ShopiMind-internal shop id. Never sent by the current wire format
   * and never needed by an integration (which correlates by `installation_id`).
   * Kept optional so an old payload carrying it does not fail to type-check.
   */
  id_shop?: number;
  /**
   * @deprecated The integration already knows its own slug (`integration.slug`);
   * ShopiMind does not send this. Kept optional for backward compatibility only.
   */
  integration_slug?: string;
  shop_domain?: string;
  shop_name?: string;
}

export interface InstallPayload extends LifecyclePayloadBase {
  event: 'integration.installed';
  /** The API key (prefix `int...`) — received here, must be persisted: it is not sent again. */
  access_token?: string;
  configs?: RawConfigs;
  installed_at?: string;
  /** OAuth variant (Type B): no id_shop_integration at install time. */
  external_account_id?: string;
  external_account_name?: string;
}

export interface ActivatePayload extends LifecyclePayloadBase {
  event: 'integration.activated';
  access_token?: string;
  configs?: RawConfigs;
  activated_at?: string;
}

export interface DeactivatePayload extends LifecyclePayloadBase {
  event: 'integration.deactivated';
  deactivated_at?: string;
}

export interface UninstallPayload extends LifecyclePayloadBase {
  event: 'integration.uninstalled';
  uninstalled_at?: string;
}

export interface ConfigUpdatedPayload extends LifecyclePayloadBase {
  event: 'integration.config_updated';
  configs?: RawConfigs;
}

export type LifecyclePayload =
  | InstallPayload
  | ActivatePayload
  | DeactivatePayload
  | UninstallPayload
  | ConfigUpdatedPayload;

/**
 * Response expected by ShopiMind: MUST contain `success: true`, otherwise the
 * call is treated as a failure (and, depending on the event, the key may be revoked).
 */
export interface WebhookResponse {
  success: boolean;
  error?: string;
  [k: string]: unknown;
}

/** Response from a remote-data resolver: populates a select in the config wizard. */
export interface RemoteDataResponse {
  data: Array<{ value: string; label: string }>;
}
