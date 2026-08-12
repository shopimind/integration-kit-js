import { describe, it, expect } from 'vitest';
import { runProvisioning, topoSortCustomData } from './runner.js';
import { validateCustomDataDefinition } from '../integration/define-integration.js';
import { createLogger, type LogLine } from '../logging/logger.js';
import { makeScriptedSpmClient as mockClient, type SpmStubRequest } from '../testing/harness.js';
import type { ProvisioningPlan } from '../integration/types.js';
import type { NewCustomDataDefinition } from '../contracts/index.js';

const read = (data: unknown) => ({ body: { statusCode: 200, data } });

const plan: ProvisioningPlan = {
  dataSources: [{ key: 'parent', decl: { label: 'Hiboutik POS', type: 'api' } }],
  customData: [{ name: 'pos_profile', fields: [{ name: 'id_customer', type: 'text' }] }],
  events: [{ code_name: 'pos_tier', name: { fr: 'Palier' } }],
  orderStatuses: [
    { status_id: 'completed', lang: 'fr', name: 'OK', is_deleted: false, created_at: 'x', updated_at: 'x' },
  ],
};

/** "All ok" handler: empty reads, creates return ids, bulk order-statuses returns 6 sent. */
function okHandler({ method, url }: SpmStubRequest) {
  if (method === 'get' && url === 'data-sources') return read([]);
  if (method === 'post' && url === 'data-sources') return read({ id_data_source: 10 });
  if (method === 'get' && url === 'custom-data-definitions') return read([]);
  if (method === 'post' && url === 'custom-data-definitions') return read({ id_definition: 20 });
  if (method === 'patch' && /custom-data-definitions\/\d+\/activate$/.test(url)) return read({});
  if (method === 'post' && url === 'events') return read({});
  // bulk: counts at the top level (read by extractCounts/mergeResponses).
  if (method === 'post' && url === 'orders-statuses') {
    return { body: { sent_count: 6, rejected_count: 0, failed_count: 0, rejected_items: [] } };
  }
  return read({});
}

