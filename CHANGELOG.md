# Changelog

All notable changes to `@shopimind/integration-kit-js` are documented here.
This project follows [Semantic Versioning](https://semver.org/): `patch` = fix,
`minor` = backward-compatible addition, `major` = breaking change.

## 2.0.1

**A soft-deleted custom-data definition no longer breaks re-activation.** Deleting a
definition is a LOGICAL delete server-side: the row keeps its name and stays in the
listing, but the API refuses to serve it by id (HTTP 400 "Custom data definition not
found"). The kit matched that tombstone by name and aborted the definition on every
subsequent activation.

### Fixed

- **Soft-deleted definitions are ignored during provisioning.** The kit now skips
  homonyms whose `status` is `deleted` and creates a fresh definition instead, which
  the API accepts, since its own name-uniqueness check excludes deleted definitions.
  Rows with no `status` are still matched (fail-open), and `creating` / `editing` /
  `inactive` rows are still reused: they hold the name, so routing them to the create
  branch would trade a transient error for a permanent one.
  **Consequence to know:** the re-created definition is a NEW one (new `id_definition`,
  new physical table). Records written to the deleted definition are NOT carried over,
  and no public route can restore them.
- **Definition names are matched CASE-INSENSITIVELY**, like the API's own uniqueness
  check. A case-sensitive match could send a create that the API then refused with
  "custom data definition name is already used." Accents are NOT folded, though the
  server's collation does fold them: a name differing only by an accent can still be
  refused on create. The name sent on create is trimmed for the same reason.
- **Deterministic resolution when several rows share a name.** The listing has no
  guaranteed ordering and name uniqueness is enforced only across non-deleted rows, so
  homonyms can legally coexist. The most usable status now wins (an `active`
  definition over an `inactive` one, which would reject every record write), then the
  lowest id.
- **A matched definition that is not `active` is reported** (warning), instead of
  provisioning "successfully" and having every record write rejected afterwards. The
  kit does not force it active: deactivation is a deliberate merchant action.
- **A custom-to-custom relationship whose stored target no longer matches the plan is
  reported** in the provisioning errors. The API only APPENDS relationships and no
  public route replaces one, so such a link stays silently pointing at a definition the
  API refuses to serve. The definition must be deleted and re-created to repair it.
- **The definition listing is requested with the API's maximum page size** (100 instead
  of the default 10), on the same single call as before. Soft-deleted homonyms count
  against that page. Shops with more than 100 definitions are still truncated.
- **The provisioning id map is MERGED, no longer overwritten.** Provisioning is
  best-effort per resource: a run where one resource failed used to write its partial
  map over the previous one, erasing ids a previous successful run had resolved. Since
  resolving a source or a definition throws on a missing id, one transient failure
  turned a healthy installation into a permanently broken sync. A failed run is now
  inert instead of destructive.
- **Partial provisioning on `config_updated` is no longer silent**: the collected
  errors are logged, like on activation.
- **Provisioning errors now say WHY.** The strings collected in `errors[]` carry the
  message the API actually returned, instead of only "Request failed with status code
  400" (the SDK's transport-level text; the business message sits in the raw body).

### Testing

- `SpmStubRequest` (scriptable stub) now exposes the request's query `params`, so a
  test can assert on pagination and filtering, not just on the path. Additive.

Backward compatible. No contract, dependency or migration change. Upgrading from
`2.0.0` is a drop-in.

## 2.0.0

**Pluggable persistence.** The store behind the kit is now an async, backend-agnostic
port (`IntegrationStore`) with two official adapters, SQLite (the zero-config
default, unchanged behaviour) and **PostgreSQL** (point the kit at your existing
database: no local file, no persistent filesystem, no native module to compile).

### New

- **`store` option** on `createIntegrationApp`: pass any `IntegrationStore`.
  `databasePath` still works and remains the SQLite sugar.
- **`@shopimind/integration-kit-js/store-sqlite`**: `createSqliteStore({ path, clock? })`.
- **`@shopimind/integration-kit-js/store-postgres`**: `createPostgresStore({
  connectionString | pool, schema?, maxConnections?, connectionTimeoutMs?,
  statementTimeoutMs?, pingTimeoutMs?, onPoolError?, clock? })`. All tables live in a
  dedicated PostgreSQL schema of YOUR database (default `shopimind_kit`; name one per
  integration); migrations are versioned, transactional and serialized on an advisory lock.
- **`@shopimind/integration-kit-js/store-testing`**: `runStoreConformanceSuite`,
  the executable contract of the port (atomic claims, secret-preview invariant,
  purge cutoffs, literal search, pagination). Both official adapters pass it in CI;
  run it against your own adapter if you implement a custom backend.
- Custom backends are an explicit extension point: implement `IntegrationStore`
  and validate with the conformance suite. Semver policy: the port may GAIN
  methods in a minor; removals/signature changes only in a major.

### Breaking

- **The persistence API is async.** Every repository method returns a `Promise`,
  including `ctx.state.get/set/setSecret/delete` and `ctx.setExternalAccount`.
  In practice an integration adds `await` at those call sites; everything else
  (`ctx.spm`, `ctx.sendBulk`, `ctx.withSource`, `ctx.customData`) is unchanged
  and stays synchronous to build.
- **`createIntegrationApp` is async** (`await createIntegrationApp(...)`): the
  store driver is loaded dynamically and the schema is migrated before the app is
  returned. Same for the test harness: `await makeTestApp(...)`, and its
  `signInbound(...)` is now async.
- **`IntegrationApp.db` is gone.** Use `IntegrationApp.store` (the port) and
  `IntegrationApp.repos` (kit facades, async). `openDatabase` / the better-sqlite3
  `Db` type are no longer exported from the package root. If you really need the
  raw handle, a store built by `createSqliteStore` still exposes it as `.db`.
- **The SQLite migration exports moved to the subpath.** `MIGRATIONS`,
  `Migration`, `runMigrations` and `currentSchemaVersion` are no longer exported
  by the package root; import them from
  `@shopimind/integration-kit-js/store-sqlite`. They are dialect-specific
  (PostgreSQL ships its own `PG_MIGRATIONS` on `/store-postgres`). Applying the
  schema is not a caller's job anyway: `createIntegrationApp` awaits
  `store.migrate()` before handing the app back.
- **These root exports are now async** (add `await`): `loadConfigs`,
  `saveConfigs`, `ensureInboundSecret`, `buildHealthReport`, `buildOverview`.
  If you wire the kit's HTTP layer yourself, the matching contracts changed too:
  `RouteDeps.healthReport` and `InboundDeps.buildContext` must now return a
  `Promise`.
- **`createRepositories(store, cipher, clock?)`** replaces
  `createRepositories(db, cipher)`. Pass an `IntegrationStore` (from
  `createSqliteStore` / `createPostgresStore` / your own adapter) instead of a
  better-sqlite3 handle. The optional third argument is an injectable clock for
  tests.
- **`better-sqlite3` is now an optional peer dependency** (as is `pg`). An
  integration using the SQLite default must add it to its own dependencies:
  `yarn add better-sqlite3`. A PostgreSQL integration adds `pg` instead, and
  never compiles a native module.
- `makeWithSource` / `makeCustomData` (advanced API) now take the pre-loaded
  provisioning blob: `makeWithSource(provisioningRaw, sendBulk)` and
  `makeCustomData(provisioningRaw, sendBulk, spm)`, instead of
  `(state, installationId, provisioningKey, ...)`. Read the blob once
  (`await repos.state.get(id, PROVISIONING_KEY)`) and pass it in. This is what
  keeps `ctx.withSource` / `ctx.customData` synchronous inside a step.
- **`webhookSecret` is validated at construction.** An empty string, an entry
  that is not a string, or an empty rotation array now throws instead of booting
  an integration whose webhooks could never verify.

### Hardening

Failure paths that only surface in production, closed as part of this release:

- **A failed boot no longer touches the store.** The credentials key and the
  webhook secret are validated BEFORE `store.migrate()` runs, so a typo in an
  environment variable cannot leave a half-converted database behind.
- **`stop()` drains in-flight syncs** before closing the store (bounded by
  `stopDrainTimeoutMs`, default 10s; keep it under your orchestrator's grace
  period). A sync caught by SIGTERM used to die mid-window against a closing
  backend, leaving its `sync_run` row `running` forever.
- **PostgreSQL: a dropped idle connection no longer kills the process.** The
  store always attaches a `pool.on('error')` listener (surfaced through the new
  `onPoolError` option), since `pg` otherwise raises it as an `uncaughtException` on a
  managed-database failover.
- **PostgreSQL: bounded waits.** New `connectionTimeoutMs` (5s),
  `statementTimeoutMs` (30s) and `pingTimeoutMs` (3s) options, so a saturated
  pool or an unresponsive server fails fast instead of hanging `/health`.
  Default `maxConnections` raised 5 → 10.
- **PostgreSQL: schemas are owned.** The first integration to migrate a schema
  stamps its slug on it; another integration pointed at the same schema now
  refuses to boot instead of silently merging both integrations' installations,
  cursors and secrets. `IntegrationStore.migrate(owner?)` carries the slug, though
  a custom adapter may ignore it (a SQLite file cannot collide this way).
- **`/health` always answers.** Every store call in the probe is guarded, not
  just the ping: a failure after the ping (revoked grants, dropped schema,
  failover mid-DDL) now returns the documented `{ db: 'error' }` / 503 instead of
  a bodiless 500.
- **Driver load errors are no longer mislabelled.** A native module that fails to
  *initialize* (the classic `better-sqlite3` ABI mismatch after a Node upgrade or
  an image rebuild) surfaces its real error; only a genuinely unresolvable module
  reports "install the peer dependency".
- **Pagination bounds are integers.** `limit`/`offset` and reveal/purge ids are
  floored and range-checked in the kit, so hostile input behaves identically on
  both adapters instead of erroring on PostgreSQL only.

### Migration from 1.x (SQLite, no backend change)

1. `yarn add @shopimind/integration-kit-js@^2 better-sqlite3`.
2. `const app = await createIntegrationApp(...)` (add the `await`).
3. Add `await` on every `ctx.state.*` and `ctx.setExternalAccount` call site.
4. Tests using `makeTestApp` / `signInbound`: add `await`.

**Your existing SQLite file is reused as-is**: same schema, same encrypted
secrets, same cursors, same idempotency/anti-replay keys. On first boot, a new
append-only migration (`9`, `normalize_legacy_timestamps`) rewrites the timestamps
v1 stamped through SQL `datetime('now')` (`YYYY-MM-DD HH:MM:SS`) into the ISO-8601
UTC form v2 writes. This runs once, inside the migration transaction; on a large
store it adds a few seconds to that first startup. It is what keeps retention
purges and time-window counters exact: the two formats do not compare against
each other (`' '` sorts before `'T'`), so a legacy row dated the same calendar day
as a purge cutoff would otherwise be deleted up to ~24h early.

> Rolling back to 1.x after running 2.x is possible (v1 reads the v2 rows, and its
> migration runner ignores the unknown version 9), with one degradation: `/health`
> can no longer compute the age of a run stamped by v2 (it appends a second `Z`
> before parsing), so staleness detection goes quiet until a v1 run is recorded.

### Switching to PostgreSQL

```ts
import { createPostgresStore } from '@shopimind/integration-kit-js/store-postgres';

const app = await createIntegrationApp(integration, {
  store: await createPostgresStore({
    connectionString: process.env.DATABASE_URL!,
    schema: 'shopimind_myintegration',
  }),
  // ...same options as before
});
```

Operational notes: the kit remains **single-replica per integration** (the sync
scheduler and overlap locks are per-process, which PostgreSQL does not change);
for scale-to-zero deployments disable `autoSync` and trigger syncs from an
external cron via `POST /admin/sync/{id}` or `app.runSyncOnce()`.

## 1.6.0

Operations console (`/admin/ui`) overhaul, plus an integration **Definition** view.

### Admin UI

- **Redesigned interface**: icon navigation, clearer typography and spacing, status /
  run badges, proportion bars, loading skeletons, empty states, light & dark themes.
- **Confirmation dialogs** before every heavy or destructive action (full backfill,
  reprovision, purge, payload reveal, logout).
- **Contextual help**: inline tooltips explaining each metric, table column and action.
- **Payloads** are pretty-printed in a collapsible, bordered box (expand / audited
  reveal) instead of an overflowing raw blob; long ids are shortened with a tooltip.
- The sidebar shows the **integration's name** over "Intégration ShopiMind".

### Additive API

- **`GET /admin/definition`** returns what the integration declares (meta, config
  schema, sync steps, widgets, inbound routes, hooks, capabilities), backing the new
  **Definition** page. Declarations only; no function bodies are exposed.
- **`GET /admin/meta`** now also carries the integration identity (`{ name, slug, version }`).

Backward compatible: additive only, no dependency, migration or contract change.
Upgrading from `1.5.x` is a drop-in.

## 1.5.0

Adds an **embedded admin operations UI** for the integrator: a local, self-contained
console to observe and operate the integration (installations, sync runs, webhooks,
inbound events, state, dead-letter, audit) and trigger safe actions (sync, reprovision,
reveal, purge). **Everything is additive and backward compatible**; two new embedded
SQLite migrations (7 = the audit trail, 8 = admin query/retention indexes) are applied
automatically. The UI is **100% integrator-side**. It only reads the local SQLite store
and talks to the ShopiMind API through the existing sync engine. No ShopiMind account,
service or database is involved.

### Admin surface & UI

- **Operations UI** at `GET /admin/ui`: a single self-contained HTML page (no external
  asset, strict per-request nonce CSP), served from a string compiled into `dist` (source
  in `src/admin-ui/ui.html`, embedded by a prebuild step).
- **Read API** (admin-gated): `/admin/meta`, `/admin/installations[/{id}]`, and per
  installation `…/cursors`, `…/runs`, `…/webhooks`, `…/inbound`, `…/state`, plus a global
  `/admin/rejected` and `/admin/audit`. All list endpoints paginate.
- **Browser session auth.** `POST /admin/session` exchanges the admin token for an
  HttpOnly, `SameSite=Strict` cookie + a CSRF token. Reads accept the cookie OR the
  `x-admin-token` header; a session's state-changing calls must also present the CSRF
  token (`x-csrf-token`). Sessions are bounded (sliding 12h TTL, LRU cap).
- **Actions** (audited): `POST /admin/sync/{id}`, `…/reprovision`, `/admin/rejected/purge`
  (installation-scoped), and audited **reveal** of a single webhook / rejected payload.
- **PII masking by default.** Webhook and dead-letter payloads are masked (emails, phones,
  names and addresses, including values given as JSON numbers and PII embedded in free text)
  before display; the raw value is only exposed by the separate, audited reveal action.
  **Secrets are never returned**: state is read as metadata only (an encrypted value is
  never materialized, enforced at the SQL layer).
- **Audit trail** (migration 7, new `audit_log` table): login, sync, reprovision, reveal
  and purge are recorded as metadata only (no secrets, no raw PII), with its own retention.

### New `createIntegrationApp` options

- `adminPort` / `adminHost`: serve the admin surface on a **separate listener** (default
  host `127.0.0.1`) so the public interface only exposes webhooks/inbound/health.
- `adminSecureCookie`: mark the session cookie `Secure` (HTTPS-only) for real deployments.
- `rejectedRetentionDays` (defaults to `retentionDays`) and `auditRetentionDays`
  (default 365) offer independent retention for the dead-letter and the audit trail.

### Security posture

- Loud startup warnings when the admin surface is exposed on a public `0.0.0.0` listener,
  when the admin token is short (< 32 chars), or when `adminSecureCookie` is off.
- Admin token comparison stays timing-safe (fixed-length HMAC digest) and per-IP
  rate-limited. No dependency was added.

## 1.4.0

Hardening release. **Everything is additive and backward compatible**: no public
type was removed or made stricter; existing connectors (e.g. Hiboutik) keep working
unchanged. Two new embedded SQLite migrations (5, 6) are applied automatically.

### Lifecycle & contracts

- **E1: lifecycle contract centred on `installation_id`.** In `LifecyclePayload`,
  `installation_id: string` is now the required identity. `id_shop_integration`,
  `id_shop` and `integration_slug` remain as `@deprecated` optional aliases (kept for
  backward compatibility). The dispatcher now consumes the public `LifecyclePayload`
  type instead of a private duplicate, so a contract change is reflected at the
  dispatch boundary by construction. `installation_id` takes precedence over the
  legacy alias.

### Sync engine

- **E2: silent-step warning.** A sync step that finishes clean (no error) but returns
  no `advanceCursorTo` now logs a `warn`, because a forgotten advance would replay the
  window forever.
- **E3: repeated-failure escalation & backoff** (migration 5). New
  `consecutive_failures` column on `sync_cursor`: incremented on failure/hold, reset on
  a clean advance. The engine now applies exponential backoff (`2^(k-1)` minutes,
  capped at 24h) to a persistently-failing cursor and escalates to an `error` log at the
  3rd consecutive failure. The golden rule (cursor only advances on a clean run) is
  unchanged; this only decides *when* to retry. Full backfills bypass backoff.
  Exported: `backoffWindowMs`.
- **E4: dead-letter of rejected items** (migration 6). New `rejected_item` table.
  Items the ShopiMind API rejects during a bulk push are recorded (payload, reason,
  entity, `run_id`), capped at 500/run, best-effort (never fails sync), purged by the
  existing retention. Admin endpoint `GET /admin/installations/{id}/rejected` (bounded,
  admin token).
- **E8: `tolerateRejects: boolean | { maxRatio }`.** With a ratio, rejections are
  tolerated (cursor advances) only while `rejected/attempted` stays within budget;
  above it the cursor is held. `true` == `{ maxRatio: 1 }`; `false`/omitted unchanged.
  Exported: `rejectsTolerated`.
- **E9: defensive window overlap.** `SyncOptions.overlapSeconds` (and
  `CreateAppOptions.overlapSeconds`) shifts an incremental window's `since` back by N
  seconds so a boundary item is not missed (re-fetches are idempotent upserts). Backfill
  windows are not shifted.
- **E11: honest types.** `CursorWrite.last_synced_at` is now `string | null` (the
  internal cast is gone). `SpmOrderStatus` technical fields (`is_deleted`, `created_at`,
  `updated_at`) are optional; the provisioning runner fills sensible defaults.
- **E12: `defineBulkStep` factory.** Pure sugar producing a plain `SyncStep` that
  encapsulates batch/flush/try-catch, item counting, and `advanceCursorTo = window.until`
  by default (defaults `enabled: () => true`, `cursorScope: 'global'`).

### Observability

- **E5: enriched `/health` + `/admin/overview`.** `/health` now pings the DB, reports
  the age of the last run per active installation and the number of cursors in error, and
  returns `503` when degraded (usable as a readiness/liveness probe). `GET /admin/overview`
  returns a JSON synthesis (installations, latest runs, recent webhooks). Exported:
  `buildHealthReport`, `buildOverview`.

### Provisioning

- **E10: safe custom-data provisioning.** The custom-data plan is topologically sorted,
  so a `custom → custom` relationship whose target is declared *after* the referencer
  still resolves; a genuine dependency cycle is a hard error. An out-of-plan, non-numeric
  relationship target is warned about instead of shipping an unresolvable id. New guards
  (`validateCustomDataDefinition`): `unique_keys ⊆ fields` and `relationships.sourceField
  ∈ fields`, run with precise error messages. Exported: `topoSortCustomData`,
  `validateCustomDataDefinition`.
- **E16: source matching by stable config key.** `NewDataSource.stableConfigKey?: string`.
  `ensureDataSource` matches an existing source by `config[stableConfigKey]` first (a
  permanent id, e.g. `hiboutik_store_id`), then by label. A source found by stable key
  with a drifted label has its label updated (a store rename no longer spawns a
  duplicate). Without the field, matching stays label-only. The field is authoring-only
  metadata and is not sent to the API.

### Security

- **E6: webhook secret rotation.** `webhookSecret` accepts `string | string[]`. A
  request signed with any listed secret passes, opening a rotation window while swapping
  `current → next`. Exported: `verifyShopimindSignatureMulti`.

### Outbound helpers (for connector → partner traffic)

- **E7: throttle & retry.** New exports `makeOutboundLimiter` (async token-bucket gate
  reusing the kit limiter) and `fetchWithRetry` (honours `Retry-After` + exponential
  backoff with full jitter on 429/5xx/network errors). Exported helpers:
  `parseRetryAfterMs`, `backoffDelayMs`.

### Not included

- **E13** (structural typing of records from `fields`), **E14** (example scaffolding,
  intentionally out of scope), **E15** (versioned AES key) are deferred.

## 1.3.0

- `ctx.customData(name)` accessor; custom relationship targets resolvable by sibling
  name; convergent relationship extend; type/build hygiene.
