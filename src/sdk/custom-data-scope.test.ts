import { describe, it, expect } from 'vitest';
import { makeCustomData } from './custom-data-scope.js';
import type { SendBulk } from './send-bulk.js';
import { openDatabase } from '../store/db.js';
import { createRepositories } from '../store/repositories.js';
import { SecretCipher } from '../security/crypto.js';
import { PROVISIONING_KEY } from '../lifecycle/dispatcher.js';

const cipher = new SecretCipher({ key: 'b'.repeat(64) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const spm = {} as any;
const noopSendBulk = (() =>
  Promise.resolve({ sent: 0, rejected: 0, rejected_items: [] })) as unknown as SendBulk;

describe('customData (CustomDataHandle)', () => {
  it('resolves the id of the provisioned definition by name', () => {
    const repos = createRepositories(openDatabase(':memory:'), cipher);
    repos.state.set('inst', PROVISIONING_KEY, JSON.stringify({ defIds: { loyalty_account: 42 } }));
    const customData = makeCustomData(repos.state, 'inst', PROVISIONING_KEY, noopSendBulk, spm);
    expect(customData('loyalty_account').id).toBe(42);
  });

  it('throws if the definition is not provisioned', () => {
    const repos = createRepositories(openDatabase(':memory:'), cipher);
    repos.state.set('inst', PROVISIONING_KEY, JSON.stringify({ defIds: {} }));
    const customData = makeCustomData(repos.state, 'inst', PROVISIONING_KEY, noopSendBulk, spm);
    expect(() => customData('unknown')).toThrow(/not provisioned/);
  });

  it('save() delegates the upsert to sendBulk', async () => {
    const repos = createRepositories(openDatabase(':memory:'), cipher);
    repos.state.set('inst', PROVISIONING_KEY, JSON.stringify({ defIds: { loyalty_account: 42 } }));
    let called = false;
    const recordingSendBulk = ((thunk: () => Promise<unknown>) => {
      called = true;
      void thunk; // don't execute (spm is a stub) — we only assert delegation
      return Promise.resolve({ sent: 1, rejected: 0, rejected_items: [] });
    }) as unknown as SendBulk;
    const customData = makeCustomData(repos.state, 'inst', PROVISIONING_KEY, recordingSendBulk, spm);
    const res = await customData('loyalty_account').save([{ email: 'a@b.c', points_balance: 10 }]);
    expect(called).toBe(true);
    expect(res.sent).toBe(1);
  });
});
