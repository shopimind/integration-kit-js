import { describe, it, expect } from 'vitest';
import { runProvisioning } from './runner.js';
import { makeScriptedSpmClient as mockClient, type SpmStubRequest } from '../testing/harness.js';
import type { ProvisioningPlan } from '../integration/types.js';

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
});
