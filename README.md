# @shopimind/integration-kit-js

[![CI](https://github.com/shopimind/integration-kit-js/actions/workflows/ci.yml/badge.svg)](https://github.com/shopimind/integration-kit-js/actions/workflows/ci.yml)

The toolkit for **building a ShopiMind integration**. You write your business logic; the kit provides all the infrastructure.

An integration has to receive lifecycle webhooks, sync data reliably, expose widgets, and talk to the ShopiMind API securely. With this kit you only declare **what is specific to your system** (pure functions + declarations) — the rest is provided and tested once.

**The kit handles for you:**
- 🔐 Secured webhooks — HMAC signature verification + anti-replay
- 🔄 Incremental, **cursor-safe** sync — no data loss on error
- 🌊 Streaming pagination + bounded concurrency — no memory blow-up, no request bursts (429)
- 💾 Local persistence (SQLite) with **encrypted secrets** at rest
- 🔌 **Typed** ShopiMind API client (the SDK, re-exported)
- ⚙️ **Idempotent** provisioning of data sources, custom data and events
- 🌐 HTTP server + lifecycle handling (install / activate / config / sync)
- 🧩 Widget declarations

## Requirements

Node.js 18+ and TypeScript (ESM / `NodeNext`).

## Install

```bash
npm i @shopimind/integration-kit-js
```

The ShopiMind SDK is a dependency and is **re-exported**, so you can import SDK resources directly from the kit.

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
        // ctx.spm.* (ShopiMind API), ctx.paginate(...), ctx.state, ctx.logger...
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

const app = createIntegrationApp(integration, {
  databasePath: env.DATABASE_PATH ?? './data/store.sqlite',
  webhookSecret: env.WEBHOOK_SECRET!,     // HMAC secret for ShopiMind webhooks
  credentialsKey: env.CREDENTIALS_KEY,    // 64-hex AES key used to encrypt stored secrets
  port: env.PORT ? Number(env.PORT) : 8080,
});

void app.start();
```

`createIntegrationApp` wires the HTTP server, the lifecycle dispatcher (signed webhooks), persistence and the sync engine — the kit builds the ShopiMind SDK client itself. You only have to deploy.

> **Encryption is fail-closed.** Without `credentialsKey`, startup fails — pass `allowPlaintextSecrets: true` to allow plaintext secret storage **for local development only**.

## The building blocks of an integration

| Field | Role |
|---|---|
| `configSchema` | the configuration form shown to the merchant |
| `parseSettings` | turns the raw config into typed settings |
| `testConnection` | checks access to the partner system |
| `provisioning` | idempotently creates the data sources / custom data / events on the ShopiMind side |
| `widgets` | widgets exposed in the ShopiMind editor |
| `syncSteps` | the sync steps — **the cursor is managed by the kit** |
| `hooks` *(optional)* | lifecycle callbacks (`onActivate`, `onConfigUpdated`, ...) |

## Guarantees

- The **cursor only advances when a step finished without error** → no silent data loss; the window is replayed on the next run.
- **Partner secrets are encrypted** at rest and **redacted in logs**.
- **Pagination streams** and **concurrency is bounded** → controlled memory, no request bursts.
- **Webhooks are verified** (signature + anti-replay window) **before** any processing.

## License

Source-available, proprietary — see [LICENSE](./LICENSE). You may use and modify the kit for your own use of the ShopiMind service; redistribution and independent use are not granted.
