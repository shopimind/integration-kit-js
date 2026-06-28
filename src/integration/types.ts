import type {
  ConfigSchema,
  RawConfigs,
  WidgetDeclaration,
  NewDataSource,
  NewCustomDataDefinition,
  NewEvent,
  SpmOrderStatus,
} from '../contracts/index.js';
import type { SpmHttpClient } from '@shopimind/sdk-js';
import type { SourceHandle } from '../sdk/source-scope.js';
import type { SendBulk } from '../sdk/send-bulk.js';
import type { CustomDataHandle } from '../sdk/custom-data-scope.js';
import type { IntegrationStateRepo } from '../store/repositories.js';
import type { CursorRow } from '../store/types.js';
import type { Logger } from '../logging/logger.js';
import type { PaginateOptions } from '../sync/paginate.js';

/**
 * Integration metadata (feeds the manifest).
 */
export interface IntegrationMeta {
  name: string;
  version: string;
  categories?: string[];
  icon_url?: string;
  short_description?: string;
  description?: string;
  /** An integration may require external auth (OAuth). Defaults to false. */
  requires_external_auth?: boolean;
  documentation_url?: string;
}

export interface RemoteOption {
  value: string;
  label: string;
}

/** Context injected into an integration: typed settings, typed SDK, encrypted state, redacting logger. */
export interface IntegrationContext<S> {
  /** OPAQUE installation token, issued by ShopiMind. Never interpret it. */
  installationId: string;
  settings: S;
  /** Ready-to-use ShopiMind SDK client (`SpmCustomers.bulkSave(ctx.spm, ...)`). */
  spm: SpmHttpClient;
  /**
   * Safe bulk push (envelope + rejection handling), usable here AND in sync steps.
   * Throws on a transport failure; surfaces per-item rejections — never drops them.
   * In a sync step, the rejections it reports HOLD the cursor (no silent data loss).
   *   `ctx.sendBulk(SpmCustomDataRecords.bulkSave, records)`
   */
  sendBulk: SendBulk;
  state: IntegrationStateRepo;
  logger: Logger;
  /** Records the INTEGRATOR account tied to this installation (correlation bridge). */
  setExternalAccount(account: { id: string; name?: string | null }): void;
  /**
   * PER-INSTALLATION HMAC secret for inbound routes (middleware). Pass it to the
   * integrator's app (typically in `onActivate`) so it can sign its inbound calls.
   * `''` in an ephemeral context (configuration assistant).
   */
  inboundSecret: string;
  /**
   * Handle SCOPED TO A PROVISIONED SOURCE: automatically tags each pushed catalog
   * entity with its `id_data_source` (prevents overwriting native data).
   * `sourceKey` must match a source declared in `provisioning.dataSources`.
   * (Also namespace your identifiers: the source alone does not isolate them.)
   */
  withSource(sourceKey: string): SourceHandle;
  /**
   * Handle for a PROVISIONED custom data definition (declared in
   * `provisioning.customData`): its numeric `id` plus a safe `save(records)`.
   * `name` must match a definition declared in `provisioning.customData`.
   * The custom-data counterpart of {@link IntegrationContext.withSource}.
   */
  customData(name: string): CustomDataHandle;
}

export interface SyncWindow {
  since: Date | null;
  until: Date;
}

/** Context for a sync step: window derived from the cursor + bounded primitives. */
export interface SyncStepContext<S> extends IntegrationContext<S> {
  entity: string;
  /** '' for the global scope; a source id (e.g. store) for 'per-source'. */
  sourceKey: string;
  window: SyncWindow;
  cursor: CursorRow | null;
  /** Streaming pagination (avoids OOM). */
  paginate<T>(fetchPage: (page: number) => Promise<T[]>, opts?: PaginateOptions): AsyncGenerator<T, void, void>;
  /** Map with bounded concurrency (avoids 429s). */
  mapConcurrent<I, O>(items: Iterable<I>, limit: number, fn: (item: I, index: number) => Promise<O>): Promise<O[]>;
}

export interface SyncStepResult {
  items: number;
  errors: string[];
  /** Bound up to which the cursor should advance IF the run is clean. */
  advanceCursorTo?: Date;
}

/**
 * A synchronization step. The ENGINE manages the cursor (advances only if
 * `errors` is empty) and the source iteration: the integration never touches
 * the cursor.
 */
export interface SyncStep<S> {
  entity: string;
  cursorScope: 'global' | 'per-source';
  /**
   * By default, per-item rejections reported during the step HOLD the cursor (the
   * window is replayed next run) — no silent data loss. Set `true` for a windowed
   * stream where a PERMANENT rejection (a malformed item the API always rejects)
   * would otherwise freeze the window forever ("poison pill"). Even when `true`,
   * rejections are still surfaced (logged + counted); only the cursor may advance.
   */
  tolerateRejects?: boolean;
  enabled(settings: S): boolean;
  /** For 'per-source': the source keys to iterate over (e.g. store ids). */
  sources?(ctx: IntegrationContext<S>): Promise<string[]> | string[];
  run(ctx: SyncStepContext<S>): Promise<SyncStepResult>;
}

/** ShopiMind resources to ensure on activation (find-or-create by the kit). */
export interface ProvisioningPlan {
  /** `parentKey` references another source in the same plan (resolved to `parent_id`). */
  dataSources?: Array<{ key: string; decl: NewDataSource; parentKey?: string }>;
  customData?: NewCustomDataDefinition[];
  events?: NewEvent[];
  orderStatuses?: SpmOrderStatus[];
}

export interface LifecycleHooks<S> {
  onInstall?(ctx: IntegrationContext<S>): Promise<void> | void;
  onActivate?(ctx: IntegrationContext<S>): Promise<void> | void;
  onDeactivate?(ctx: IntegrationContext<S>): Promise<void> | void;
  onUninstall?(ctx: IntegrationContext<S>): Promise<void> | void;
  onConfigUpdated?(ctx: IntegrationContext<S>): Promise<void> | void;
}

/**
 * The author contract. An integration only writes pure functions + typed
 * declarations, passed to `defineIntegration`.
 */
export interface Integration<S> {
  slug: string;
  meta: IntegrationMeta;
  configSchema: ConfigSchema;
  parseSettings(raw: RawConfigs): S;
  testConnection(ctx: IntegrationContext<S>): Promise<boolean>;
  remoteData?: Record<string, (ctx: IntegrationContext<S>) => Promise<RemoteOption[]>>;
  provisioning?(ctx: IntegrationContext<S>): ProvisioningPlan | Promise<ProvisioningPlan>;
  widgets?: WidgetDeclaration[];
  syncSteps: SyncStep<S>[];
  hooks?: LifecycleHooks<S>;
  /**
   * INBOUND routes (the middleware): the integrator's app calls them to trigger
   * an event / push data in REAL TIME. The kit authenticates (per-installation
   * HMAC), resolves the installation and provides `ctx` (with `ctx.spm` ready).
   * Each handler is GENERIC: it does whatever it wants through `ctx.spm` via the
   * SDK (`SpmEvents.trigger(ctx.spm, ...)`, `SpmCustomDataRecords.bulkSave(ctx.spm, ...)`...).
   * Exposed at `POST /inbound/{action}`.
   */
  inbound?: Record<string, (ctx: IntegrationContext<S>, payload: unknown) => Promise<void> | void>;
}
