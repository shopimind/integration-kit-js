import { describe, it, expect } from 'vitest';
import { makeWithSource } from './source-scope.js';
import type { SendBulk } from './send-bulk.js';
import { openDatabase } from '../store/db.js';
import { createRepositories } from '../store/repositories.js';
import { SecretCipher } from '../security/crypto.js';
import { PROVISIONING_KEY } from '../lifecycle/dispatcher.js';

const cipher = new SecretCipher({ key: 'a'.repeat(64) });
// Stub sendBulk: not exercised by the tag / throw tests below.
const noopSendBulk = (() =>
  Promise.resolve({ sent: 0, rejected: 0, rejected_items: [] })) as unknown as SendBulk;

describe('withSource (SourceHandle)', () => {
  it('resolves the id of the provisioned source and tags each item', () => {
    const repos = createRepositories(openDatabase(':memory:'), cipher);
    repos.state.set('inst', PROVISIONING_KEY, JSON.stringify({ sourceIds: { store12: 7 } }));
    const withSource = makeWithSource(repos.state, 'inst', PROVISIONING_KEY, noopSendBulk);

    const src = withSource('store12');
    expect(src.id).toBe(7);
    const tagged = src.tag([{ customer_id: 'hib_1' }, { customer_id: 'hib_2' }]);
    expect(tagged.map((i) => i.id_data_source)).toEqual([7, 7]);
  });

  it('throws if the source is not provisioned', () => {
    const repos = createRepositories(openDatabase(':memory:'), cipher);
    repos.state.set('inst', PROVISIONING_KEY, JSON.stringify({ sourceIds: {} }));
    const withSource = makeWithSource(repos.state, 'inst', PROVISIONING_KEY, noopSendBulk);
    expect(() => withSource('unknown')).toThrow(/not provisioned/);
  });

  it('send() tags items with id_data_source then delegates to sendBulk', async () => {
    const repos = createRepositories(openDatabase(':memory:'), cipher);
    repos.state.set('inst', PROVISIONING_KEY, JSON.stringify({ sourceIds: { store12: 7 } }));
    let pushed: unknown[] = [];
    const recordingSendBulk = ((_fn: unknown, items: unknown[]) => {
      pushed = items;
      return Promise.resolve({ sent: items.length, rejected: 0, rejected_items: [] });
    }) as unknown as SendBulk;
    const withSource = makeWithSource(repos.state, 'inst', PROVISIONING_KEY, recordingSendBulk);

    const res = await withSource('store12').send(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (() => Promise.resolve({} as any)) as any,
      [{ customer_id: 'hib_1' }],
    );
    expect(pushed).toEqual([{ customer_id: 'hib_1', id_data_source: 7 }]);
    expect(res.sent).toBe(1);
  });
});
