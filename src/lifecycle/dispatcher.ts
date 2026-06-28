import type { RawConfigs, WebhookResponse, RemoteDataResponse, ConfigSchema } from '../contracts/index.js';
import type { Integration, IntegrationContext } from '../integration/types.js';
import { SpmClient, type SpmHttpClient } from '@shopimind/sdk-js';
import type { Repositories } from '../store/repositories.js';
import type { Logger } from '../logging/logger.js';
import { verifyShopimindSignature, type SignatureOptions } from '../security/signature.js';
import { redact } from '../security/redaction.js';
import { saveConfigs, loadConfigs, sensitiveKeys } from '../config/config-store.js';
import { runProvisioning } from '../provisioning/runner.js';
import { ensureInboundSecret } from './inbound.js';
import { makeWithSource } from '../sdk/source-scope.js';
import { makeSendBulk } from '../sdk/send-bulk.js';

export const ACCESS_TOKEN_KEY = '__access_token';
/** State key where the provisioning result (sourceIds/defIds) is stored. */
export const PROVISIONING_KEY = '__provisioning';

export interface DispatcherDeps<S> {
  integration: Integration<S>;
  repos: Repositories;
  secret: string;
  toleranceSeconds?: number;
  logger: Logger;
  /** Builds the ShopiMind SDK client for an access_token. */
  makeSpmClient(accessToken: string): SpmHttpClient;
  /** Called after a successful activation (the runtime starts the backfill here). */
  afterActivate?: (installationId: string) => void;
  now?: () => number;
}

export interface HttpResult {
  status: number;
  body: WebhookResponse;
}

interface LifecycleRawPayload {
  event?: string;
  /** Opaque installation token. */
  installation_id?: string;
  id_shop_integration?: number | string;
  shop_domain?: string;
  shop_name?: string;
  access_token?: string;
  configs?: RawConfigs;
  installed_at?: string;
  activated_at?: string;
  deactivated_at?: string;
  uninstalled_at?: string;
}

/** Opaque installation id from the payload. */
function installIdOf(p: LifecycleRawPayload): string | undefined {
  if (p.installation_id != null && p.installation_id !== '') return String(p.installation_id);
  if (p.id_shop_integration != null) return String(p.id_shop_integration);
  return undefined;
}

const EVENT_TO_HANDLER: Record<string, 'install' | 'activate' | 'deactivate' | 'uninstall' | 'config_updated'> = {
  'integration.installed': 'install',
  'integration.activated': 'activate',
  'integration.deactivated': 'deactivate',
  'integration.uninstalled': 'uninstall',
  'integration.config_updated': 'config_updated',
};

/**
 * Entry point for lifecycle webhooks. Verifies the signature against the RAW
 * body, logs a REDACTED payload (secrets never reach the log), then dispatches.
 */
