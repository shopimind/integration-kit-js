import { describe, it, expect } from 'vitest';
import { ensureCustomDataDefinition, ensureDataSource, ensureEvent } from './ensure.js';
import { makeScriptedSpmClient as mockClient } from '../testing/harness.js';
import { createLogger, type LogLine } from '../logging/logger.js';

/** Read response (double-nested): unwrapOrThrow unwraps it to `data`. */
const read = (data: unknown) => ({ body: { statusCode: 200, data } });

const DEF = { name: 'pos_profile', fields: [{ name: 'id_customer', type: 'text' as const }] };

describe('ensureCustomDataDefinition', () => {
  it('does NOT recreate when the def already exists (matched by `name`)', async () => {
    let created = 0;
    const client = mockClient(({ method, url }) => {
      if (method === 'get' && url === 'custom-data-definitions') return read([{ id_definition: 7, name: 'pos_profile' }]);
      if (method === 'get' && url === 'custom-data-definitions/7') return read({ id_definition: 7, name: 'pos_profile', fields: [{ name: 'id_customer' }] });
      if (method === 'post' && url === 'custom-data-definitions') { created += 1; return read({ id_definition: 8 }); }
      return read({});
    });
    const id = await ensureCustomDataDefinition(client, DEF);
    expect(id).toBe(7);
    expect(created).toBe(0);
  });

  it('extends the existing def when a declared field is missing (convergent provisioning)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let extended: any[] | null = null;
    const client = mockClient(({ method, url, body }) => {
      if (method === 'get' && url === 'custom-data-definitions') return read([{ id_definition: 7, name: 'pos_profile' }]);
      if (method === 'get' && url === 'custom-data-definitions/7') return read({ id_definition: 7, name: 'pos_profile', fields: [{ name: 'id_customer' }] });
      if (method === 'patch' && url === 'custom-data-definitions/7/extend') { extended = body.fields; return read({}); }
      return read({});
    });
    const def = {
      name: 'pos_profile',
      fields: [
        { name: 'id_customer', type: 'text' as const },
        { name: 'points', type: 'number' as const },
      ],
    };
    const id = await ensureCustomDataDefinition(client, def);
    expect(id).toBe(7);
    expect(extended?.map((f) => f.name)).toEqual(['points']); // only the missing field
  });

  it('extends the existing def with a missing relationship (convergent)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let extendBody: any = null;
    const client = mockClient(({ method, url, body }) => {
      if (method === 'get' && url === 'custom-data-definitions') return read([{ id_definition: 7, name: 'pos_profile' }]);
      if (method === 'get' && url === 'custom-data-definitions/7')
        return read({ id_definition: 7, name: 'pos_profile', fields: [{ name: 'id_customer' }], relationships: [] });
      if (method === 'patch' && url === 'custom-data-definitions/7/extend') { extendBody = body; return read({}); }
      return read({});
    });
    const def = {
      name: 'pos_profile',
      fields: [{ name: 'id_customer', type: 'text' as const }],
      relationships: [
        { sourceField: 'id_customer', targetSchemaType: 'system' as const, targetSchema: 'contacts', targetField: 'id_contact' },
      ],
    };
    const id = await ensureCustomDataDefinition(client, def);
    expect(id).toBe(7);
    expect(extendBody.relationships?.[0]?.sourceField).toBe('id_customer');
    expect(extendBody.fields).toBeUndefined(); // no missing field -> relationships only
  });

  it('creates then activates when the def is absent', async () => {
    let activated = 0;
    const client = mockClient(({ method, url }) => {
      if (method === 'get' && url === 'custom-data-definitions') return read([]);
      if (method === 'post' && url === 'custom-data-definitions') return read({ id_definition: 99 });
      if (method === 'patch' && url === 'custom-data-definitions/99/activate') { activated += 1; return read({}); }
      return read({});
    });
    const id = await ensureCustomDataDefinition(client, DEF);
    expect(id).toBe(99);
    expect(activated).toBe(1);
  });

  // --- Soft-deleted definitions (the reported bug) ---------------------------
  // Deleting a definition is a LOGICAL delete: the row keeps its name and stays in
  // the listing, but `GET /custom-data-definitions/{id}` answers 400 for it.

  it('ignores a SOFT-DELETED homonym and creates a fresh definition (reported bug)', async () => {
    let created = 0;
    let activated = 0;
    let readBackById = 0;
    const client = mockClient(({ method, url }) => {
      if (method === 'get' && url === 'custom-data-definitions')
        return read([{ id_definition: 1, name: 'pos_profile', status: 'deleted' }]);
      // Reaching this IS the bug: the API answers 400 for a soft-deleted definition.
      if (method === 'get' && /^custom-data-definitions\/\d+$/.test(url)) {
        readBackById += 1;
        return { status: 400, body: { statusCode: 400, message: 'Custom data definition not found' } };
      }
      if (method === 'post' && url === 'custom-data-definitions') { created += 1; return read({ id_definition: 12 }); }
      if (method === 'patch' && url === 'custom-data-definitions/12/activate') { activated += 1; return read({}); }
      return read({});
    });
    const id = await ensureCustomDataDefinition(client, DEF);
    expect(id).toBe(12);
    expect(created).toBe(1);
    expect(activated).toBe(1);
    expect(readBackById).toBe(0); // the tombstone is NEVER dereferenced
  });

  it('ignores SEVERAL soft-deleted homonyms (repeated delete/re-create cycles)', async () => {
    let created = 0;
    const client = mockClient(({ method, url }) => {
      // Wire shape: the listing stringifies scalars, so ids arrive as strings.
      if (method === 'get' && url === 'custom-data-definitions')
        return read([
          { id_definition: '1', name: 'pos_profile', status: 'deleted' },
          { id_definition: '4', name: 'pos_profile', status: 'deleted' },
          { id_definition: '9', name: 'other_def', status: 'active' },
        ]);
      if (method === 'get' && /^custom-data-definitions\/\d+$/.test(url))
        return { status: 400, body: { statusCode: 400, message: 'Custom data definition not found' } };
      if (method === 'post' && url === 'custom-data-definitions') { created += 1; return read({ id_definition: 15 }); }
      return read({});
    });
    expect(await ensureCustomDataDefinition(client, DEF)).toBe(15);
    expect(created).toBe(1);
  });

  it('prefers the LIVE homonym over a soft-deleted one (no recreation)', async () => {
    let created = 0;
    const client = mockClient(({ method, url }) => {
      if (method === 'get' && url === 'custom-data-definitions')
        return read([
          { id_definition: 1, name: 'pos_profile', status: 'deleted' },
          { id_definition: 9, name: 'pos_profile', status: 'active' },
        ]);
      if (method === 'get' && url === 'custom-data-definitions/9')
        return read({ id_definition: 9, name: 'pos_profile', fields: [{ name: 'id_customer' }] });
      if (method === 'post' && url === 'custom-data-definitions') { created += 1; return read({ id_definition: 13 }); }
      return read({});
    });
    expect(await ensureCustomDataDefinition(client, DEF)).toBe(9);
    expect(created).toBe(0);
  });

  // --- Deterministic resolution among homonyms -------------------------------

  it('prefers an ACTIVE homonym over an INACTIVE one (an inactive def rejects every record)', async () => {
    const client = mockClient(({ method, url }) => {
      // The inactive row is served FIRST on purpose: order must not decide.
      if (method === 'get' && url === 'custom-data-definitions')
        return read([
          { id_definition: 4, name: 'pos_profile', status: 'inactive' },
          { id_definition: 31, name: 'pos_profile', status: 'active' },
        ]);
      if (method === 'get' && url === 'custom-data-definitions/31')
        return read({ id_definition: 31, name: 'pos_profile', fields: [{ name: 'id_customer' }] });
      return read({});
    });
    expect(await ensureCustomDataDefinition(client, DEF)).toBe(31); // not the lower id, not the first row
  });

  it('picks the LOWEST id on a tie (the listing has no guaranteed ordering)', async () => {
    const client = mockClient(({ method, url }) => {
      if (method === 'get' && url === 'custom-data-definitions')
        return read([
          { id_definition: '31', name: 'pos_profile', status: 'active' },
          { id_definition: '12', name: 'pos_profile', status: 'active' },
        ]);
      if (method === 'get' && url === 'custom-data-definitions/12')
        return read({ id_definition: 12, name: 'pos_profile', fields: [{ name: 'id_customer' }] });
      return read({});
    });
    expect(await ensureCustomDataDefinition(client, DEF)).toBe(12); // not the first row served
  });

  it('warns when the matched definition is NOT active (record writes would be rejected)', async () => {
    const lines: LogLine[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l) });
    const client = mockClient(({ method, url }) => {
      if (method === 'get' && url === 'custom-data-definitions')
        return read([{ id_definition: 4, name: 'pos_profile', status: 'inactive' }]);
      if (method === 'get' && url === 'custom-data-definitions/4')
        return read({ id_definition: 4, name: 'pos_profile', fields: [{ name: 'id_customer' }] });
      return read({});
    });
    expect(await ensureCustomDataDefinition(client, DEF, logger)).toBe(4); // still usable: it holds the name
    expect(lines.some((l) => l.level === 'warn' && /status 'inactive'/.test(l.message))).toBe(true);
  });

  // --- Name matching: same semantics as the server ---------------------------

  it('matches a homonym differing only by CASE (the API uniqueness check is case-insensitive)', async () => {
    let created = 0;
    const client = mockClient(({ method, url }) => {
      if (method === 'get' && url === 'custom-data-definitions')
        return read([{ id_definition: 7, name: 'POS_Profile', status: 'active' }]);
      if (method === 'get' && url === 'custom-data-definitions/7')
        return read({ id_definition: 7, name: 'POS_Profile', fields: [{ name: 'id_customer' }] });
      if (method === 'post' && url === 'custom-data-definitions') { created += 1; return read({ id_definition: 8 }); }
      return read({});
    });
    expect(await ensureCustomDataDefinition(client, DEF)).toBe(7);
    expect(created).toBe(0); // creating would be refused: "name is already used"
  });

  it('sends a TRIMMED name on create (MySQL does not ignore leading spaces)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let createDto: any = null;
    const client = mockClient(({ method, url, body }) => {
      if (method === 'get' && url === 'custom-data-definitions') return read([]);
      if (method === 'post' && url === 'custom-data-definitions') { createDto = body; return read({ id_definition: 3 }); }
      return read({});
    });
    await ensureCustomDataDefinition(client, { ...DEF, name: '  pos_profile  ' });
    expect(createDto.name).toBe('pos_profile');
  });

  // --- Backward compatibility + page size ------------------------------------

  it('fail-open: a row WITHOUT a `status` field is still matched, and asks for the max page', async () => {
    let created = 0;
    let sentParams: Record<string, unknown> | undefined;
    const client = mockClient(({ method, url, params }) => {
      if (method === 'get' && url === 'custom-data-definitions') {
        sentParams = params;
        return read([{ id_definition: 7, name: 'pos_profile' }]); // legacy shape, no `status`
      }
      if (method === 'get' && url === 'custom-data-definitions/7')
        return read({ id_definition: 7, name: 'pos_profile', fields: [{ name: 'id_customer' }] });
      if (method === 'post' && url === 'custom-data-definitions') { created += 1; return read({ id_definition: 8 }); }
      return read({});
    });
    expect(await ensureCustomDataDefinition(client, DEF)).toBe(7);
    expect(created).toBe(0);
    expect(sentParams?.limit).toBe(100); // anything ABOVE 100 silently falls back to 10
  });

  // --- Stale custom->custom relationship -------------------------------------

  it('reports a custom relationship whose stored target no longer matches the plan', async () => {
    const collected: string[] = [];
    const lines: LogLine[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l) });
    let extended = 0;
    const client = mockClient(({ method, url }) => {
      if (method === 'get' && url === 'custom-data-definitions')
        return read([{ id_definition: 7, name: 'contact_store', status: 'active' }]);
      if (method === 'get' && url === 'custom-data-definitions/7')
        return read({
          id_definition: 7,
          name: 'contact_store',
          fields: [{ name: 'store_ref' }],
          // Points at the OLD (deleted, then re-created) target definition.
          relationships: [{ sourceField: 'store_ref', targetSchema: '1', targetField: 'id' }],
        });
      if (method === 'patch' && /extend$/.test(url)) { extended += 1; return read({}); }
      return read({});
    });
    const def = {
      name: 'contact_store',
      fields: [{ name: 'store_ref', type: 'text' as const }],
      relationships: [
        { sourceField: 'store_ref', targetSchemaType: 'custom' as const, targetSchema: '42', targetField: 'id' },
      ],
    };
    const id = await ensureCustomDataDefinition(client, def, logger, (m) => collected.push(m));
    expect(id).toBe(7);
    expect(extended).toBe(0); // the API only appends: nothing can be sent to fix it
    expect(collected.some((m) => /still points at definition 1 .*resolves to 42/.test(m))).toBe(true);
    expect(lines.some((l) => l.level === 'error')).toBe(true);
  });

  it('does NOT flag a relationship whose plan target is an UNRESOLVED name (no false alarm)', async () => {
    const collected: string[] = [];
    const client = mockClient(({ method, url }) => {
      if (method === 'get' && url === 'custom-data-definitions')
        return read([{ id_definition: 7, name: 'contact_store', status: 'active' }]);
      if (method === 'get' && url === 'custom-data-definitions/7')
        return read({
          id_definition: 7,
          name: 'contact_store',
          fields: [{ name: 'store_ref' }],
          relationships: [{ sourceField: 'store_ref', targetSchema: '1', targetField: 'id' }],
        });
      return read({});
    });
    const def = {
      name: 'contact_store',
      fields: [{ name: 'store_ref', type: 'text' as const }],
      relationships: [
        // Out-of-plan custom target, left as a NAME by the runner (already warned there):
        // "1" vs "stores" is NOT a stale link, it is an unresolved plan.
        { sourceField: 'store_ref', targetSchemaType: 'custom' as const, targetSchema: 'stores', targetField: 'id' },
      ],
    };
    await ensureCustomDataDefinition(client, def, undefined, (m) => collected.push(m));
    expect(collected).toEqual([]);
  });

  it('stays silent when the stored relationship target still matches the plan', async () => {
    const collected: string[] = [];
    const client = mockClient(({ method, url }) => {
      if (method === 'get' && url === 'custom-data-definitions')
        return read([{ id_definition: 7, name: 'contact_store', status: 'active' }]);
      if (method === 'get' && url === 'custom-data-definitions/7')
        return read({
          id_definition: 7,
          name: 'contact_store',
          fields: [{ name: 'store_ref' }],
          relationships: [{ sourceField: 'store_ref', targetSchema: '42', targetField: 'id' }],
        });
      return read({});
    });
    const def = {
      name: 'contact_store',
      fields: [{ name: 'store_ref', type: 'text' as const }],
      relationships: [
        { sourceField: 'store_ref', targetSchemaType: 'custom' as const, targetSchema: '42', targetField: 'id' },
      ],
    };
    await ensureCustomDataDefinition(client, def, undefined, (m) => collected.push(m));
    expect(collected).toEqual([]);
  });

  // --- Guards: never catch-and-recreate --------------------------------------

  it('RACE: a def deleted between the list and the get FAILS LOUDLY (never silently recreated)', async () => {
    let created = 0;
    const client = mockClient(({ method, url }) => {
      // The listing still shows it as live...
      if (method === 'get' && url === 'custom-data-definitions')
        return read([{ id_definition: 7, name: 'pos_profile', status: 'active' }]);
      // ...but it was deleted in between: the API now refuses to serve it.
      if (method === 'get' && url === 'custom-data-definitions/7')
        return { status: 400, body: { statusCode: 400, message: 'Custom data definition not found' } };
      if (method === 'post' && url === 'custom-data-definitions') { created += 1; return read({ id_definition: 20 }); }
      return read({});
    });
    await expect(ensureCustomDataDefinition(client, DEF)).rejects.toThrow(/getCustomDataDefinition/);
    expect(created).toBe(0); // no blind catch-and-recreate
  });

  it('does NOT recreate on a 400 raised for ANOTHER reason (transient internal error)', async () => {
    let created = 0;
    const client = mockClient(({ method, url }) => {
      if (method === 'get' && url === 'custom-data-definitions')
        return read([{ id_definition: 7, name: 'pos_profile', status: 'active' }]);
      // The API wraps internal failures in the SAME 400 as "not found".
      if (method === 'get' && url === 'custom-data-definitions/7')
        return { status: 400, body: { statusCode: 400, message: 'An unexpected error occurred during retrieval' } };
      if (method === 'post' && url === 'custom-data-definitions') { created += 1; return read({ id_definition: 21 }); }
      return read({});
    });
    await expect(ensureCustomDataDefinition(client, DEF)).rejects.toThrow();
    expect(created).toBe(0); // a DB hiccup must never spawn a new table
  });
});

