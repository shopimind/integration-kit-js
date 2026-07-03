import type { Integration } from './types.js';
import type { ConfigSchema, WidgetDeclaration } from '../contracts/index.js';

/**
 * A SERIALIZABLE snapshot of what an integration declares, for the admin
 * "Definition" view. Functions (`run`, `enabled`, hook bodies…) are never
 * included — only their presence/shape — so the whole thing is safe to JSON.
 */
export interface SyncStepInfo {
  entity: string;
  cursorScope: string;
  /** True when the step has an `enabled(settings)` guard (conditional). */
  guarded: boolean;
  tolerateRejects: boolean | { maxRatio: number } | null;
}

export interface IntegrationDescriptor {
  slug: string;
  meta: {
    name: string;
    version: string;
    categories: string[];
    short_description: string | null;
    description: string | null;
    icon_url: string | null;
    documentation_url: string | null;
    requires_external_auth: boolean;
  };
  configSchema: ConfigSchema | null;
  syncSteps: SyncStepInfo[];
  widgets: WidgetDeclaration[];
  /** Inbound route action names (exposed at `POST /inbound/{action}`). */
  inbound: string[];
  /** Lifecycle hook names that are implemented. */
  hooks: string[];
  /** `remoteData` provider keys (dynamic select options). */
  remoteData: string[];
  capabilities: { provisioning: boolean; testConnection: boolean; remoteData: boolean; widgets: boolean; inbound: boolean };
}

/** Extracts the serializable declaration of an integration (no function bodies). */
export function describeIntegration<S>(i: Integration<S>): IntegrationDescriptor {
  const m = i.meta ?? ({ name: i.slug, version: '0.0.0' } as Integration<S>['meta']);
  const inbound = Object.keys(i.inbound ?? {});
  const widgets = i.widgets ?? [];
  return {
    slug: i.slug,
    meta: {
      name: m.name,
      version: m.version,
      categories: m.categories ?? [],
      short_description: m.short_description ?? null,
      description: m.description ?? null,
      icon_url: m.icon_url ?? null,
      documentation_url: m.documentation_url ?? null,
      requires_external_auth: m.requires_external_auth ?? false,
    },
    configSchema: i.configSchema ?? null,
    syncSteps: (i.syncSteps ?? []).map((s) => ({
      entity: s.entity,
      cursorScope: s.cursorScope,
      guarded: typeof s.enabled === 'function',
      tolerateRejects: s.tolerateRejects ?? null,
    })),
    widgets,
    inbound,
    hooks: Object.keys(i.hooks ?? {}),
    remoteData: Object.keys(i.remoteData ?? {}),
    capabilities: {
      provisioning: typeof i.provisioning === 'function',
      testConnection: typeof i.testConnection === 'function',
      remoteData: Object.keys(i.remoteData ?? {}).length > 0,
      widgets: widgets.length > 0,
      inbound: inbound.length > 0,
    },
  };
}
