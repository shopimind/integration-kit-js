import { describe, it, expect } from 'vitest';
import { defineIntegration, validateProvisioningEvents } from './define-integration.js';
import type { Integration, SyncStep } from './types.js';

type S = { x: boolean };

const makeIntegration = (over: Partial<Integration<S>>): Integration<S> => ({
  slug: 'demo',
  meta: { name: 'Demo', version: '1.0.0' },
  configSchema: {},
  parseSettings: () => ({ x: true }),
  testConnection: async () => true,
  syncSteps: [],
  ...over,
});

const step = (entity: string, scope: 'global' | 'per-source'): SyncStep<S> => ({
  entity,
  cursorScope: scope,
  enabled: () => true,
  run: async () => ({ items: 0, errors: [] }),
});

describe('defineIntegration', () => {
  it('accepts a valid integration', () => {
    expect(() => defineIntegration(makeIntegration({}))).not.toThrow();
  });

  it('rejects an invalid slug', () => {
    expect(() => defineIntegration(makeIntegration({ slug: 'Bad Slug' }))).toThrowError(/slug/);
  });

  it('rejects duplicate sync entities', () => {
    const s = step('orders', 'global');
    expect(() => defineIntegration(makeIntegration({ syncSteps: [s, s] }))).toThrowError(/duplicate/);
  });

  it('rejects a per-source step without sources()', () => {
    expect(() => defineIntegration(makeIntegration({ syncSteps: [step('orders', 'per-source')] })))
      .toThrowError(/per-source/);
  });

  it('rejects a missing meta.version', () => {
    expect(() => defineIntegration(makeIntegration({ meta: { name: 'Demo', version: '' } })))
      .toThrowError(/version/);
  });

  it('rejects a malformed meta.version (not x.y.z)', () => {
    expect(() => defineIntegration(makeIntegration({ meta: { name: 'Demo', version: '1.0' } })))
      .toThrowError(/version/);
  });

  it('rejects an empty sync step entity', () => {
    expect(() => defineIntegration(makeIntegration({ syncSteps: [step('  ', 'global')] })))
      .toThrowError(/empty entity/);
  });
});

describe('validateProvisioningEvents', () => {
  it('accepts events that all carry a code_name', () => {
    expect(() => validateProvisioningEvents([{ code_name: 'pos_sale' }, { code_name: 'pos_refund' }])).not.toThrow();
  });

  it('rejects an event missing its code_name', () => {
    expect(() => validateProvisioningEvents([{ code_name: '' }])).toThrowError(/code_name/);
    expect(() => validateProvisioningEvents([{}])).toThrowError(/code_name/);
  });
});
