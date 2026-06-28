/**
 * Authoring types specific to the kit (provisioning declarations + shapes the
 * integration builds). Entity types and the envelope come from the SDK
 * (`@shopimind/sdk-js`, re-exported by the kit).
 */

/** Declaration of a data source to ensure (provisioning). */
export interface NewDataSource {
  label: string;
  type: string;
  parent_id?: number;
  config?: string;
}

/**
 * Canonical type of a custom data field, aligned with the ShopiMind API / SDK.
 *
 * This union is the kit's OWN AUTHORING allow-list, deliberately kept distinct
 * from the SDK DTO's field-type type. We restate it here so the author contract
 * stays stable even if the SDK DTO widens/renames its variants, and so the
 * compile-time error a user gets points at the kit (their dependency) rather than
 * leaking the underlying SDK type. Keep the two in sync when a new type lands.
 */
export type CustomDataFieldType =
  | 'bool'
  | 'text'
  | 'longtext'
  | 'number'
  | 'decimal'
  | 'list'
  | 'date'
  | 'datetime'
  | 'json'
  | 'geolocation';

export interface NewCustomDataField {
  name: string;
  /** Display label (default: `name`). */
  label?: string;
  type: CustomDataFieldType;
  /** Required field (default: false). */
  required?: boolean;
  description?: string;
  default?: unknown;
  options?: Array<string | number>;
}

export interface NewCustomDataDefinition {
  /** Technical name (e.g. `pos_profile`). Sent as-is to the API (`name` field). */
  name: string;
  description?: string;
  unique_keys?: string[];
  fields: NewCustomDataField[];
  relationships?: Array<{ target: string; by: string }>;
}

/** Order status to provision (declaration). */
export interface SpmOrderStatus {
  status_id: string;
  lang: string;
  name: string;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
  id_data_source?: number;
}

/**
 * Declaration of an event type (provisioned on activation).
 *
 * Note on `name`: the ShopiMind API accepts an i18n map (`{ en: 'POS sale', fr: 'Vente POS' }`),
 * so the kit types it as `Record<string, string>`. The SDK's create DTO types
 * `name` narrowly as `string`, hence the intentional `as unknown` cast at the
 * single call site (`ensureEvent` in `provisioning/ensure.ts`): the runtime
 * payload is correct, only the SDK's compile-time type is too tight here.
 */
export interface NewEvent {
  code_name: string;
  name: Record<string, string>;
  properties?: Record<string, unknown>;
}
