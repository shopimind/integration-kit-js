import {
  SpmDataSources,
  SpmCustomDataDefinitions,
  SpmEvents,
  SpmHelpers,
  type SpmHttpClient,
} from '@shopimind/sdk-js';
import type {
  NewDataSource,
  NewCustomDataDefinition,
  NewCustomDataField,
  NewEvent,
} from '../contracts/index.js';
import type { Logger } from '../logging/logger.js';

/**
 * Idempotent find-or-create for ShopiMind resources, calling the SDK directly
 * (`unwrapOrThrow` unwraps the envelope / throws `SpmApiError` on failure). An
 * integration only declares the shapes.
 */

/** Reads an id, tolerating either field name the API may return. */
function numId(o: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) {
    if (o[k] != null) return Number(o[k]);
  }
  return 0;
}

/** Maps a kit field to an SDK/API field (label defaults to name, required defaults to false). */
function toSdkField(f: NewCustomDataField): Record<string, unknown> {
  return {
    name: f.name,
    label: f.label ?? f.name,
    type: f.type,
    required: f.required ?? false,
    ...(f.description !== undefined ? { description: f.description } : {}),
    ...(f.default !== undefined ? { default: f.default } : {}),
    ...(f.options !== undefined ? { options: f.options } : {}),
  };
}

/** Maps a kit definition to an SDK/API DTO. */
function toSdkDef(def: NewCustomDataDefinition): Record<string, unknown> {
  return {
    // Normalized, not raw: MySQL ignores TRAILING spaces in a comparison but not
    // LEADING ones, so sending ' pos' would let the kit match it to 'pos' on the
    // next run while the server's uniqueness check would not.
    name: normKey(def.name),
    ...(def.description !== undefined ? { description: def.description } : {}),
    ...(def.unique_keys !== undefined ? { unique_keys: def.unique_keys } : {}),
    fields: def.fields.map(toSdkField),
    ...(def.relationships !== undefined ? { relationships: def.relationships } : {}),
  };
}

