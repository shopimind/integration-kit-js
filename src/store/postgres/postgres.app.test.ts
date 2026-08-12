import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createPostgresStore } from './index.js';
import { createIntegrationApp } from '../../runtime/create-app.js';
import { defineIntegration } from '../../integration/define-integration.js';
import { createLogger } from '../../logging/logger.js';
import { signShopimindBody } from '../../security/signature.js';
import type { Integration } from '../../integration/types.js';

/**
 * End-to-end smoke on PostgreSQL: a full integration app booted on a PG store
 * (migrations, health probe, signed lifecycle webhook, encrypted state).
 * Complements the conformance suite (port contract) with the runtime wiring.
 * Skipped without TEST_POSTGRES_URL — see postgres.conformance.test.ts.
 */
const url = process.env.TEST_POSTGRES_URL;

type S = { ok: boolean };
const integration: Integration<S> = defineIntegration({
  slug: 'pg-demo',
  meta: { name: 'PG Demo', version: '1.0.0' },
  configSchema: { fields: [{ key: 'api_key', type: 'password', sensitive: true, label: { fr: 'K' } }] },
  parseSettings: () => ({ ok: true }),
  testConnection: async () => true,
  syncSteps: [],
});

(url ? describe : describe.skip)('integration app on PostgreSQL (e2e smoke)', () => {
  it('boots, serves /health (db ok), processes a signed webhook, persists state encrypted', async () => {
    const schema = `kit_app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const store = await createPostgresStore({ connectionString: url as string, schema });
    const secret = 'whsec_pg_demo';
    const now = 1_700_000_000_000;
    const app = await createIntegrationApp(integration, {
      store,
      webhookSecret: secret,
      credentialsKey: randomBytes(32).toString('hex'),
      autoBackfillOnActivate: false,
      autoSync: false,
      now: () => now,
      logger: createLogger({ sink: () => {} }),
    });
    try {
      // Health: the probe pings PostgreSQL through the port.
      const health = await app.server.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(JSON.parse(health.payload).db).toBe('ok');

      // Signed lifecycle webhook -> install persisted in PG, secret config encrypted.
      const ts = Math.floor(now / 1000);
      const body = JSON.stringify({
        event: 'integration.installed',
        installation_id: 'pg-1',
        access_token: 'int_T',
        shop_domain: 'demo.shop',
        configs: { api_key: 'SUPER-SECRET' },
      });
      const res = await app.server.inject({
        method: 'POST',
        url: '/webhook/receive',
        payload: body,
        headers: {
          'content-type': 'application/json',
          'x-shopimind-timestamp': String(ts),
          'x-shopimind-signature': signShopimindBody(body, secret, ts),
        },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).success).toBe(true);

      const install = await app.repos.installs.find('pg-1');
      expect(install?.shop_domain).toBe('demo.shop');
      expect(install?.status).toBe('inactive');

      // The sensitive config value is encrypted AT the facade — verify the raw
      // PG row holds ciphertext, while the facade decrypts it back.
      const raw = await store.state.read('pg-1', 'cfgsec:api_key');
      expect(raw?.encrypted).toBe(true);
      expect(raw?.value).not.toContain('SUPER-SECRET');
      expect(await app.repos.state.get('pg-1', 'cfgsec:api_key')).toBe('SUPER-SECRET');
    } finally {
      await store.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await app.stop(); // closes the store (and its owned pool)
    }
  });
});