export async function handleWebhook<S>(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  deps: DispatcherDeps<S>,
): Promise<HttpResult> {
  const sigOpts: SignatureOptions = { secret: deps.secret };
  if (deps.toleranceSeconds != null) sigOpts.toleranceSeconds = deps.toleranceSeconds;
  if (deps.now) sigOpts.now = deps.now;
  const sig = verifyShopimindSignature(rawBody, headers, sigOpts);

  let payload: LifecycleRawPayload;
  try {
    payload = rawBody ? (JSON.parse(rawBody) as LifecycleRawPayload) : {};
  } catch {
    deps.repos.webhookLog.log({ event: 'unparseable', signature_ok: sig.ok, payload_json: '[unparseable body omitted]' });
    return { status: 400, body: { success: false, error: 'invalid_json' } };
  }

  // REDACTED log — before any processing, signed or not. Masking by key NAME
  // (`redact`) is not enough: partner secrets declared `sensitive` in the
  // config_schema (e.g. `private_key`, `client_id`, `login`, `pin`...) do not
  // necessarily match the regex and would be written IN CLEAR, bypassing the
  // AES at rest. So first mask the sensitive `configs` per the schema, then redact.
  deps.repos.webhookLog.log({
    event: payload.event ?? 'unknown',
    installation_id: installIdOf(payload) ?? null,
    signature_ok: sig.ok,
    payload_json: JSON.stringify(redact(maskSchemaSecrets(payload, deps.integration.configSchema))),
  });

  if (!sig.ok) {
    // OPAQUE 401: the precise reason stays in the server logs (already logged
    // above via signature_ok), never returned to the caller (anti-calibration).
    deps.logger.warn('webhook rejected', { reason: sig.reason, event: payload.event });
    return { status: 401, body: { success: false, error: 'unauthorized' } };
  }

  const handlerName = payload.event ? EVENT_TO_HANDLER[payload.event] : undefined;
  if (!handlerName) return { status: 200, body: { success: false, error: 'unknown_event' } };

  // Anti-replay: the signature uniquely binds (timestamp, body). We claim this
  // key BEFORE processing; a verbatim replay is short-circuited. The key is
  // RELEASED if processing fails (!success response or exception) so ShopiMind
  // can resend the webhook and it will be reprocessed.
  const installId = installIdOf(payload);
  const dedupKey = headerOf(headers, 'x-shopimind-signature');
  const dedupable = !!(installId && dedupKey);
  if (dedupable && !deps.repos.webhookSeen.claim(installId as string, dedupKey as string)) {
    return { status: 200, body: { success: true } }; // already processed -> harmless replay
  }

  try {
    const body = await runHandler(handlerName, payload, deps);
    if (dedupable && body.success === false) deps.repos.webhookSeen.release(installId as string, dedupKey as string);
    return { status: 200, body };
  } catch (e) {
    if (dedupable) deps.repos.webhookSeen.release(installId as string, dedupKey as string);
    deps.logger.error('lifecycle handler failed', { event: payload.event, error: errMsg(e) });
    return { status: 200, body: { success: false, error: 'internal_error' } };
  }
}

function runHandler<S>(
  name: 'install' | 'activate' | 'deactivate' | 'uninstall' | 'config_updated',
  p: LifecycleRawPayload,
  deps: DispatcherDeps<S>,
): Promise<WebhookResponse> {
  switch (name) {
    case 'install':
      return onInstall(p, deps);
    case 'activate':
      return onActivate(p, deps);
    case 'deactivate':
      return onDeactivate(p, deps);
    case 'uninstall':
      return onUninstall(p, deps);
    case 'config_updated':
      return onConfigUpdated(p, deps);
  }
}

async function onInstall<S>(p: LifecycleRawPayload, deps: DispatcherDeps<S>): Promise<WebhookResponse> {
  const id = installIdOf(p);
  if (!id) return { success: true };
  if (p.access_token) deps.repos.state.setSecret(id, ACCESS_TOKEN_KEY, p.access_token);
  deps.repos.installs.upsert({
    installation_id: id,
    shop_domain: p.shop_domain ?? null,
    shop_name: p.shop_name ?? null,
    status: 'inactive',
    installed_at: p.installed_at ?? null,
  });
  if (p.configs) saveConfigs(deps.repos.state, id, deps.integration.configSchema, p.configs);
  return { success: true };
}

