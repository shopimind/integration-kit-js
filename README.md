# @shopimind/integration-kit-js

[![CI](https://github.com/shopimind/integration-kit-js/actions/workflows/ci.yml/badge.svg)](https://github.com/shopimind/integration-kit-js/actions/workflows/ci.yml)

The toolkit for **building a ShopiMind integration**. You write your business logic; the kit provides all the infrastructure.

An integration has to receive lifecycle webhooks, sync data reliably, expose widgets, and talk to the ShopiMind API securely. With this kit you only declare **what is specific to your system** (pure functions + declarations); the rest is provided and tested once.

**The kit handles for you:**
- 🔐 Secured webhooks: HMAC signature verification + anti-replay
- 🔄 Incremental, **cursor-safe** sync: no data loss on error
- 🌊 Streaming pagination + bounded concurrency: no memory blow-up, no request bursts (429)
- 💾 Pluggable persistence: SQLite (zero-config default) or **your own PostgreSQL database**, with **encrypted secrets** at rest
- 🔌 **Typed** ShopiMind API client (the SDK, re-exported)
- ⚙️ **Idempotent** provisioning of data sources, custom data and events
- 🌐 HTTP server + lifecycle handling (install / activate / config / sync)
- 🧩 Widget declarations

## Requirements

Node.js 18+ and TypeScript (ESM / `NodeNext`).

## Install

```bash
npm i @shopimind/integration-kit-js better-sqlite3
```

The ShopiMind SDK is a dependency and is **re-exported**, so you can import SDK resources directly from the kit.

The storage driver is an **optional peer dependency**. Install the one matching your backend: `better-sqlite3` for the default SQLite store, or `pg` for [PostgreSQL](#choosing-a-store).

## Quick start

### 1. Describe your integration

```ts
// integration.ts
import { defineIntegration } from '@shopimind/integration-kit-js';

export const integration = defineIntegration({
  slug: 'my-pos',
  meta: { name: 'My POS', version: '1.0.0' },

  configSchema: { steps: [ /* the configuration form shown to the merchant */ ] },
  parseSettings: (raw) => ({ /* your typed settings */ }),

  testConnection: async (ctx) => {
    // check access to the partner system with ctx.settings
    return true;
  },

  provisioning: async (ctx) => ({
    dataSources: [ /* ... */ ],
    customData:  [ /* ... */ ],
    events:      [ /* ... */ ],
  }),

  widgets: [ /* widgets exposed in the ShopiMind editor */ ],

  syncSteps: [
    {
      entity: 'customers',
      cursorScope: 'global',
      enabled: (s) => s.syncCustomers,
      run: async (ctx) => {
        // ctx.sendBulk(fn, items) — safe push · ctx.spm + SDK statics · ctx.paginate(...) · ctx.state · ctx.logger
        return { items: 0, errors: [] };
      },
    },
  ],
});
// Integration<S> types every field (strict TypeScript).
```

### 2. Run the app

```ts
// main.ts
import { createIntegrationApp } from '@shopimind/integration-kit-js';
import { integration } from './integration.js';

const env = process.env;

const app = await createIntegrationApp(integration, {
  databasePath: env.DATABASE_PATH ?? './data/store.sqlite',
  webhookSecret: env.WEBHOOK_SECRET!,     // HMAC secret for ShopiMind webhooks
  credentialsKey: env.CREDENTIALS_KEY,    // 64-hex AES key used to encrypt stored secrets
  port: env.PORT ? Number(env.PORT) : 8080,
});

await app.start();
```

`createIntegrationApp` wires the HTTP server, the lifecycle dispatcher (signed webhooks), persistence (migrated and ready) and the sync engine; the kit builds the ShopiMind SDK client itself. You only have to deploy.

> **Encryption is fail-closed.** Without `credentialsKey`, startup fails. Pass `allowPlaintextSecrets: true` to allow plaintext secret storage **for local development only**.

## Choosing a store

The kit persists its operational state (installations, encrypted secrets, sync
cursors, logs) through a storage **port** with two official adapters. Pick one:

**SQLite: the zero-config default.** One local file, nothing to operate. Ideal
when your deployment has a persistent disk.

```bash
npm i better-sqlite3
```
```ts
const app = await createIntegrationApp(integration, {
  databasePath: './data/store.sqlite',   // that's it
  // ...
});
```

**PostgreSQL: bring your own database.** No local file, no persistent
filesystem, no native module: the kit's tables live in a **dedicated schema** of
a database you already run and back up. Great for containers and managed platforms.

```bash
npm i pg
```
```ts
import { createPostgresStore } from '@shopimind/integration-kit-js/store-postgres';

const app = await createIntegrationApp(integration, {
  store: await createPostgresStore({
    connectionString: process.env.DATABASE_URL!,  // or pool: yourExistingPgPool
    schema: 'shopimind_myintegration',            // one schema per integration
  }),
  // ...
});
```

Both adapters behave identically (same schema layout, same guarantees, with the
per-installation secrets staying AES-256-GCM encrypted whatever the backend) and
both pass the same conformance suite in CI.

Operational notes, whatever the store: run **one replica per integration** (the
sync scheduler and overlap locks are per-process), and on scale-to-zero platforms
disable `autoSync` and trigger syncs from an external cron via
`POST /admin/sync/{id}` or `app.runSyncOnce()`.

### Custom store (advanced)

Any backend can power the kit: implement the `IntegrationStore` interface (a
small set of promise-based, single-statement stores; no transactions to
implement, and encryption stays in the kit, above the port) and pass it as
`store`. Validate your adapter with the **conformance suite**, the executable
contract both official adapters pass:

```ts
// my-store.conformance.test.ts (vitest or jest)
import { describe, it, expect } from 'vitest';
import { runStoreConformanceSuite } from '@shopimind/integration-kit-js/store-testing';
import { createMyStore } from './my-store.js';

runStoreConformanceSuite(() => createMyStore(), { describe, it, expect });
```

Semver note: the port may **gain** methods in a minor version of the kit (official
adapters are updated in lockstep), so re-run the conformance suite when you upgrade.
Removals or signature changes only happen in a major.

## The building blocks of an integration

| Field | Role |
|---|---|
| `configSchema` | the configuration form shown to the merchant |
| `parseSettings` | turns the raw config into typed settings |
| `testConnection` | checks access to the partner system |
| `provisioning` | idempotently creates the data sources / custom data / events on the ShopiMind side |
| `widgets` | widgets exposed in the ShopiMind editor |
| `syncSteps` | the sync steps (**the cursor is managed by the kit**) |
| `hooks` *(optional)* | lifecycle callbacks (`onActivate`, `onConfigUpdated`, ...) |

## Admin operations UI

The kit ships a small, self-contained **operations console** for you, the integrator. Set
an `adminToken` and open `http://<host>:<port>/admin/ui`. It runs entirely on your side (it
only reads the integration's own store) and lets you:

- browse **installations** and drill into cursors, sync runs, webhooks, inbound events and state;
- inspect the **dead-letter** (items the ShopiMind API refused) and the **audit trail**;
- trigger **sync**, **reprovision**, **purge** a rejected item, or **reveal** a single payload.

Safe by default: **PII is masked** (emails, phones, names…) unless you explicitly reveal it
(an audited action), **secrets are never returned**, browser access uses an HttpOnly
`SameSite=Strict` session cookie + a CSRF token, and every action is rate-limited.

```ts
const app = await createIntegrationApp(integration, {
  databasePath: env.DATABASE_PATH ?? './data/store.sqlite',
  webhookSecret: env.WEBHOOK_SECRET!,
  credentialsKey: env.CREDENTIALS_KEY,
  adminToken: env.ADMIN_TOKEN,   // enables /admin/* and the UI (use a 32+ char high-entropy token)
  adminPort: 9090,               // recommended: serve /admin on a PRIVATE listener…
  adminHost: '127.0.0.1',        // …bound to loopback (the default when adminPort is set)
  adminSecureCookie: true,       // mark the session cookie Secure (serve the UI over HTTPS)
});
```

> Keep the admin port on a private interface (or behind your ingress). When `adminPort` is
> omitted, `/admin/*` shares the public server, which is fine for local dev but warned about otherwise.

## Guarantees

- The **cursor only advances when a step finished without error** → no silent data loss; the window is replayed on the next run.
- **Partner secrets are encrypted** at rest and **redacted in logs**.
- **Pagination streams** and **concurrency is bounded** → controlled memory, no request bursts.
- **Webhooks are verified** (signature + anti-replay window) **before** any processing.
- **The admin UI is integrator-side and safe by default**: PII masked, secrets never returned, every action audited, session cookie hardened.

## License

Source-available, proprietary. See [LICENSE](./LICENSE). You may use and modify the kit for your own use of the ShopiMind service; redistribution and independent use are not granted.