describe('runProvisioning', () => {
  it('ensures sources / defs / events / order statuses', async () => {
    const r = await runProvisioning(mockClient(okHandler), plan);
    expect(r.sourceIds.parent).toBe(10);
    expect(r.defIds.pos_profile).toBe(20);
    expect(r.events).toBe(1);
    expect(r.orderStatuses).toBe(6);
    expect(r.errors).toEqual([]);
  });

  it('collects errors without interrupting the following resources', async () => {
    const r = await runProvisioning(
      mockClient((req) => {
        if (req.method === 'post' && req.url === 'data-sources') return { status: 500, body: { message: 'boom' } };
        return okHandler(req);
      }),
      plan,
    );
    expect(r.errors.some((e) => /HTTP 500|boom/.test(e))).toBe(true);
    expect(r.defIds.pos_profile).toBe(20); // the following resources still succeeded
  });

  it('E11: fills default technical fields on order statuses (is_deleted/created_at/updated_at)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sent: any[] | null = null;
    const client = mockClient((req) => {
      if (req.method === 'post' && req.url === 'orders-statuses') {
        sent = req.body;
        return { body: { sent_count: 1, rejected_count: 0, failed_count: 0, rejected_items: [] } };
      }
      return okHandler(req);
    });
    const r = await runProvisioning(client, {
      // Only the authoring essentials — technical fields omitted.
      orderStatuses: [{ status_id: 'done', lang: 'fr', name: 'Terminé' }],
    });
    expect(r.orderStatuses).toBe(1);
    expect(sent?.[0]?.is_deleted).toBe(false);
    expect(typeof sent?.[0]?.created_at).toBe('string');
    expect(typeof sent?.[0]?.updated_at).toBe('string');
  });

  it('ensureEvent tolerates a 409 (idempotent)', async () => {
    const r = await runProvisioning(
      mockClient((req) => {
        if (req.method === 'post' && req.url === 'events') return { status: 409, body: { message: 'exists' } };
        return okHandler(req);
      }),
      plan,
    );
    expect(r.events).toBe(1);
    expect(r.errors).toEqual([]);
  });

  it('resolves a custom->custom relationship target declared by sibling name', async () => {
    const createBodies: Array<Record<string, unknown>> = [];
    const client = mockClient(({ method, url, body }) => {
      if (method === 'get' && url === 'custom-data-definitions') return read([]);
      if (method === 'post' && url === 'custom-data-definitions') {
        createBodies.push(body);
        return read({ id_definition: createBodies.length === 1 ? 30 : 31 });
      }
      if (method === 'patch' && /custom-data-definitions\/\d+\/activate$/.test(url)) return read({});
      return read({});
    });
    const r = await runProvisioning(client, {
      customData: [
        { name: 'stores', fields: [{ name: 'store_ref', type: 'text' }] },
        {
          name: 'contact_store',
          fields: [{ name: 'store', type: 'number' }],
          relationships: [
            { sourceField: 'store', targetSchemaType: 'custom', targetSchema: 'stores', targetField: 'store_ref' },
          ],
        },
      ],
    });
    expect(r.defIds).toEqual({ stores: 30, contact_store: 31 });
    // the 2nd create payload references the RESOLVED id '30', not the name 'stores'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((createBodies[1] as any).relationships[0].targetSchema).toBe('30');
  });

  it('E10: resolves a custom->custom target even when declared AFTER the referencer (topo sort)', async () => {
    const createdOrder: string[] = [];
    const client = mockClient(({ method, url, body }) => {
      if (method === 'get' && url === 'custom-data-definitions') return read([]);
      if (method === 'post' && url === 'custom-data-definitions') {
        createdOrder.push(String((body as { name: string }).name));
        return read({ id_definition: createdOrder.length === 1 ? 40 : 41 });
      }
      if (method === 'patch' && /custom-data-definitions\/\d+\/activate$/.test(url)) return read({});
      return read({});
    });
    // Declared "wrong" order: contact_store BEFORE its target stores. The topo sort
    // must create stores first so the relationship id resolves.
    const r = await runProvisioning(client, {
      customData: [
        {
          name: 'contact_store',
          fields: [{ name: 'store', type: 'number' }],
          relationships: [{ sourceField: 'store', targetSchemaType: 'custom', targetSchema: 'stores' }],
        },
        { name: 'stores', fields: [{ name: 'store_ref', type: 'text' }] },
      ],
    });
    expect(createdOrder[0]).toBe('stores'); // dependency created first
    expect(r.defIds).toEqual({ stores: 40, contact_store: 41 });
    expect(r.errors).toEqual([]);
  });

  it('surfaces the API business message in the collected errors (diagnosability)', async () => {
    const r = await runProvisioning(
      mockClient((req) => {
        if (req.method === 'get' && req.url === 'custom-data-definitions')
          return read([{ id_definition: 1, name: 'pos_profile', status: 'active' }]);
        if (req.method === 'get' && req.url === 'custom-data-definitions/1')
          return { status: 400, body: { statusCode: 400, message: 'Custom data definition not found' } };
        return okHandler(req);
      }),
      plan,
    );
    expect(r.defIds.pos_profile).toBeUndefined(); // the key is never written on failure
    expect(r.errors.some((e) => e.startsWith('def pos_profile:'))).toBe(true);
    // Without this, the operator only ever saw "Request failed with status code 400".
    expect(r.errors.some((e) => e.includes('Custom data definition not found'))).toBe(true);
    expect(r.events).toBe(1); // best-effort: the other resources still went through
  });

  it('joins a validation message array into the collected error', async () => {
    const r = await runProvisioning(
      mockClient((req) => {
        if (req.method === 'post' && req.url === 'data-sources')
          return { status: 400, body: { statusCode: 400, message: ['label must be a string', 'type is invalid'] } };
        return okHandler(req);
      }),
      plan,
    );
    expect(r.errors.some((e) => e.includes('label must be a string; type is invalid'))).toBe(true);
  });

  it('collects a stale custom relationship WITHOUT dropping the definition id', async () => {
    const r = await runProvisioning(
      mockClient((req) => {
        if (req.method === 'get' && req.url === 'custom-data-definitions')
          return read([
            { id_definition: 40, name: 'stores', status: 'active' },
            { id_definition: 41, name: 'contact_store', status: 'active' },
          ]);
        if (req.method === 'get' && req.url === 'custom-data-definitions/40')
          return read({ id_definition: 40, name: 'stores', fields: [{ name: 'store_ref' }] });
        if (req.method === 'get' && req.url === 'custom-data-definitions/41')
          return read({
            id_definition: 41,
            name: 'contact_store',
            fields: [{ name: 'store' }],
            // Stale: points at a definition that was deleted and re-created as 40.
            relationships: [{ sourceField: 'store', targetSchema: '7' }],
          });
        return okHandler(req);
      }),
      {
        customData: [
          {
            name: 'contact_store',
            fields: [{ name: 'store', type: 'number' }],
            relationships: [{ sourceField: 'store', targetSchemaType: 'custom', targetSchema: 'stores' }],
          },
          { name: 'stores', fields: [{ name: 'store_ref', type: 'text' }] },
        ],
      },
    );
    // The definition stays usable -> its id IS resolved (the install must not hard-fail)...
    expect(r.defIds).toEqual({ stores: 40, contact_store: 41 });
    // ...but the broken link is reported instead of converging silently.
    expect(r.errors.some((e) => /^def contact_store: relationship 'store' still points at definition 7/.test(e))).toBe(true);
  });
});