async function onActivate<S>(p: LifecycleRawPayload, deps: DispatcherDeps<S>): Promise<WebhookResponse> {
  const id = installIdOf(p);
  if (!id) return { success: false, error: 'missing_installation_id' };
  if (p.access_token) deps.repos.state.setSecret(id, ACCESS_TOKEN_KEY, p.access_token);
  // The install is persisted 'inactive' until activation is validated:
  // the 'active' status is only set AT THE END (testConnection + provisioning OK).
  deps.repos.installs.upsert({
    installation_id: id,
    shop_domain: p.shop_domain ?? null,
    shop_name: p.shop_name ?? null,
    status: 'inactive',
    installed_at: p.installed_at ?? null,
  });
  if (p.configs) saveConfigs(deps.repos.state, id, deps.integration.configSchema, p.configs);

  const ctx = buildContext(id, deps);
  const ok = await deps.integration.testConnection(ctx).catch(() => false);
  if (!ok) {
    deps.repos.installs.setStatus(id, 'inactive', {});
    return { success: false, error: 'connection_failed' };
  }

  if (deps.integration.provisioning) {
    const plan = await deps.integration.provisioning(ctx);
    const prov = await runProvisioning(ctx.spm, plan);
    deps.repos.state.set(id, PROVISIONING_KEY, JSON.stringify({ sourceIds: prov.sourceIds, defIds: prov.defIds }));
    if (prov.errors.length > 0) {
      // Count ALL successful resources (sources, defs, events, statuses) — not
      // just sources/defs: an events-only integration (loyalty/reviews) provisions
      // neither source nor def. HARD failure only if NOTHING succeeded; otherwise
      // best-effort, but partial errors are TRACED (no more silent swallowing).
      const provisionedCount =
        Object.keys(prov.sourceIds).length + Object.keys(prov.defIds).length + prov.events + prov.orderStatuses;
      if (provisionedCount === 0) {
        deps.repos.installs.setStatus(id, 'inactive', {});
        return { success: false, error: `provisioning_failed: ${prov.errors[0]}` };
      }
      deps.logger.warn('partial provisioning: some resources failed', { installation_id: id, errors: prov.errors });
    }
  }

  if (deps.integration.hooks?.onActivate) await deps.integration.hooks.onActivate(ctx);
  deps.repos.installs.setStatus(id, 'active', { activated_at: p.activated_at ?? null }); // validated -> active
  deps.afterActivate?.(id);
  return { success: true };
}

async function onDeactivate<S>(p: LifecycleRawPayload, deps: DispatcherDeps<S>): Promise<WebhookResponse> {
  const id = installIdOf(p);
  if (!id) return { success: true };
  // Idempotent transition: already deactivated/uninstalled -> no-op (does not replay the hook).
  const current = deps.repos.installs.find(id);
  if (current && (current.status === 'inactive' || current.status === 'uninstalled')) return { success: true };
  deps.repos.installs.setStatus(id, 'inactive', { deactivated_at: p.deactivated_at ?? null });
  await runHookSafe(deps.integration.hooks?.onDeactivate, id, deps);
  return { success: true };
}

async function onUninstall<S>(p: LifecycleRawPayload, deps: DispatcherDeps<S>): Promise<WebhookResponse> {
  const id = installIdOf(p);
  if (!id) return { success: true };
  // Idempotent transition: already uninstalled -> no-op (does not replay the hook).
  const current = deps.repos.installs.find(id);
  if (current && current.status === 'uninstalled') return { success: true };
  deps.repos.installs.setStatus(id, 'uninstalled', { uninstalled_at: p.uninstalled_at ?? null });
  await runHookSafe(deps.integration.hooks?.onUninstall, id, deps);
  return { success: true };
}

async function onConfigUpdated<S>(p: LifecycleRawPayload, deps: DispatcherDeps<S>): Promise<WebhookResponse> {
  const id = installIdOf(p);
  if (!id) return { success: true };
  if (p.configs) saveConfigs(deps.repos.state, id, deps.integration.configSchema, p.configs);
  try {
    const ctx = buildContext(id, deps);
    if (deps.integration.provisioning) {
      const plan = await deps.integration.provisioning(ctx);
      const prov = await runProvisioning(ctx.spm, plan);
      deps.repos.state.set(id, PROVISIONING_KEY, JSON.stringify({ sourceIds: prov.sourceIds, defIds: prov.defIds }));
    }
    if (deps.integration.hooks?.onConfigUpdated) await deps.integration.hooks.onConfigUpdated(ctx);
  } catch (e) {
    // Best-effort: the config is already saved (above) even if reprovisioning
    // failed; the failure is logged but NOT surfaced to ShopiMind. We keep the
    // { success: true } return DELIBERATELY (ShopiMind contract): a config update
    // must not be rejected just because reprovisioning could not complete. Logged
    // at ERROR (not warn) because a failed reprovision can leave the integration
    // out of sync with the new config and warrants operator attention.
    deps.logger.error('config_updated reprovisioning failed (best-effort, not surfaced)', { error: errMsg(e) });
  }
  return { success: true };
}

