import { describe, it, expect } from 'vitest';
import { createPostgresStore } from './index.js';

/**
 * SCHEMA OWNERSHIP — a PostgreSQL database is shared by nature and the default
 * schema name is the same for every integration. Without a claim, a second
 * integration deployed without an explicit `schema` would quietly write its
 * installations, cursors and secrets into the first one's tables. Booting must
 * fail instead. Skipped without TEST_POSTGRES_URL (see postgres.conformance.test.ts).
 */
const url = process.env.TEST_POSTGRES_URL;

(url ? describe : describe.skip)('postgres schema ownership', () => {
  const schema = (): string => `kit_own_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  it('claims the schema for the first integration and rejects a different one', async () => {
    const s = schema();
    const first = await createPostgresStore({ connectionString: url as string, schema: s });
    try {
      await first.migrate('hiboutik');
      await first.migrate('hiboutik'); // same owner, still idempotent

      const second = await createPostgresStore({ connectionString: url as string, schema: s });
      try {
        await expect(second.migrate('enkore')).rejects.toThrow(/already belongs to the integration 'hiboutik'/);
        // The rejected integration must not have written anything either.
        await expect(second.migrate('enkore')).rejects.toThrow(/enkore/);
      } finally {
        await second.close();
      }
    } finally {
      await first.pool.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      await first.close();
    }
  });

  it('two integrations coexist in the same database when each has its own schema', async () => {
    const a = schema();
    const b = schema();
    const storeA = await createPostgresStore({ connectionString: url as string, schema: a });
    const storeB = await createPostgresStore({ connectionString: url as string, schema: b });
    try {
      await storeA.migrate('hiboutik');
      await storeB.migrate('enkore');
      await storeA.installs.upsert({ installation_id: 'shared-id', shop_name: 'A', status: 'active' });
      await storeB.installs.upsert({ installation_id: 'shared-id', shop_name: 'B', status: 'active' });
      // Same installation id on both sides, no cross-talk.
      expect((await storeA.installs.find('shared-id'))?.shop_name).toBe('A');
      expect((await storeB.installs.find('shared-id'))?.shop_name).toBe('B');
    } finally {
      await storeA.pool.query(`DROP SCHEMA IF EXISTS "${a}" CASCADE`);
      await storeB.pool.query(`DROP SCHEMA IF EXISTS "${b}" CASCADE`);
      await storeA.close();
      await storeB.close();
    }
  });

  it('migrate() without an owner still works (conformance suite, tooling)', async () => {
    const s = schema();
    const store = await createPostgresStore({ connectionString: url as string, schema: s });
    try {
      await store.migrate();
      await store.installs.upsert({ installation_id: 'i', status: 'active' });
      expect((await store.installs.find('i'))?.status).toBe('active');
      // An unclaimed schema can still be claimed afterwards by the first integration to boot.
      await store.migrate('hiboutik');
    } finally {
      await store.pool.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      await store.close();
    }
  });

  it('rejects an invalid schema name instead of interpolating it', async () => {
    await expect(
      createPostgresStore({ connectionString: url as string, schema: 'public"; DROP TABLE x; --' }),
    ).rejects.toThrow(/invalid schema name/);
  });
});
