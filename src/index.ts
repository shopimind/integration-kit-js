/**
 * @shopimind/integration-kit-js — public surface.
 *
 * Primitives, persistence, authoring contract, sync engine and HTTP runtime
 * (server, routes) to build a ShopiMind integration.
 */

// Security
export * from './security/signature.js';
export * from './security/crypto.js';
export * from './security/redaction.js';

// Sync (safe cursor)
export * from './sync/paginate.js';
export * from './sync/concurrency.js';
export * from './sync/cursor.js';
export * from './sync/engine.js';

// Re-export of the ShopiMind SDK: an integration imports everything from
// `@shopimind/integration-kit-js` (resources, SpmHelpers, types).
export * from '@shopimind/sdk-js';
// Provisioned source helper (`ctx.withSource` -> SourceHandle).
export * from './sdk/source-scope.js';
// Safe bulk push types (`ctx.sendBulk` / `withSource(k).send` return a BulkResult).
export type { BulkResult, SendBulk, SendBulkOptions } from './sdk/send-bulk.js';

// Idempotent provisioning + plan runner
export * from './provisioning/ensure.js';
export * from './provisioning/runner.js';

// Persisted config (secrets encrypted at rest)
export * from './config/config-store.js';

// Lifecycle (dispatcher: signature + REDACTED log + provisioning)
export * from './lifecycle/dispatcher.js';

// Inbound routes (secured middleware: integrator app -> integration -> ShopiMind)
export * from './lifecycle/inbound.js';

// Persistence (versioned migrations + typed repositories)
export * from './store/db.js';
export * from './store/migrate.js';
export * from './store/migrations.js';
export * from './store/repositories.js';
export type * from './store/types.js';

// Redacting logger
export * from './logging/logger.js';

// Integration authoring contract
export * from './integration/define-integration.js';
export type * from './integration/types.js';

// Neutral integration manifest (describes the integration in a portable way)
export * from './manifest.js';

// HTTP runtime (Hapi server + routes + bootstrap)
export * from './http/server.js';
export * from './http/routes.js';
export * from './runtime/create-app.js';
export * from './runtime/rate-limiter.js';

// Test helpers
export * from './testing/harness.js';

// Re-export of the contracts (a single import point for integrations)
export type * from './contracts/index.js';
