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
import { ensureInboundSecret } from '../lifecycle/inbound.js';
import { makeWithSource } from '../sdk/source-scope.js';
import { makeSendBulk } from '../sdk/send-bulk.js';
import { createRateLimiter } from './rate-limiter.js';
import { createServer } from '../http/server.js';
import { buildRoutes } from '../http/routes.js';

export interface CreateAppOptions<S> {
  databasePath: string;
  webhookSecret: string;
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
  now?: () => number;
}

export interface IntegrationApp {
  server: Server;
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
        },
        { fullBackfill: o?.full ?? false, backfillDays },
      );
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
  const server = createServer({ port: opts.port ?? 8080, ...(opts.host ? { host: opts.host } : {}) });
  server.route(
    buildRoutes({
      dispatcher,
      adminToken: opts.adminToken ?? null,
      adminRateLimit,
      webhookRateLimit,
      runSyncForInstall: (id, full) => runSyncOnce(id, { full }),
      recentRuns: (id) => repos.runs.recent(id),
      inbound: {
        integration,
        repos,
        logger,
        buildContext,
        rateLimit: inboundRateLimit,
        ...(opts.signatureToleranceSeconds != null ? { toleranceSeconds: opts.signatureToleranceSeconds } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      },
    }),
  );

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
    } finally {
      sweeping = false;
    }
  };

  // ---- Retention: bounded growth of the log / anti-replay tables -------------
  const retentionDays = opts.retentionDays ?? 90;
  const retentionEnabled = retentionDays > 0;
  let retentionTimer: ReturnType<typeof setInterval> | null = null;
  const purgeOldRecords = (): void => {
    try {
      const log = repos.webhookLog.purgeOlderThan(retentionDays);
      const seen = repos.webhookSeen.purgeOlderThan(retentionDays);
      const inbound = repos.inboundEvents.purgeOlderThan(retentionDays);
      if (log + seen + inbound > 0) {
        logger.info('retention purge', { webhook_log: log, webhook_seen: seen, inbound_event: inbound, retentionDays });
      }
    } catch (e) {
      logger.error('retention purge failed', { error: e instanceof Error ? e.message : String(e) });
    }
  };

  return {
    server,
    db,
    repos,
    start: async () => {
      await server.start();
      logger.info('integration started', { uri: server.info.uri });
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
        logger.info('retention enabled', { retentionDays });
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
