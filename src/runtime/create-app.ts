import type { Server } from '@hapi/hapi';
import { SpmClient, type SpmHttpClient } from '@shopimind/sdk-js';
import type { Integration, IntegrationContext } from '../integration/types.js';
import { openDatabase, type Db } from '../store/db.js';
import { createRepositories, type Repositories } from '../store/repositories.js';
import { SecretCipher } from '../security/crypto.js';
import { createLogger, type Logger } from '../logging/logger.js';
import { loadConfigs } from '../config/config-store.js';
import { runIntegrationSync, type SyncSummary } from '../sync/engine.js';
import { ACCESS_TOKEN_KEY, PROVISIONING_KEY, type DispatcherDeps } from '../lifecycle/dispatcher.js';
import { runProvisioning } from '../provisioning/runner.js';
import { ensureInboundSecret } from '../lifecycle/inbound.js';
import { makeWithSource } from '../sdk/source-scope.js';
import { makeCustomData } from '../sdk/custom-data-scope.js';
import { makeSendBulk } from '../sdk/send-bulk.js';
import { createRateLimiter } from './rate-limiter.js';
import { buildHealthReport, buildOverview } from './health.js';
import { createServer } from '../http/server.js';
import { buildRoutes } from '../http/routes.js';
import { buildAdminRoutes } from '../http/admin-routes.js';
import { AdminSessionManager } from '../http/admin-session.js';
import { buildAdminData } from './admin-data.js';
import { buildAdminActions } from './admin-actions.js';
import { describeIntegration } from '../integration/describe.js';
import { KIT_VERSION } from './kit-version.js';

export interface CreateAppOptions<S> {
  databasePath: string;
  /**
   * Webhook signing secret(s). A single string is the common case; pass an array to
   * open a secret ROTATION window — a webhook signed with ANY listed secret is
   * accepted while you swap `current` -> `next`. Backward compatible with a string.
   */
  webhookSecret: string | string[];
  /**
   * Override for the ShopiMind SDK base URL (otherwise env `SHOPIMIND_CORE_API_BASE`,
   * then `https://core.shopimind.com`). Useful in tests / preprod.
   */
  spmBaseUrl?: string;
  /**
   * Override for SDK client construction. Lets a caller inject a client instance
   * instead of the kit building one via `SpmClient.getClient`.
   */
  makeSpmClient?: (accessToken: string) => SpmHttpClient;
  credentialsKey?: string | null;
  /**
   * EXPLICITLY allows storing secrets IN PLAINTEXT when no `credentialsKey` is
   * provided (LOCAL DEVELOPMENT ONLY). Defaults to `false` -> without a key,
   * startup fails. A loud WARN is emitted when enabled.
   */
  allowPlaintextSecrets?: boolean;
  adminToken?: string | null;
  signatureToleranceSeconds?: number;
  backfillDays?: number;
  /**
   * Defensive overlap applied to every INCREMENTAL sync window: shifts `since`
   * back by this many seconds so a boundary item is not missed. Idempotent (upserts).
   * Default 0 (no overlap).
   */
  overlapSeconds?: number;
  port?: number;
  host?: string;
  logger?: Logger;
  /** Runs a full backfill automatically on activation (default true). */
  autoBackfillOnActivate?: boolean;
  /** Enables the internal incremental sync scheduler (default true). */
  autoSync?: boolean;
  /**
   * Interval (in MINUTES) between two automatic incremental syncs of each active
   * installation. Default 15. A value <= 0 disables the scheduler.
   */
  syncIntervalMinutes?: number;
  /**
   * Retention (in DAYS) for the webhook log and the anti-replay / inbound-event
   * tables. A daily purge deletes rows older than this. Default 90. A value <= 0
   * disables the purge (tables then grow unbounded).
   */
  retentionDays?: number;
  /**
   * Retention (in DAYS) for the dead-letter (`rejected_item`). Defaults to
   * `retentionDays`. Raise it to keep refused items longer for forensics.
   */
  rejectedRetentionDays?: number;
  /**
   * Retention (in DAYS) for the admin audit trail (`audit_log`). Default 365. A
   * value <= 0 disables the audit purge.
   */
  auditRetentionDays?: number;
  /**
   * If set, serves the admin surface (`/admin/*` + the operations UI) on a SEPARATE
   * listener/port instead of the public server. Strongly recommended: keep this port
   * on a private interface / behind the orchestrator and expose only the public port
   * (webhooks/inbound/health). When omitted, admin routes share the public server.
   */
  adminPort?: number;
  /**
   * Host/interface for the admin listener (only when `adminPort` is set). Defaults to
   * `127.0.0.1` (loopback) — a safe default that does NOT expose the admin surface on
   * every interface. Set explicitly to bind elsewhere.
   */
  adminHost?: string;
  /**
   * Marks the admin session cookie `Secure` (HTTPS-only). Default false for plain-HTTP
   * local dev; set true in any real deployment (and serve the UI over HTTPS).
   */
  adminSecureCookie?: boolean;
  now?: () => number;
}

