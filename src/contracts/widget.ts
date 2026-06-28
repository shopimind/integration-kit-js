import type { Localized } from './common.js';

/**
 * Integration widget declarations.
 *
 * Any deviation of an integration from this contract breaks compilation rather
 * than producing a silently invalid declaration.
 */

export type WidgetLocalizedText = Localized;

export type WidgetTarget =
  | 'email_template'
  | 'popup'
  | 'smart_content'
  | 'stats_dashboard';

export type WidgetRenderType = 'image' | 'html';

/** Applicable only to `render_type: html`. */
export type WidgetRenderMode = 'static' | 'dynamic';

export type WidgetConfigFieldType =
  | 'text'
  | 'number'
  | 'color'
  | 'select'
  | 'checkbox'
  | 'datetime';

export interface WidgetConfigFieldOption {
  value: string;
  label?: string | WidgetLocalizedText;
}

export interface WidgetConfigField {
  key: string;
  type: WidgetConfigFieldType;
  default?: string | number | boolean;
  label?: WidgetLocalizedText;
  options?: WidgetConfigFieldOption[];
  /** The field accepts a ShopiMind variable `{var=...}`. */
  supports_variables?: boolean;
  /** Text translated per language (html widgets) — resolved via a `{LANG_...}` token. */
  translatable?: boolean;
  /** Sample value for the image preview when the field carries a `{var=...}`. */
  preview_value?: string;
  /** `type: color` — emits the hex WITHOUT `#` (for image URLs). */
  strip_hash?: boolean;
  /** Conditional visibility: show when the sibling field matches one of the values. */
  visible_when?: { field: string; in: string[] };
  /** Re-parses the panel when THIS field changes (drives `visible_when`). */
  refresh_fields?: boolean;
}

export interface WidgetConfigGroup {
  label?: WidgetLocalizedText;
  fields: WidgetConfigField[];
}

export interface WidgetConfigSchema {
  fields?: WidgetConfigField[];
  groups?: WidgetConfigGroup[];
  style_groups?: WidgetConfigGroup[];
}

/** A widget declaration exposed by the integration. */
export interface WidgetDeclaration {
  key: string;
  name: WidgetLocalizedText;
  description?: WidgetLocalizedText;
  icon_url?: string;
  preview_image_url?: string;
  targets: WidgetTarget[];
  render_type: WidgetRenderType;
  /** `render_type: html` only (omitted for `image`). */
  render_mode?: WidgetRenderMode;
  /** `render_type: image`. */
  image_url_template?: string;
  /** `render_type: html` + `render_mode: static`. */
  html_template?: string;
  /** `render_type: html` + `render_mode: static` (optional). */
  css_template?: string;
  /** `render_type: html` + `render_mode: dynamic` — key of a ShopiMind renderer. */
  renderer_key?: string;
  default_width?: number;
  config_schema?: WidgetConfigSchema;
}
