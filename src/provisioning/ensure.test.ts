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
