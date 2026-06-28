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

export interface LifecyclePayloadBase {
  event: LifecycleEvent;
  id_shop_integration: number;
  id_shop?: number;
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
