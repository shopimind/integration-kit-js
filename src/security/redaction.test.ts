import { describe, it, expect } from 'vitest';
import { redact, isSensitiveKey } from './redaction.js';

describe('redact', () => {
  it('masks sensitive keys and keeps the rest', () => {
    const input = {
      event: 'integration.activated',
      id_shop_integration: 42,
      configs: { hiboutik_api_key: 'SECRET', hiboutik_account: 'demo', access_token: 'tok' },
      nested: [{ password: 'p' }, { ok: 1 }],
    };
    const out = redact(input);
    expect(out.configs.hiboutik_api_key).toBe('[redacted]');
    expect(out.configs.access_token).toBe('[redacted]');
    expect(out.configs.hiboutik_account).toBe('demo');
    expect(out.id_shop_integration).toBe(42);
    expect(out.nested[0]?.password).toBe('[redacted]');
    expect(out.nested[1]?.ok).toBe(1);
  });

  it('does not mutate the original', () => {
    const input = { api_key: 'x' };
    redact(input);
    expect(input.api_key).toBe('x');
  });

  it('does not blow up on a self-referential object', () => {
    const input: Record<string, unknown> = { event: 'x', api_key: 'SECRET' };
    input.self = input;
    let out: Record<string, unknown> = {};
    expect(() => {
      out = redact(input) as Record<string, unknown>;
    }).not.toThrow();
    expect(out.event).toBe('x');
    expect(out.api_key).toBe('[redacted]');
    expect(out.self).toBe('[Circular]');
  });

  it('isSensitiveKey', () => {
    expect(isSensitiveKey('hiboutik_api_key')).toBe(true);
    expect(isSensitiveKey('access_token')).toBe(true);
    expect(isSensitiveKey('store_ids')).toBe(false);
  });
});
