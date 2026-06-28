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
    name: def.name,
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
 * Finds a data source by `label`, otherwise creates it. Returns its id.
 *
 * Invariant: `label` is expected to be UNIQUE across an account's data sources;
 * the find-or-create matches on it as a natural key. The comparison is trimmed
 * on both sides so trailing/leading whitespace differences do not spawn a
 * duplicate source.
 */
export async function ensureDataSource(client: SpmHttpClient, input: NewDataSource): Promise<number> {
  const existing = SpmHelpers.unwrapOrThrow<Array<Record<string, unknown>>>(
    await SpmDataSources.list(client),
    'listDataSources',
  );
  const wantedLabel = normKey(input.label);
  const found = (existing ?? []).find((s) => normKey(s.label) === wantedLabel);
  if (found) return numId(found, 'id_data_source', 'id');
  const created = SpmHelpers.unwrapOrThrow<Record<string, unknown>>(
    await SpmDataSources.create(client, input),
    'createDataSource',
  );
  return numId(created, 'id_data_source', 'id');
}

/**
 * Finds a custom-data definition by its natural key (`name`, falling back to the
 * API's `schema_name`), otherwise creates and activates it. Convergent
 * provisioning: if the integration has evolved, the existing definition is
 * extended (only the missing fields are sent) instead of being left untouched.
 *
 * Invariant: a definition's `name` (alias `schema_name`) is expected to be UNIQUE
 * across an account; it is matched as a natural key. The comparison is trimmed on
 * both sides so incidental whitespace differences do not spawn a duplicate.
 */
export async function ensureCustomDataDefinition(
  client: SpmHttpClient,
  def: NewCustomDataDefinition,
): Promise<number> {
  const existing = SpmHelpers.unwrapOrThrow<Array<Record<string, unknown>>>(
    await SpmCustomDataDefinitions.list(client),
    'listCustomDataDefinitions',
  );
  const wantedName = normKey(def.name);
  const found = (existing ?? []).find((d) => normKey(d.name ?? d.schema_name) === wantedName);
  if (found) {
    const id = numId(found, 'id_definition', 'id');
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

    const rels = Array.isArray(full.relationships) ? (full.relationships as Array<{ sourceField?: string }>) : [];
    const haveRels = new Set(rels.map((r) => r.sourceField).filter((s): s is string => !!s));
    const missingRels = (def.relationships ?? []).filter((r) => !haveRels.has(r.sourceField));

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
    console.warn(
      `ensureCustomDataDefinition: activate(${id}) returned status ${activated.statusCode}; definition created but not confirmed active`,
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
