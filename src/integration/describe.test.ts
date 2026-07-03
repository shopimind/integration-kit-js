import { describe, it, expect } from 'vitest';
import { describeIntegration } from './describe.js';
import { defineIntegration } from './define-integration.js';

describe('describeIntegration', () => {
  it('extracts a serializable descriptor (declarations only, no function bodies)', () => {
    const i = defineIntegration({
      slug: 'demo',
      meta: { name: 'Demo POS', version: '2.1.0', categories: ['pos'], documentation_url: 'https://x.example' },
      configSchema: { fields: [{ key: 'api_key', type: 'password', sensitive: true, required: true, label: { fr: 'Clé' } }] },
      parseSettings: () => ({}),
      testConnection: async () => true,
      provisioning: () => ({ dataSources: [] }),
      remoteData: { stores: async () => [] },
      syncSteps: [
        { entity: 'orders', cursorScope: 'global', enabled: () => true, run: async () => ({ items: 0, errors: [] }) },
        { entity: 'customers', cursorScope: 'global', tolerateRejects: { maxRatio: 0.5 }, enabled: () => true, run: async () => ({ items: 0, errors: [] }) },
      ],
      inbound: { push: async () => {} },
      hooks: { onActivate: async () => {} },
    });
    const d = describeIntegration(i);

    expect(d.slug).toBe('demo');
    expect(d.meta).toMatchObject({ name: 'Demo POS', version: '2.1.0', categories: ['pos'], documentation_url: 'https://x.example', requires_external_auth: false });
    expect(d.syncSteps).toEqual([
      { entity: 'orders', cursorScope: 'global', guarded: true, tolerateRejects: null },
      { entity: 'customers', cursorScope: 'global', guarded: true, tolerateRejects: { maxRatio: 0.5 } },
    ]);
    expect(d.inbound).toEqual(['push']);
    expect(d.hooks).toEqual(['onActivate']);
    expect(d.remoteData).toEqual(['stores']);
    expect(d.capabilities).toEqual({ provisioning: true, testConnection: true, remoteData: true, widgets: false, inbound: true });

    // The whole descriptor is JSON-safe — no function ever survives.
    expect(JSON.stringify(d)).not.toContain('function');
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it('handles a minimal integration (optional parts absent)', () => {
    const i = defineIntegration({
      slug: 'mini',
      meta: { name: 'Mini', version: '1.0.0' },
      configSchema: { fields: [] },
      parseSettings: () => ({}),
      testConnection: async () => true,
      syncSteps: [],
    });
    const d = describeIntegration(i);
    expect(d.syncSteps).toEqual([]);
    expect(d.inbound).toEqual([]);
    expect(d.hooks).toEqual([]);
    expect(d.remoteData).toEqual([]);
    expect(d.capabilities).toEqual({ provisioning: false, testConnection: true, remoteData: false, widgets: false, inbound: false });
  });
});