/** Validates the integration credentials (wizard step). No ShopiMind access. */
export async function handleTestConnection<S>(
  configs: RawConfigs,
  deps: DispatcherDeps<S>,
): Promise<WebhookResponse> {
  const ctx = ephemeralContext(configs, deps);
  const ok = await deps.integration.testConnection(ctx).catch(() => false);
  return ok ? { success: true } : { success: false, error: 'connection_failed' };
}

/** Populates a dynamic select in the config wizard. */
export async function handleRemoteData<S>(
  resource: string,
  configs: RawConfigs,
  deps: DispatcherDeps<S>,
): Promise<RemoteDataResponse> {
  const resolver = deps.integration.remoteData?.[resource];
  if (!resolver) return { data: [] };
  const ctx = ephemeralContext(configs, deps);
  const options = await resolver(ctx).catch(() => []);
  return { data: options };
}

function buildContext<S>(id: string, deps: DispatcherDeps<S>): IntegrationContext<S> {
  const token = deps.repos.state.get(id, ACCESS_TOKEN_KEY);
  if (!token) throw new Error(`no access_token for installation ${id}`);
  const configs = loadConfigs(deps.repos.state, id, deps.integration.configSchema);
  const spm = deps.makeSpmClient(token);
  const logger = deps.logger.child({ installation_id: id });
  const sendBulk = makeSendBulk(spm, logger);
  return {
    installationId: id,
    settings: deps.integration.parseSettings(configs),
    spm,
    sendBulk,
    state: deps.repos.state,
    logger,
    setExternalAccount: (acc) => deps.repos.installs.setExternalAccount(id, acc.id, acc.name ?? null),
    inboundSecret: ensureInboundSecret(deps.repos.state, id),
    withSource: makeWithSource(deps.repos.state, id, PROVISIONING_KEY, sendBulk),
  };
}

/** Context without an installation (config wizard): the ShopiMind SDK is not callable here. */
function ephemeralContext<S>(configs: RawConfigs, deps: DispatcherDeps<S>): IntegrationContext<S> {
  const spm = unavailableSpmClient();
  return {
    installationId: '',
    settings: deps.integration.parseSettings(configs),
    spm,
    sendBulk: makeSendBulk(spm, deps.logger),
    state: deps.repos.state,
    logger: deps.logger,
    setExternalAccount: () => { /* no installation during the config wizard */ },
    inboundSecret: '',
    withSource: () => {
      throw new Error('withSource is unavailable during the configuration wizard (no installation)');
    },
  };
}

async function runHookSafe<S>(
  hook: ((ctx: IntegrationContext<S>) => Promise<void> | void) | undefined,
  id: string,
  deps: DispatcherDeps<S>,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(buildContext(id, deps));
  } catch (e) {
    deps.logger.warn('lifecycle hook failed', { error: errMsg(e) });
  }
}

/**
 * "Unavailable" SDK client for the configuration wizard (no installation): its
 * adapter rejects every call. The SDK therefore never calls ShopiMind here; an
 * integration must not use `ctx.spm` during configuration.
 */
function unavailableSpmClient(): SpmHttpClient {
  const client = SpmClient.getClient('v1', '', { baseUrl: 'http://localhost', retry: false, labelSource: null });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client.defaults as any).adapter = () => {
    throw new Error('ShopiMind SDK is unavailable during the configuration step');
  };
  return client;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function headerOf(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Masks, within `payload.configs`, the fields declared `sensitive` by the
 * config_schema — before logging. Complements `redact()` (masking by key name)
 * by covering secrets whose key does not match the generic regex.
 */
function maskSchemaSecrets(payload: LifecycleRawPayload, schema: ConfigSchema): LifecycleRawPayload {
  const configs = payload.configs;
  if (!configs || typeof configs !== 'object') return payload;
  const sensitive = new Set(sensitiveKeys(schema));
  if (sensitive.size === 0) return payload;
  const masked: RawConfigs = {};
  for (const [k, v] of Object.entries(configs)) masked[k] = sensitive.has(k) ? '[redacted]' : v;
  return { ...payload, configs: masked };
}
