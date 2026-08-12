import { describe, it, expect } from 'vitest';
import { createSqliteStore } from './index.js';
import { runStoreConformanceSuite } from '../../testing/store-conformance.js';

// The SQLite adapter (the kit's default backend) must satisfy the full port
// contract. Every store backend runs this same suite — see store-conformance.ts.
runStoreConformanceSuite(() => createSqliteStore({ path: ':memory:' }), { describe, it, expect });
