import { describe, it, expect } from 'vitest';
import { maskPiiJson } from './pii-mask.js';

const parse = (s: string): Record<string, unknown> => JSON.parse(s) as Record<string, unknown>;

describe('maskPiiJson', () => {
  it('masks emails by VALUE shape under any key', () => {
    const out = parse(maskPiiJson('{"contact":"john.doe@example.fr"}'));
    expect(out.contact).toBe('j•••@•••.fr');
    expect(String(out.contact)).not.toContain('john.doe');
  });

  it('masks values by KEY name (email / phone / name / address)', () => {
    const out = parse(
      maskPiiJson(
        JSON.stringify({
          email: 'a.customer@shop.com',
          phone: '+33 6 12 34 56 78',
          first_name: 'Jonathan',
          last_name: 'Doe',
          address: '221B Baker Street',
        }),
      ),
    );
    expect(out.email).toBe('a•••@•••.com');
    expect(out.phone).toBe('•••••78');
    expect(out.first_name).toBe('J•••');
    expect(out.last_name).toBe('D•••');
    expect(out.address).toBe('2•••');
  });

  it('does NOT mask an ISO date that superficially looks like a phone number', () => {
    const out = parse(maskPiiJson('{"created_at":"2024-01-15","updated_at":"2024-01-15T10:20:30Z"}'));
    expect(out.created_at).toBe('2024-01-15');
    expect(out.updated_at).toBe('2024-01-15T10:20:30Z');
  });

  it('leaves numbers, booleans and non-PII strings untouched', () => {
    const out = parse(maskPiiJson('{"id":42,"active":true,"status":"paid","label":"Order #7"}'));
    expect(out.id).toBe(42);
    expect(out.active).toBe(true);
    expect(out.status).toBe('paid');
    expect(out.label).toBe('Order #7');
  });

  it('recurses into nested objects and arrays', () => {
    const out = parse(
      maskPiiJson(JSON.stringify({ customer: { email: 'nested@x.io' }, contacts: [{ email: 'a@b.co' }, { email: 'c@d.co' }] })),
    );
    expect((out.customer as Record<string, unknown>).email).toBe('n•••@•••.io');
    const contacts = out.contacts as Array<Record<string, unknown>>;
    expect(contacts[0]?.email).toBe('a•••@•••.co');
    expect(contacts[1]?.email).toBe('c•••@•••.co');
  });

  it('falls back to an email regex when the input is NOT valid JSON', () => {
    const out = maskPiiJson('raw log line from john@corp.com at 10:00');
    expect(out).toContain('j•••@•••.com');
    expect(out).not.toContain('john@corp.com');
  });

  it('is depth-safe on pathological nesting (never throws, truncates)', () => {
    let deep = '{"leaf":"deep@x.io"}';
    for (let i = 0; i < 30; i++) deep = `{"n":${deep}}`;
    expect(() => maskPiiJson(deep)).not.toThrow();
  });

  it('handles null / empty input without throwing', () => {
    expect(maskPiiJson(null)).toBe('');
    expect(maskPiiJson(undefined)).toBe('');
    expect(maskPiiJson('')).toBe('');
  });
});

describe('maskPiiJson — hardening (review findings)', () => {
  it('masks a phone given as a JSON NUMBER under a phone key', () => {
    const out = parse(maskPiiJson('{"phone":33612345678,"customer_phone":5551234567}'));
    expect(out.phone).toBe('•••••78');
    expect(out.customer_phone).toBe('•••••67');
  });

  it('masks a numeric postal/id under a hinting key, but leaves plain numbers alone', () => {
    const out = parse(maskPiiJson('{"zip":75001,"siret":12345678901234,"id":42,"count":1000}'));
    expect(out.zip).toBe('•••');
    expect(out.siret).toBe('•••');
    expect(out.id).toBe(42); // non-PII number untouched
    expect(out.count).toBe(1000);
  });

  it('covers extended PII key variants (given/family name, iban) without over-matching common words', () => {
    const out = parse(
      maskPiiJson('{"given_name":"Alice","family_name":"Martin","iban":"FR7630006000011234567890189","company":"Acme","capacity":50}'),
    );
    expect(out.given_name).toBe('A•••');
    expect(out.family_name).toBe('M•••');
    expect(out.iban).toBe('F•••');
    expect(out.company).toBe('Acme'); // 'pan' must NOT match 'company'
    expect(out.capacity).toBe(50); // 'city' must NOT match 'capacity'
  });

  it('masks an email embedded in a free-text value under a non-PII key', () => {
    const out = parse(maskPiiJson('{"note":"please contact alice@corp.com today"}'));
    expect(out.note).toContain('a•••@•••.com');
    expect(out.note).not.toContain('alice@corp.com');
  });

  it('masks an international phone embedded in free text, and in the malformed-JSON fallback', () => {
    const out = parse(maskPiiJson('{"note":"call +33 6 12 34 56 78 now"}'));
    expect(out.note).toContain('•••••78');
    const fb = maskPiiJson('broken { +33612345678 and a@b.co');
    expect(fb).toContain('•••••78');
    expect(fb).toContain('a•••@•••.co');
  });

  it('is markup-inert: an HTML-looking value is preserved verbatim, never emitted as markup', () => {
    const out = parse(maskPiiJson('{"note":"<script>alert(1)</script>","email":"a@b.co"}'));
    expect(out.note).toBe('<script>alert(1)</script>'); // untouched string, not stripped/executed
    expect(out.email).toBe('a•••@•••.co');
  });
});