export interface IntegrationApp {
  server: Server;
  /** Present only in two-listener mode (`adminPort` set): the dedicated admin/operations server. */
  adminServer?: Server;
  db: Db;
  repos: Repositories;
  start(): Promise<void>;
  stop(): Promise<void>;
  runSyncOnce(installationId: string, opts?: { full?: boolean }): Promise<SyncSummary | null>;
}

/**
 * Assembles a ready-to-run integration: store + crypto + repositories + logger +
 * dispatcher + sync engine + HTTP server + internal scheduler. The kit builds the
 * SDK client itself (direct dependency on `@shopimind/sdk-js`).
 */
export function createIntegrationApp<S>(integration: Integration<S>, opts: CreateAppOptions<S>): IntegrationApp {
  const db = openDatabase(opts.databasePath);
  // Fail-closed by default: without a key, encryption at rest is MANDATORY
  // (the constructor throws), unless explicitly opted out via `allowPlaintextSecrets`.
  const allowPlaintext = opts.allowPlaintextSecrets ?? false;
  const cipher = new SecretCipher({ key: opts.credentialsKey ?? null, production: !allowPlaintext });
  const repos = createRepositories(db, cipher);
  const logger = opts.logger ?? createLogger({ bindings: { integration: integration.slug } });
  if (cipher.insecure) {
    logger.warn(
      'SECRETS STORED IN PLAINTEXT: no CREDENTIALS_KEY (allowPlaintextSecrets enabled). ' +
        'For local development only -- NEVER use in preprod/production.',
    );
  }
  const backfillDays = opts.backfillDays ?? 365;

  // The kit builds the SDK client itself; an `opts.makeSpmClient` override lets a
  // caller inject a client instance instead.
  const makeSpmClient =
    opts.makeSpmClient ??
    ((token: string): SpmHttpClient =>
      SpmClient.getClient('v1', token, { labelSource: null, ...(opts.spmBaseUrl ? { baseUrl: opts.spmBaseUrl } : {}) }));

  const buildContext = (id: string): IntegrationContext<S> | null => {
    const token = repos.state.get(id, ACCESS_TOKEN_KEY);
    if (!token) return null;
    const configs = loadConfigs(repos.state, id, integration.configSchema);
    const spm = makeSpmClient(token);
    const ctxLogger = logger.child({ installation_id: id });
    const sendBulk = makeSendBulk(spm, ctxLogger);
    return {
      installationId: id,
      settings: integration.parseSettings(configs),
      spm,
      sendBulk,
      state: repos.state,
      logger: ctxLogger,
      setExternalAccount: (acc) => repos.installs.setExternalAccount(id, acc.id, acc.name ?? null),
      inboundSecret: ensureInboundSecret(repos.state, id),
      withSource: makeWithSource(repos.state, id, PROVISIONING_KEY, sendBulk),
      customData: makeCustomData(repos.state, id, PROVISIONING_KEY, sendBulk, spm),
    };
  };

  // Per-installation overlap lock: prevents a post-activation backfill, a scheduled
  // sync, and an admin call from running at the same time on the same installation
  // (race on the cursors).
  const running = new Set<string>();
  const runSyncOnce = async (id: string, o?: { full?: boolean }): Promise<SyncSummary | null> => {
    if (running.has(id)) {
      logger.warn('sync skipped: already running for this installation', { installation_id: id });
      return null;
    }
    const base = buildContext(id);
    if (!base) {
      logger.warn('sync skipped: no context (unknown installation or no token)', { installation_id: id });
      return null;
    }
    running.add(id);
    try {
      return await runIntegrationSync(
        integration,
        base,
        {
          cursors: repos.cursors,
          runs: repos.runs,
          makeSource: (sb) => makeWithSource(repos.state, id, PROVISIONING_KEY, sb),
          makeCustomData: (sb) => makeCustomData(repos.state, id, PROVISIONING_KEY, sb, base.spm),
          // Feed the dead-letter sink so rejected items survive the run.
          rejectedItems: repos.rejectedItems,
        },
        {
          fullBackfill: o?.full ?? false,
          backfillDays,
          ...(opts.overlapSeconds != null ? { overlapSeconds: opts.overlapSeconds } : {}),
        },
      );
    } finally {
      running.delete(id);
    }
  };

  // Re-runs the integration's provisioning for an installation (admin action).
  // Idempotent find-or-create; persists the refreshed source/def id maps exactly
  // like the lifecycle dispatcher does on activate / config-update.
  const reprovision = async (
    id: string,
  ): Promise<{ sources: number; defs: number; events: number; orderStatuses: number; errors: string[] }> => {
    const ctx = buildContext(id);
    if (!ctx) throw new Error('unknown_installation');
    if (!integration.provisioning) return { sources: 0, defs: 0, events: 0, orderStatuses: 0, errors: [] };
    // Share the per-installation lock: reprovision rewrites PROVISIONING_KEY, which a
    // concurrent sync reads for its source/def ids — the two must never overlap.
    if (running.has(id)) throw new Error('busy: a sync or reprovision is already running for this installation');
    running.add(id);
    try {
      const plan = await integration.provisioning(ctx);
      const prov = await runProvisioning(ctx.spm, plan, ctx.logger);
      repos.state.set(id, PROVISIONING_KEY, JSON.stringify({ sourceIds: prov.sourceIds, defIds: prov.defIds }));
      return {
        sources: Object.keys(prov.sourceIds).length,
        defs: Object.keys(prov.defIds).length,
        events: prov.events,
        orderStatuses: prov.orderStatuses,
        errors: prov.errors,
      };
    } finally {
      running.delete(id);
    }
  };

  const autoBackfill = opts.autoBackfillOnActivate ?? true;
  const dispatcher: DispatcherDeps<S> = {
    integration,
    repos,
    secret: opts.webhookSecret,
    logger,
    makeSpmClient,
    ...(opts.signatureToleranceSeconds != null ? { toleranceSeconds: opts.signatureToleranceSeconds } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(autoBackfill
      ? {
          afterActivate: (id: string): void => {
            setImmediate(() => {
              void runSyncOnce(id, { full: true }).catch((e) =>
                logger.error('post-activation backfill failed', { installation_id: id, error: String(e) }),
              );
            });
          },
        }
      : {}),
  };

  const inboundRateLimit = createRateLimiter(opts.now ? { now: opts.now } : {});
  // Dedicated limiter for /admin/* routes (per IP): bounds token brute-forcing and
  // backfill abuse -- stricter than the inbound limiter.
  const adminRateLimit = createRateLimiter({ capacity: 10, refillPerSec: 1, ...(opts.now ? { now: opts.now } : {}) });
  // Per-IP limiter for POST /webhook/receive: bounds a flood of unsigned/forged
  // requests before the (costly) HMAC verification runs.
  const webhookRateLimit = createRateLimiter(opts.now ? { now: opts.now } : {});
  const publicPort = opts.port ?? 8080;
  const server = createServer({ port: publicPort, ...(opts.host ? { host: opts.host } : {}) });
  const nowMs = (): number => (opts.now ? opts.now() : Date.now());
  const adminData = buildAdminData(repos, { kitVersion: KIT_VERSION, now: nowMs, integration: describeIntegration(integration) });
  const adminActions = buildAdminActions(repos, { reprovision });
  const adminSessions = new AdminSessionManager({ now: nowMs, secureCookie: opts.adminSecureCookie ?? false });

  const publicRoutes = buildRoutes({
    dispatcher,
    webhookRateLimit,
    // Enriched health probe (DB ping, run ages, cursors in error).
    healthReport: () => buildHealthReport(db, repos, nowMs()),
    inbound: {
      integration,
      repos,
      logger,
      buildContext,
      rateLimit: inboundRateLimit,
      ...(opts.signatureToleranceSeconds != null ? { toleranceSeconds: opts.signatureToleranceSeconds } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    },
  });
  const adminRoutes = buildAdminRoutes({
    adminToken: opts.adminToken ?? null,
    adminRateLimit,
    data: adminData,
    sessions: adminSessions,
    actions: adminActions,
    // Admin overview across installations.
    overview: () => buildOverview(repos, nowMs()),
    // Dead-lettered rejects for one installation (bounded, RAW payloads, operator-only).
    rejectedItems: (id, limit) => repos.rejectedItems.listByInstallation(id, limit),
    runSyncForInstall: (id, full) => runSyncOnce(id, { full }),
    recentRuns: (id) => repos.runs.recent(id),
  });

  // Two-listener mode: when `adminPort` differs from the public port, the admin
  // surface gets its OWN server (default loopback host), so the public interface only
  // exposes webhooks/inbound/health. Otherwise both share the public server.
  // A configured adminPort means "separate listener". When both ports are 0 (ephemeral),
  // they still bind to two distinct OS-assigned ports, so honour the split there too.
  const separateAdmin = opts.adminPort != null && (opts.adminPort !== publicPort || publicPort === 0);
  let adminServer: Server | null = null;
  if (separateAdmin) {
    server.route(publicRoutes);
    adminServer = createServer({ port: opts.adminPort as number, host: opts.adminHost ?? '127.0.0.1' });
    adminServer.route(adminRoutes);
  } else {
    server.route([...publicRoutes, ...adminRoutes]);
  }

  // ---- Security posture warnings (loud, once, at construction) ---------------
  // Only relevant when the admin surface is actually usable (a token is configured).
  if (opts.adminToken) {
    if (opts.adminToken.length < 32) {
      logger.warn('adminToken is short: use a 32+ character high-entropy secret (a short token is easier to brute-force).', {
        length: opts.adminToken.length,
      });
    }
    if (!separateAdmin && (opts.host ?? '0.0.0.0') === '0.0.0.0') {
      logger.warn(
        'admin surface (/admin/*) is served on the PUBLIC listener bound to 0.0.0.0. It is token-gated, ' +
          'but prefer `adminPort` on a private/loopback interface, or restrict it at the ingress.',
      );
    }
    if (!opts.adminSecureCookie) {
      logger.warn(
        'adminSecureCookie is off: the admin session cookie is not marked Secure. Serve the admin UI over HTTPS ' +
          'and set adminSecureCookie in any real deployment.',
      );
    }
  }

  // ---- Internal scheduler (periodic incremental sync) -----------------------
  const intervalMinutes = opts.syncIntervalMinutes ?? 15;
  const autoSync = (opts.autoSync ?? true) && intervalMinutes > 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let sweeping = false;

  /** One pass: incremental sync of all active installations. */
  const sweep = async (): Promise<void> => {
    if (sweeping) return; // the previous pass has not finished -> skip this tick
    sweeping = true;
    try {
      for (const inst of repos.installs.listActive()) {
        try {
          await runSyncOnce(inst.installation_id, { full: false });
        } catch (e) {
          logger.error('scheduled sync failed', {
            installation_id: inst.installation_id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } catch (e) {
      // e.g. the listActive() query itself failing — must not become an unhandled rejection.
      logger.error('scheduled sync sweep failed', { error: e instanceof Error ? e.message : String(e) });
    } finally {
      sweeping = false;
    }
  };

  // ---- Retention: bounded growth of the log / dead-letter / audit tables -----
  const retentionDays = opts.retentionDays ?? 90;
  const rejectedRetentionDays = opts.rejectedRetentionDays ?? retentionDays;
  const auditRetentionDays = opts.auditRetentionDays ?? 365;
  const retentionEnabled = retentionDays > 0 || rejectedRetentionDays > 0 || auditRetentionDays > 0;
  let retentionTimer: ReturnType<typeof setInterval> | null = null;
  const purgeOldRecords = (): void => {
    try {
      const log = retentionDays > 0 ? repos.webhookLog.purgeOlderThan(retentionDays) : 0;
      const seen = retentionDays > 0 ? repos.webhookSeen.purgeOlderThan(retentionDays) : 0;
      const inbound = retentionDays > 0 ? repos.inboundEvents.purgeOlderThan(retentionDays) : 0;
      const rejected = rejectedRetentionDays > 0 ? repos.rejectedItems.purgeOlderThan(rejectedRetentionDays) : 0; // E4 dead-letter
      const runs = retentionDays > 0 ? repos.runs.purgeOlderThan(retentionDays) : 0; // sync-run history
      const audit = auditRetentionDays > 0 ? repos.audit.purgeOlderThan(auditRetentionDays) : 0; // admin trail
      if (log + seen + inbound + rejected + runs + audit > 0) {
        logger.info('retention purge', {
          webhook_log: log,
          webhook_seen: seen,
          inbound_event: inbound,
          rejected_item: rejected,
          sync_run: runs,
          audit_log: audit,
          retentionDays,
          rejectedRetentionDays,
          auditRetentionDays,
        });
      }
    } catch (e) {
      logger.error('retention purge failed', { error: e instanceof Error ? e.message : String(e) });
    }
  };

  return {
    server,
    ...(adminServer ? { adminServer } : {}),
    db,
    repos,
    start: async () => {
      await server.start();
      logger.info('integration started', { uri: server.info.uri });
      if (adminServer) {
        await adminServer.start();
        logger.info('admin surface started on a separate listener', { uri: adminServer.info.uri });
      }
      if (autoSync) {
        timer = setInterval(() => {
          void sweep();
        }, intervalMinutes * 60_000);
        timer.unref();
        logger.info('sync scheduler enabled', { intervalMinutes });
      }
      if (retentionEnabled) {
        purgeOldRecords();
        retentionTimer = setInterval(() => purgeOldRecords(), 24 * 60 * 60_000);
        retentionTimer.unref();
        logger.info('retention enabled', { retentionDays, rejectedRetentionDays, auditRetentionDays });
      }
    },
    stop: async () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (retentionTimer) {
        clearInterval(retentionTimer);
        retentionTimer = null;
      }
      if (adminServer) {
        try {
          await adminServer.stop();
        } catch {
          /* admin server not started */
        }
      }
      try {
        await server.stop();
      } catch {
        /* server not started */
      }
      db.close();
    },
    runSyncOnce,
  };
}
