import { describe, it, expect } from 'vitest';
import { ensureCustomDataDefinition, ensureDataSource, ensureEvent } from './ensure.js';
import { makeScriptedSpmClient as mockClient } from '../testing/harness.js';

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