describe('topoSortCustomData', () => {
  it('orders dependencies before dependents', () => {
    const defs: NewCustomDataDefinition[] = [
      {
        name: 'b',
        fields: [{ name: 'a_ref', type: 'number' }],
        relationships: [{ sourceField: 'a_ref', targetSchemaType: 'custom', targetSchema: 'a' }],
      },
      { name: 'a', fields: [{ name: 'x', type: 'text' }] },
    ];
    expect(topoSortCustomData(defs).map((d) => d.name)).toEqual(['a', 'b']);
  });

  it('keeps declaration order for independent definitions (stable)', () => {
    const defs: NewCustomDataDefinition[] = [
      { name: 'one', fields: [{ name: 'x', type: 'text' }] },
      { name: 'two', fields: [{ name: 'y', type: 'text' }] },
    ];
    expect(topoSortCustomData(defs).map((d) => d.name)).toEqual(['one', 'two']);
  });

  it('throws on a dependency cycle', () => {
    const defs: NewCustomDataDefinition[] = [
      {
        name: 'a',
        fields: [{ name: 'b_ref', type: 'number' }],
        relationships: [{ sourceField: 'b_ref', targetSchemaType: 'custom', targetSchema: 'b' }],
      },
      {
        name: 'b',
        fields: [{ name: 'a_ref', type: 'number' }],
        relationships: [{ sourceField: 'a_ref', targetSchemaType: 'custom', targetSchema: 'a' }],
      },
    ];
    expect(() => topoSortCustomData(defs)).toThrowError(/cycle/);
  });
});

describe('validateCustomDataDefinition guards', () => {
  it('rejects unique_keys not present in fields', () => {
    expect(() =>
      validateCustomDataDefinition({ name: 'd', fields: [{ name: 'a' }], unique_keys: ['b'] }),
    ).toThrowError(/unique_keys.*'b'/);
  });

  it('rejects a relationship sourceField not present in fields', () => {
    expect(() =>
      validateCustomDataDefinition({
        name: 'd',
        fields: [{ name: 'a' }],
        relationships: [{ sourceField: 'ghost' }],
      }),
    ).toThrowError(/sourceField 'ghost'/);
  });

  it('accepts a well-formed definition', () => {
    expect(() =>
      validateCustomDataDefinition({
        name: 'd',
        fields: [{ name: 'a' }, { name: 'b' }],
        unique_keys: ['a'],
        relationships: [{ sourceField: 'b' }],
      }),
    ).not.toThrow();
  });

  it('surfaces a guard failure via runProvisioning errors (does not abort other defs)', async () => {
    const r = await runProvisioning(mockClient(okHandler), {
      customData: [{ name: 'bad', fields: [{ name: 'a', type: 'text' }], unique_keys: ['missing'] }],
    });
    expect(r.errors.some((e) => /unique_keys.*missing/.test(e))).toBe(true);
    expect(r.defIds.bad).toBeUndefined();
  });

  it('warns on an out-of-plan non-numeric custom target (left unresolved)', async () => {
    const lines: LogLine[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l) });
    await runProvisioning(
      mockClient(({ method, url }) => {
        if (method === 'get' && url === 'custom-data-definitions') return read([]);
        if (method === 'post' && url === 'custom-data-definitions') return read({ id_definition: 50 });
        if (method === 'patch' && /custom-data-definitions\/\d+\/activate$/.test(url)) return read({});
        return read({});
      }),
      {
        customData: [
          {
            name: 'lonely',
            fields: [{ name: 'ext', type: 'number' }],
            relationships: [{ sourceField: 'ext', targetSchemaType: 'custom', targetSchema: 'not_in_plan' }],
          },
        ],
      },
      logger,
    );
    expect(lines.find((l) => l.level === 'warn' && l.message.includes('not_in_plan'))).toBeDefined();
  });
});
