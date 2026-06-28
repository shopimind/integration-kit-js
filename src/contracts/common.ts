/** Localized text, e.g. `{ fr: "Clients", en: "Customers" }`. */
export interface Localized {
  fr?: string;
  en?: string;
  [lang: string]: string | undefined;
}

/**
 * Raw map of configuration values received in lifecycle payloads.
 * An integration transforms it into typed `Settings` via `parseSettings` (zod).
 */
export type RawConfigs = Record<string, unknown>;
