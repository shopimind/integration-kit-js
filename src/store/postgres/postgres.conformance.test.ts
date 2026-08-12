import { describe, it, expect } from 'vitest';
import { createPostgresStore } from './index.js';
import { runStoreConformanceSuite } from '../../testing/store-conformance.js';

/**
 * PostgreSQL conformance run — needs a real server. Locally:
 *   docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=kit postgres:16
 *   TEST_POSTGRES_URL=postgres://postgres:kit@localhost:5432/postgres yarn test
 * CI provides the service and sets the variable. Without it the suite is
 * SKIPPED (visible in the runner output), never silently green.
 */
const url = process.env.TEST_POSTGRES_URL;

if (!url) {
  describe.skip('postgres store conformance — SKIPPED (set TEST_POSTGRES_URL to run)', () => {
    it('needs a PostgreSQL server', () => {
      expect(true).toBe(true);
    });
  });
} else {
  runStoreConformanceSuite(async () => {
    // One throwaway schema per test for full isolation; dropped on close so the
    // test database does not accumulate leftovers.
    const schema = `kit_conf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const store = await createPostgresStore({ connectionString: url, schema });
    return {
      ...store,
      async close(): Promise<void> {
        await store.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await store.close();
      },
    };
  }, { describe, it, expect });
}