describe('ensureDataSource', () => {
  it('reuses an existing source by label', async () => {
    let created = 0;
    const client = mockClient(({ method, url }) => {
      if (method === 'get' && url === 'data-sources') return read([{ id_data_source: 5, label: 'Hiboutik POS', type: 'api' }]);
      if (method === 'post' && url === 'data-sources') { created += 1; return read({ id_data_source: 6 }); }
      return read({});
    });
    const id = await ensureDataSource(client, { label: 'Hiboutik POS', type: 'api' });
    expect(id).toBe(5);
    expect(created).toBe(0);
  });

  it('matches the label after trimming (no duplicate from incidental whitespace)', async () => {
    let created = 0;
    const client = mockClient(({ method, url }) => {
      if (method === 'get' && url === 'data-sources') return read([{ id_data_source: 5, label: '  Hiboutik POS  ', type: 'api' }]);
      if (method === 'post' && url === 'data-sources') { created += 1; return read({ id_data_source: 6 }); }
      return read({});
    });
    const id = await ensureDataSource(client, { label: 'Hiboutik POS', type: 'api' });
    expect(id).toBe(5);
    expect(created).toBe(0);
  });

  it('E16: matches by stableConfigKey even when the label changed, and updates the label', async () => {
    let created = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let updated: { id: any; dto: any } | null = null;
    const client = mockClient(({ method, url, body }) => {
      if (method === 'get' && url === 'data-sources')
        return read([{ id_data_source: 5, label: 'Old Store Name', type: 'api', config: JSON.stringify({ hiboutik_store_id: 42 }) }]);
      if (method === 'post' && url === 'data-sources') { created += 1; return read({ id_data_source: 6 }); }
      if (method === 'put' && /data-sources\/5$/.test(url)) { updated = { id: 5, dto: body }; return read({}); }
      return read({});
    });
    const id = await ensureDataSource(client, {
      label: 'New Store Name',
      type: 'api',
      config: JSON.stringify({ hiboutik_store_id: 42 }),
      stableConfigKey: 'hiboutik_store_id',
    });
    expect(id).toBe(5); // matched by stable key, not label
    expect(created).toBe(0); // no duplicate spawned
    expect(updated?.dto?.label).toBe('New Store Name'); // label refreshed
  });

  it('E16: stableConfigKey match with the SAME label does not issue an update', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let patched = 0;
    const client = mockClient(({ method, url }) => {
      if (method === 'get' && url === 'data-sources')
        return read([{ id_data_source: 5, label: 'Store', type: 'api', config: JSON.stringify({ hiboutik_store_id: 42 }) }]);
      if (method === 'put') { patched += 1; return read({}); }
      return read({});
    });
    const id = await ensureDataSource(client, {
      label: 'Store',
      type: 'api',
      config: JSON.stringify({ hiboutik_store_id: 42 }),
      stableConfigKey: 'hiboutik_store_id',
    });
    expect(id).toBe(5);
    expect(patched).toBe(0);
  });

  it('E16: creates when no source matches the stable key (falls through to create)', async () => {
    let created = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let createDto: any = null;
    const client = mockClient(({ method, url, body }) => {
      if (method === 'get' && url === 'data-sources')
        return read([{ id_data_source: 5, label: 'Other', type: 'api', config: JSON.stringify({ hiboutik_store_id: 99 }) }]);
      if (method === 'post' && url === 'data-sources') { created += 1; createDto = body; return read({ id_data_source: 7 }); }
      return read({});
    });
    const id = await ensureDataSource(client, {
      label: 'New Store',
      type: 'api',
      config: JSON.stringify({ hiboutik_store_id: 42 }),
      stableConfigKey: 'hiboutik_store_id',
    });
    expect(id).toBe(7);
    expect(created).toBe(1);
    // stableConfigKey is authoring-only metadata: NOT forwarded to the API create DTO.
    expect(createDto).not.toHaveProperty('stableConfigKey');
  });

  it('E16: without stableConfigKey, behaviour is unchanged (label-only match)', async () => {
    let created = 0;
    const client = mockClient(({ method, url }) => {
      if (method === 'get' && url === 'data-sources')
        return read([{ id_data_source: 5, label: 'Store', type: 'api', config: JSON.stringify({ hiboutik_store_id: 42 }) }]);
      if (method === 'post' && url === 'data-sources') { created += 1; return read({ id_data_source: 8 }); }
      return read({});
    });
    // Same config key but a NEW label and no stableConfigKey -> a new source is created.
    const id = await ensureDataSource(client, {
      label: 'Renamed',
      type: 'api',
      config: JSON.stringify({ hiboutik_store_id: 42 }),
    });
    expect(id).toBe(8);
    expect(created).toBe(1);
  });
});

describe('ensureEvent', () => {
  it('succeeds when the API returns ok (event created)', async () => {
    let posted = 0;
    const client = mockClient(({ method, url }) => {
      if (method === 'post' && url === 'events') { posted += 1; return read({ id_event: 1 }); }
      return read({});
    });
    await expect(ensureEvent(client, { code_name: 'pos_sale', name: { en: 'POS sale' } })).resolves.toBeUndefined();
    expect(posted).toBe(1);
  });

  it('tolerates a 409 (event already exists / idempotent)', async () => {
    const client = mockClient(({ method, url }) => {
      if (method === 'post' && url === 'events') return { status: 409, body: { message: 'already exists' } };
      return read({});
    });
    await expect(ensureEvent(client, { code_name: 'pos_sale', name: { en: 'POS sale' } })).resolves.toBeUndefined();
  });

  it('throws on any other error (e.g. 500)', async () => {
    const client = mockClient(({ method, url }) => {
      if (method === 'post' && url === 'events') return { status: 500, body: { message: 'boom' } };
      return read({});
    });
    await expect(ensureEvent(client, { code_name: 'pos_sale', name: { en: 'POS sale' } })).rejects.toThrow();
  });
});
