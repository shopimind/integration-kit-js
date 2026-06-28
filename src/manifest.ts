import type { Integration } from './integration/types.js';
import type { ConfigSchema, WidgetDeclaration } from './contracts/index.js';

/**
 * Integration manifest: a NEUTRAL, portable description of an integration,
 * derived entirely from `defineIntegration`. It describes the integration
 * without coupling to a deployment: no secret, no status, no absolute URL
 * (endpoints are relative paths, the baseUrl is added at registration time).
 *
 * KNOWN LIMITATIONS (manifest v1):
 * - It does NOT describe the integration's declared INBOUND routes
 *   (`Integration.inbound`): only the fixed lifecycle/test/remote webhooks are
 *   listed. Consumers cannot discover the available `POST /inbound/{action}`
 *   endpoints from the manifest alone.
 * - It does NOT describe widget ENDPOINTS: `widgets` carries the declarations as
 *   authored, but any backing endpoint/route a widget needs is not surfaced here.
 * Both are expected to be addressed in a future manifest version.
 */
export interface IntegrationManifest {
  manifest_version: 1;
  slug: string;
  name: string;
  version: string;
  /** NEUTRAL category keys (e.g. `'pos'`). */
  categories?: string[];
  icon_url?: string;
  short_description?: string;
  description?: string;
  documentation_url?: string;
  /**
   * EXPERIMENTAL flag: signals the integration expects external auth (OAuth).
   * It is purely advisory for now — the OAuth flow is NOT wired into the runtime,
   * so setting it does not yet change activation/auth behavior. Treat as unstable
   * until the runtime supports it.
   */
  requires_external_auth?: boolean;
  config_schema: ConfigSchema;
  widgets: WidgetDeclaration[];
  /** RELATIVE endpoint paths (never an absolute URL: the baseUrl is added at deployment). */
  webhooks: {
    lifecycle: string;
    test_connection: string;
    remote_data: string;
  };
  /** Handled lifecycle events (fixed contract). */
  lifecycle_events: string[];
  /** Declared `remoteData` resources (keys). */
  remote_resources: string[];
}

/** Fixed lifecycle events of the protocol. */
const LIFECYCLE_EVENTS = ['install', 'activate', 'deactivate', 'uninstall', 'config_updated'];

/**
 * Derives the neutral manifest of an integration. PURE function (deterministic).
 */
export function buildIntegrationManifest<S>(integration: Integration<S>): IntegrationManifest {
  const m = integration.meta;
  const manifest: IntegrationManifest = {
    manifest_version: 1,
    slug: integration.slug,
    name: m.name,
    version: m.version,
    config_schema: integration.configSchema,
    widgets: integration.widgets ?? [],
    webhooks: {
      lifecycle: '/webhook/receive',
      test_connection: '/webhook/test-connection',
      remote_data: '/webhook/remote-data/{resource}',
    },
    lifecycle_events: [...LIFECYCLE_EVENTS],
    remote_resources: Object.keys(integration.remoteData ?? {}),
  };
  if (m.categories !== undefined) manifest.categories = m.categories;
  if (m.icon_url !== undefined) manifest.icon_url = m.icon_url;
  if (m.short_description !== undefined) manifest.short_description = m.short_description;
  if (m.description !== undefined) manifest.description = m.description;
  if (m.documentation_url !== undefined) manifest.documentation_url = m.documentation_url;
  if (m.requires_external_auth !== undefined) manifest.requires_external_auth = m.requires_external_auth;
  return manifest;
}
