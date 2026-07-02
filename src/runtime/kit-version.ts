import { createRequire } from 'node:module';

/**
 * The kit's published version, read from its own `package.json` at runtime. Shown
 * in the admin UI / `/admin/meta` so an operator sees which kit build is running.
 * Resolved via `createRequire` (works in both ESM dist and ts test runners);
 * falls back to `'0.0.0'` if the manifest cannot be read for any reason.
 */
export const KIT_VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: string };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
