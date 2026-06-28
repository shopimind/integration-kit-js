import type { Localized } from './common.js';

/**
 * Reference to a remote-data resolver for a dynamic select.
 * The integration exposes a `remoteData[resource]` resolver; ShopiMind calls
 * `POST /webhook/remote-data/{resource}` and populates the select with the options.
 *
 * A dynamic select is declared via a structured `remote: RemoteRef`; the three
 * fields `resource`, `label_field` and `value_field` are required.
 */
export interface RemoteRef {
  resource: string;
  label_field: string;
  value_field: string;
  description_field?: string;
}

/** Scalar field types of an installation form. */
export type ConfigFieldType =
  | 'text'
  | 'password'
  | 'email'
  | 'url'
  | 'number'
  | 'checkbox'
  | 'textarea'
  | 'datetime';

export type ConfigSelectType = 'select' | 'multiselect';

export interface ConfigOption {
  value: string;
  label?: string | Localized;
}

interface ConfigFieldBase {
  key: string;
  required?: boolean;
  label: Localized;
  help?: Localized;
  default?: string | number | boolean;
  /** `integrator` = set by the integrator via the API, hidden from the merchant. */
  owner?: 'merchant' | 'integrator';
  /** Sensitive value -> encrypted at rest, never exposed to the front-end or widgets. */
  sensitive?: boolean;
  /** The field accepts a ShopiMind variable `{var=...}`. */
  supports_variables?: boolean;
}

/** Scalar field (text, number, checkbox, date, ...). */
export interface ScalarConfigField extends ConfigFieldBase {
  type: ConfigFieldType;
}

/**
 * Select / multiselect field. Options are STATIC (`options`) OR dynamic
 * (`remote: RemoteRef`). There is no other form — in particular, no `remote_data`.
 */
export interface SelectConfigField extends ConfigFieldBase {
  type: ConfigSelectType;
  options?: ConfigOption[];
  remote?: RemoteRef;
}

export type ConfigField = ScalarConfigField | SelectConfigField;

/** Action triggered on step completion (e.g. validate the connection). */
export interface StepAction {
  action: 'test_connection';
}

/** A step of the configuration wizard. */
export interface ConfigStep {
  /**
   * Step identifier. Recommended: makes step validation tracking reliable, as it
   * relies on `step.key`.
   */
  key?: string;
  label: Localized;
  description?: Localized;
  fields: ConfigField[];
  on_complete?: StepAction;
}

export interface ConfigGroup {
  label?: Localized;
  fields: ConfigField[];
}

/**
 * Configuration schema of an integration: either a wizard (`steps`), a flat list
 * (`fields`), or groups (`groups`).
 */
export interface ConfigSchema {
  steps?: ConfigStep[];
  fields?: ConfigField[];
  groups?: ConfigGroup[];
}