/** Normalizes a natural key for comparison (trim; nullish -> empty string). */
function normKey(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

/**
 * Normalizes a custom-data definition NAME for comparison.
 *
 * Case-insensitive on purpose: the API's own name-uniqueness check runs on a
 * case-insensitive column collation, so a case-sensitive match here would let the
 * kit believe a name is free and then get the create rejected with
 * "custom data definition name is already used." — a permanent failure.
 * (Accents are NOT folded, while the server's collation does fold them: a name
 * differing only by an accent can still be refused on create.)
 */
function normName(v: unknown): string {
  // `toLowerCase()` (not `toLocaleLowerCase()`): the mapping must not depend on the
  // runtime locale — e.g. the Turkish locale maps 'I' outside of 'i'.
  return normKey(v).toLowerCase();
}

/** Extracts a property from a source's `config` (a JSON string), tolerating malformed JSON. */
function configValue(config: unknown, key: string): string | undefined {
  if (typeof config !== 'string' || config === '') return undefined;
  try {
    const parsed = JSON.parse(config) as Record<string, unknown>;
    const v = parsed?.[key];
    return v == null ? undefined : normKey(v);
  } catch {
    return undefined;
  }
}

/**
 * Finds a data source, otherwise creates it. Returns its id.
 *
 * Matching:
 *  - if `input.stableConfigKey` is set, match FIRST on `config[stableConfigKey]`
 *    (a permanent identifier, e.g. the store id) — a source found this way but with
 *    a DIFFERENT label has its label UPDATED to the new one (a rename no longer
 *    spawns a duplicate);
 *  - otherwise (or if no config match), fall back to matching by `label` as a
 *    natural key (the legacy behaviour, unchanged when `stableConfigKey` is absent).
 *
 * Comparisons are trimmed on both sides so incidental whitespace does not spawn a
 * duplicate source. `stableConfigKey` is kit-only metadata — never sent to the API.
 */
export async function ensureDataSource(client: SpmHttpClient, input: NewDataSource): Promise<number> {
  const existing =
    SpmHelpers.unwrapOrThrow<Array<Record<string, unknown>>>(
      await SpmDataSources.list(client),
      'listDataSources',
    ) ?? [];
  const wantedLabel = normKey(input.label);

  // Stable-key match first (survives a label rename).
  if (input.stableConfigKey) {
    const wantedKeyValue = configValue(input.config, input.stableConfigKey);
    if (wantedKeyValue !== undefined) {
      const byKey = existing.find((s) => configValue(s.config, input.stableConfigKey as string) === wantedKeyValue);
      if (byKey) {
        const id = numId(byKey, 'id_data_source', 'id');
        // Label drifted (merchant renamed the store) -> update it, do NOT duplicate.
        if (normKey(byKey.label) !== wantedLabel) {
          await SpmDataSources.update(client, id, { label: input.label });
        }
        return id;
      }
    }
  }

  const found = existing.find((s) => normKey(s.label) === wantedLabel);
  if (found) return numId(found, 'id_data_source', 'id');

  // `stableConfigKey` is authoring-only metadata: strip it from the create DTO.
  const { stableConfigKey: _drop, ...createDto } = input;
  const created = SpmHelpers.unwrapOrThrow<Record<string, unknown>>(
    await SpmDataSources.create(client, createDto),
    'createDataSource',
  );
  return numId(created, 'id_data_source', 'id');
}

/**
 * Largest page the definition listing will serve. It defaults to 10 rows, and ANY
 * value above 100 silently falls BACK to 10 — never up to 100. Soft-deleted rows
 * count against that page, so asking for the largest legal page is what keeps a
 * live definition visible on a shop that went through delete/re-create cycles.
 */
const MAX_LISTING_PAGE = 100;

/** How usable a listed definition is, per API status. Unknown statuses rank as `active`. */
const STATUS_RANK: Record<string, number> = { active: 3, inactive: 2, editing: 1, creating: 1 };

/**
 * The ONLY status that makes a listed definition unusable for provisioning.
 *
 * Deleting a definition is a LOGICAL delete server-side: the row keeps its name and
 * stays in `GET /custom-data-definitions`, but `GET /custom-data-definitions/{id}`
 * answers HTTP 400 "Custom data definition not found" for it. Matching such a row
 * therefore aborts this definition on EVERY subsequent activation.
 *
 * Deliberately fail-OPEN: a row whose `status` is absent, empty or of an unexpected
 * shape is treated as USABLE. A missing field must degrade to the previous
 * behaviour, never turn every lookup into a create — the API rejects a create whose
 * name is held by a LIVE definition, so a fail-closed predicate would break
 * provisioning everywhere instead of only here.
 *
 * Only `deleted` is filtered out. `creating` / `editing` / `inactive` rows are KEPT:
 * they still hold the name as far as the API's uniqueness check is concerned, so
 * routing them to the create branch would trade a transient, retryable error for a
 * permanent one.
 */
function isDeletedDefinition(row: Record<string, unknown>): boolean {
  return normKey(row.status).toLowerCase() === 'deleted';
}

/**
 * Resolves the definition to converge on among the rows carrying the wanted name.
 * Returns `undefined` when none is usable (the caller then creates one).
 *
 * "The first row wins" is not safe here: the listing has NO default ordering, and
 * name uniqueness is enforced only in application code and only across non-deleted
 * rows — so several homonyms can legally coexist. The choice is explicit instead:
 *  - soft-deleted rows are skipped (the reason this function exists);
 *  - rows without a usable id are skipped (never dereference id 0);
 *  - the most usable status wins — an `active` row over an `inactive` one, which
 *    would reject every record write;
 *  - on a tie, the LOWEST id wins: the oldest row, the one already holding the
 *    records, and a choice two concurrent activations both agree on.
 */
function findDefinition(
  rows: Array<Record<string, unknown>>,
  wantedName: string,
): { id: number; status: string } | undefined {
  const best = rows
    .filter((d) => normName(d.name ?? d.schema_name) === wantedName && !isDeletedDefinition(d))
    .map((d) => {
      const status = normKey(d.status).toLowerCase();
      return { id: numId(d, 'id_definition', 'id'), status, rank: STATUS_RANK[status] ?? 3 };
    })
    .filter((c) => c.id > 0)
    .sort((a, b) => b.rank - a.rank || a.id - b.id)[0];
  return best ? { id: best.id, status: best.status } : undefined;
}

/** Reads a relationship's source field, tolerating either spelling the API may return. */
function relSourceField(r: Record<string, unknown>): string {
  return normKey(r.sourceField ?? r.source_field);
}

/** Reads a relationship's target schema, tolerating either spelling the API may return. */
function relTargetSchema(r: Record<string, unknown>): string {
  return normKey(r.targetSchema ?? r.target_schema);
}

/**
 * Finds a custom-data definition by its natural key (`name`, falling back to the
 * API's `schema_name`), otherwise creates and activates it. Convergent
 * provisioning: if the integration has evolved, the existing definition is
 * extended (only the missing fields are sent) instead of being left untouched.
 *
 * Invariant: a definition's `name` (alias `schema_name`) is expected to be UNIQUE
 * across an account; it is matched as a natural key. The comparison is trimmed and
 * CASE-INSENSITIVE on both sides, mirroring the API's own uniqueness check, so
 * incidental differences do not spawn a duplicate.
 *
 * SOFT-DELETED homonyms are ignored (see {@link findDefinition}): the API keeps them
 * in the listing but refuses to serve them by id, and its own name-uniqueness check
 * excludes them — so re-creating under the same name is both necessary and accepted.
 * NOTE for integrators: the re-created definition is a NEW one (new id, new physical
 * table); records written to the deleted one are not carried over, and no public
 * route can restore it.
 *
 * `collect` receives operator-facing problems that must NOT abort the definition
 * (they are surfaced in the provisioning result instead of thrown).
 */
export async function ensureCustomDataDefinition(
  client: SpmHttpClient,
  def: NewCustomDataDefinition,
  logger?: Logger,
  collect?: (message: string) => void,
): Promise<number> {
  const existing = SpmHelpers.unwrapOrThrow<Array<Record<string, unknown>>>(
    // Largest legal page, on the SAME single call as before (the SDK already takes a
    // query argument, so no SDK change and no extra round-trip) — see MAX_LISTING_PAGE.
    await SpmCustomDataDefinitions.list(client, { limit: MAX_LISTING_PAGE }),
    'listCustomDataDefinitions',
  );
  const wantedName = normName(def.name);
  const match = findDefinition(existing ?? [], wantedName);
  if (match) {
    const id = match.id;
    // A definition that is not `active` provisions "successfully" and then has EVERY
    // record write rejected by the API. Without this the failure surfaces much later,
    // as an unexplained sync error. The kit does not force it active: `inactive` is a
    // deliberate merchant action, `creating`/`editing` are server-side transitions.
    if (match.status !== '' && match.status !== 'active') {
      logger?.warn(
        `custom data '${def.name}': matched definition has status '${match.status}' -- record writes will be REJECTED until it is active`,
        { definition: def.name, id, status: match.status },
      );
    }
    const full = SpmHelpers.unwrapOrThrow<Record<string, unknown>>(
      await SpmCustomDataDefinitions.get(client, id),
      'getCustomDataDefinition',
    );
    // Convergent extend: send only what the existing definition LACKS — new fields
    // (by `name`) AND new relationships (by `sourceField`). The API appends, so
    // existing fields/relationships are preserved.
    const fields = Array.isArray(full.fields) ? (full.fields as Array<{ name?: string }>) : [];
    const haveFields = new Set(fields.map((f) => f.name).filter((n): n is string => !!n));
    const missingFields = def.fields.filter((f) => !haveFields.has(f.name));

    const rels = Array.isArray(full.relationships) ? (full.relationships as Array<Record<string, unknown>>) : [];
    const haveRels = new Set(rels.map(relSourceField).filter((s) => s !== ''));
    const missingRels = (def.relationships ?? []).filter((r) => !haveRels.has(normKey(r.sourceField)));

    // A relationship whose `sourceField` already exists is NEVER re-sent (the API only
    // APPENDS, and no public route replaces one). So when its stored target no longer
    // matches what this plan resolves to — typically because the target definition was
    // deleted and re-created under a new id — the link is silently stale: it still
    // points at a definition the API refuses to serve. Converging quietly here would
    // trade a loud failure for a dead relationship nobody notices.
    for (const r of def.relationships ?? []) {
      if (r.targetSchemaType !== 'custom') continue;
      const stored = rels.find((x) => relSourceField(x) === normKey(r.sourceField));
      if (!stored) continue;
      const storedTarget = relTargetSchema(stored);
      const wantedTarget = normKey(r.targetSchema);
      // Compare only when BOTH sides are resolved numeric ids. A plan target left as a
      // NAME (out-of-plan, already warned about by the runner) or an unexpected stored
      // shape must not raise a false alarm.
      if (!/^\d+$/.test(storedTarget) || !/^\d+$/.test(wantedTarget) || storedTarget === wantedTarget) continue;
      const message =
        `relationship '${r.sourceField}' still points at definition ${storedTarget} but the plan resolves to ` +
        `${wantedTarget} -- the API cannot update an existing relationship; delete and re-create '${def.name}' to repair it`;
      logger?.error(`custom data '${def.name}': ${message}`, {
        definition: def.name,
        sourceField: r.sourceField,
        storedTarget,
        wantedTarget,
      });
      collect?.(message);
    }

    if (missingFields.length > 0 || missingRels.length > 0) {
      SpmHelpers.unwrapOrThrow(
        await SpmCustomDataDefinitions.extend(client, id, {
          ...(missingFields.length > 0 ? { fields: missingFields.map(toSdkField) } : {}),
          ...(missingRels.length > 0 ? { relationships: missingRels } : {}),
        } as unknown as Parameters<typeof SpmCustomDataDefinitions.extend>[2]),
        'extendCustomDataDefinition',
      );
    }
    return id;
  }

  const created = SpmHelpers.unwrapOrThrow<Record<string, unknown>>(
    await SpmCustomDataDefinitions.create(client, toSdkDef(def) as unknown as Parameters<typeof SpmCustomDataDefinitions.create>[1]),
    'createCustomDataDefinition',
  );
  const id = numId(created, 'id_definition', 'id');
  // Activation is best-effort and idempotent: a 409 means "already active", which
  // is the desired end state, so we tolerate it. Any OTHER non-ok envelope is a
  // genuine surprise (e.g. 5xx, permission) — we surface it as a warning rather
  // than throwing, so a freshly created (but not yet activated) definition does
  // not abort the whole provisioning run, but the operator still gets a signal.
  const activated = await SpmCustomDataDefinitions.activate(client, id);
  if (!activated.ok && activated.statusCode !== 409) {
    logger?.warn(
      'ensureCustomDataDefinition: activate(...) returned status ...; definition created but not confirmed active',
      { definition: def.name, id, statusCode: activated.statusCode },
    );
  }
  return id;
}

/** Creates an event type, tolerating a 409 "already exists" (idempotent). */
export async function ensureEvent(client: SpmHttpClient, event: NewEvent): Promise<void> {
  const res = await SpmEvents.create(client, event as unknown as Parameters<typeof SpmEvents.create>[1]);
  if (res.ok || res.statusCode === 409) return;
  SpmHelpers.unwrapOrThrow(res, 'createEvent'); // throws SpmApiError for any other error
}
