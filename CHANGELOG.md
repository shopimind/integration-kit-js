# Changelog

All notable changes to `@shopimind/integration-kit-js` are documented here.
This project follows [Semantic Versioning](https://semver.org/): `patch` = fix,
`minor` = backward-compatible addition, `major` = breaking change.

## 1.4.0

Hardening release. **Everything is additive and backward compatible** — no public
type was removed or made stricter; existing connectors (e.g. Hiboutik) keep working
unchanged. Two new embedded SQLite migrations (5, 6) are applied automatically.

### Lifecycle & contracts

- **E1 — lifecycle contract centred on `installation_id`.** In `LifecyclePayload`,
  `installation_id: string` is now the required identity. `id_shop_integration`,
  `id_shop` and `integration_slug` remain as `@deprecated` optional aliases (kept for
  backward compatibility). The dispatcher now consumes the public `LifecyclePayload`
  type instead of a private duplicate, so a contract change is reflected at the
  dispatch boundary by construction. `installation_id` takes precedence over the
  legacy alias.

### Sync engine

- **E2 — silent-step warning.** A sync step that finishes clean (no error) but returns
  no `advanceCursorTo` now logs a `warn` — a forgotten advance would replay the window
  forever.
- **E3 — repeated-failure escalation & backoff** (migration 5). New
  `consecutive_failures` column on `sync_cursor`: incremented on failure/hold, reset on
  a clean advance. The engine now applies exponential backoff (`2^(k-1)` minutes,
  capped at 24h) to a persistently-failing cursor and escalates to an `error` log at the
  3rd consecutive failure. The golden rule (cursor only advances on a clean run) is
  unchanged — this only decides *when* to retry. Full backfills bypass backoff.
  Exported: `backoffWindowMs`.
- **E4 — dead-letter of rejected items** (migration 6). New `rejected_item` table.
  Items the ShopiMind API rejects during a bulk push are recorded (payload, reason,
  entity, `run_id`), capped at 500/run, best-effort (never fails sync), purged by the
  existing retention. Admin endpoint `GET /admin/installations/{id}/rejected` (bounded,
  admin token).
- **E8 — `tolerateRejects: boolean | { maxRatio }`.** With a ratio, rejections are
  tolerated (cursor advances) only while `rejected/attempted` stays within budget;
  above it the cursor is held. `true` == `{ maxRatio: 1 }`; `false`/omitted unchanged.
  Exported: `rejectsTolerated`.
- **E9 — defensive window overlap.** `SyncOptions.overlapSeconds` (and
  `CreateAppOptions.overlapSeconds`) shifts an incremental window's `since` back by N
  seconds so a boundary item is not missed (re-fetches are idempotent upserts). Backfill
  windows are not shifted.
- **E11 — honest types.** `CursorWrite.last_synced_at` is now `string | null` (the
  internal cast is gone). `SpmOrderStatus` technical fields (`is_deleted`, `created_at`,
  `updated_at`) are optional; the provisioning runner fills sensible defaults.
- **E12 — `defineBulkStep` factory.** Pure sugar producing a plain `SyncStep` that
  encapsulates batch/flush/try-catch, item counting, and `advanceCursorTo = window.until`
  by default (defaults `enabled: () => true`, `cursorScope: 'global'`).

### Observability

- **E5 — enriched `/health` + `/admin/overview`.** `/health` now pings the DB, reports
  the age of the last run per active installation and the number of cursors in error, and
  returns `503` when degraded (usable as a readiness/liveness probe). `GET /admin/overview`
  returns a JSON synthesis (installations, latest runs, recent webhooks). Exported:
  `buildHealthReport`, `buildOverview`.

### Provisioning

- **E10 — safe custom-data provisioning.** The custom-data plan is topologically sorted,
  so a `custom → custom` relationship whose target is declared *after* the referencer
  still resolves; a genuine dependency cycle is a hard error. An out-of-plan, non-numeric
  relationship target is warned about instead of shipping an unresolvable id. New guards
  (`validateCustomDataDefinition`): `unique_keys ⊆ fields` and `relationships.sourceField
  ∈ fields`, run with precise error messages. Exported: `topoSortCustomData`,
  `validateCustomDataDefinition`.
- **E16 — source matching by stable config key.** `NewDataSource.stableConfigKey?: string`.
  `ensureDataSource` matches an existing source by `config[stableConfigKey]` first (a
  permanent id, e.g. `hiboutik_store_id`), then by label. A source found by stable key
  with a drifted label has its label updated (a store rename no longer spawns a
  duplicate). Without the field, matching stays label-only. The field is authoring-only
  metadata and is not sent to the API.

### Security

- **E6 — webhook secret rotation.** `webhookSecret` accepts `string | string[]`. A
  request signed with any listed secret passes, opening a rotation window while swapping
  `current → next`. Exported: `verifyShopimindSignatureMulti`.

### Outbound helpers (for connector → partner traffic)

- **E7 — throttle & retry.** New exports `makeOutboundLimiter` (async token-bucket gate
  reusing the kit limiter) and `fetchWithRetry` (honours `Retry-After` + exponential
  backoff with full jitter on 429/5xx/network errors). Exported helpers:
  `parseRetryAfterMs`, `backoffDelayMs`.

### Not included

- **E13** (structural typing of records from `fields`), **E14** (example scaffolding —
  intentionally out of scope), **E15** (versioned AES key) are deferred.

## 1.3.0

- `ctx.customData(name)` accessor; custom relationship targets resolvable by sibling
  name; convergent relationship extend; type/build hygiene.
