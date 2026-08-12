import type { ConfigSchema, ConfigField, RawConfigs } from '../contracts/index.js';
import type { IntegrationStateRepo } from '../store/repositories.js';

/**
 * Persistence of an installation's configuration. Fields declared `sensitive`
 * are ENCRYPTED at rest (API key, etc.), the others are stored in plaintext.
 * `loadConfigs` reconstructs the raw map for `integration.parseSettings`.
 */

const PLAIN_KEY = 'cfg';
const SECRET_PREFIX = 'cfgsec:';

export function collectFields(schema: ConfigSchema): ConfigField[] {
  const out: ConfigField[] = [];
  if (schema.steps) for (const s of schema.steps) out.push(...s.fields);
  if (schema.fields) out.push(...schema.fields);
  if (schema.groups) for (const g of schema.groups) out.push(...g.fields);
  return out;
}

export function sensitiveKeys(schema: ConfigSchema): string[] {
  return collectFields(schema)
    .filter((f) => f.sensitive === true)
    .map((f) => f.key);
}

export async function saveConfigs(
  state: IntegrationStateRepo,
  id: string,
  schema: ConfigSchema,
  configs: RawConfigs,
): Promise<void> {
  const secret = new Set(sensitiveKeys(schema));
  const plain: RawConfigs = {};
  for (const [k, v] of Object.entries(configs)) {
    if (secret.has(k)) {
      if (v != null && v !== '') await state.setSecret(id, SECRET_PREFIX + k, String(v));
      else await state.delete(id, SECRET_PREFIX + k); // empty value -> actually erase the secret
    } else {
      plain[k] = v;
    }
  }
  // Also erase secrets whose key is no longer present in the payload
  // (otherwise an old secret would survive indefinitely and be re-injected on load).
  for (const k of secret) {
    if (!(k in configs)) await state.delete(id, SECRET_PREFIX + k);
  }
  await state.set(id, PLAIN_KEY, JSON.stringify(plain));
}

export async function loadConfigs(state: IntegrationStateRepo, id: string, schema: ConfigSchema): Promise<RawConfigs> {
  const raw = await state.get(id, PLAIN_KEY);
  const plain: RawConfigs = raw ? (JSON.parse(raw) as RawConfigs) : {};
  for (const k of sensitiveKeys(schema)) {
    const v = await state.get(id, SECRET_PREFIX + k);
    if (v != null) plain[k] = v;
  }
  return plain;
}
