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
  /**
   * STABLE MATCHING KEY (E16). Name of a property inside the source's `config`
   * (parsed as JSON) that uniquely and PERMANENTLY identifies this source — e.g.
   * `'hiboutik_store_id'`. When set, `ensureDataSource` matches an existing source by
   * `config[stableConfigKey]` FIRST, falling back to the `label` only if no config
   * match is found. This lets a source survive a LABEL RENAME (a merchant renaming
   * their store no longer spawns a duplicate; the existing source's label is updated
   * to the new one). Omit it to keep the legacy label-only behaviour unchanged.
   *
   * This field is kit-only authoring metadata: it is NOT forwarded to the API.
   */
  stableConfigKey?: string;
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
  /**
   * Schema-level relationships to other definitions (forwarded as-is to the API).
   * `sourceField` is a field of THIS definition; it links to `targetSchema` — a
   * `'system'` schema (e.g. `contacts`, `products`) or another `'custom'` definition.
   * For a custom target, `targetSchema` is the target's numeric id — OR, inside a
   * `provisioning.customData` plan, the NAME of a sibling definition (declared before
   * this one), which the kit resolves to its id at creation. Optionally matched on
   * `targetField` (defaults to the target's id). `custom`→`custom` is supported.
   */
  relationships?: Array<{
    sourceField: string;
    targetSchemaType: 'system' | 'custom';
    targetSchema: string;
    targetField?: string;
  }>;
}

/**
 * Order status to provision (declaration).
 *
 * `status_id`, `lang` and `name` are the AUTHORING essentials. The technical
 * bookkeeping fields (`is_deleted`, `created_at`, `updated_at`) are OPTIONAL (E11):
 * the kit fills sensible defaults at provisioning time (`is_deleted: false`,
 * timestamps: now), so an author no longer has to hand-write ceremony the API needs
 * but the integration doesn't care about. Supplying them explicitly still works.
 */
export interface SpmOrderStatus {
  status_id: string;
  lang: string;
  name: string;
  is_deleted?: boolean;
  created_at?: string;
  updated_at?: string;
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
