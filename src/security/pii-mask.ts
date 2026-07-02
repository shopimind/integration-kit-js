/**
 * Masks PII inside a serialized JSON payload before it is shown in the admin UI.
 *
 * Robust to malformed input, never throws:
 *  1. If the string parses as JSON, it is walked (depth/cycle-safe) and values are
 *     masked by KEY name (email/phone/name/address/id…), by VALUE shape (email/phone),
 *     by NUMERIC key hint (a phone/postal/id number is masked even as a JSON number),
 *     and by EMBEDDED PII (an email or an international phone inside free text).
 *  2. If it does NOT parse, the same embedded-PII pass is applied to the raw string.
 *
 * Keys, booleans, dates and non-PII numbers are left untouched. This is a display
 * filter, not a redaction guarantee at rest (the store already redacts secrets/webhook
 * payloads); revealing the raw payload is a separate, audited action.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_RE_G = /[^\s"@]+@[^\s"@]+\.[^\s"@]+/g;
// Mostly digits + phone separators, 7+ digits — but NOT an ISO date/datetime.
const PHONE_RE = /^[+(]?\d[\d\s().-]{5,}\d$/;
// A phone carrying an explicit country code (+…): safe to mask even inside free text
// (a leading '+' is a strong phone signal, so this does not touch bare integers/dates).
const PHONE_INTL_RE_G = /\+\d[\d\s().-]{6,}\d/g;
const ISO_DATE_RE = /^\d{4}-\d\d-\d\d/;
// Boundaries/snake-case anchors on the short tokens on purpose, so a key does not
// over-match a common word (e.g. `pan`->company, `bic`->public, `city`->capacity,
// `_name$` matches customer_name but NOT filename/username).
const PII_KEY_RE =
  /(^name$|first_?name|last_?name|full_?name|given_?name|family_?name|sur_?name|_name$|^nom$|^prenom$|phone|mobile|fax|e_?mail|address|street|\bcity\b|zip|postal|birth|iban|siret|ssn|national_?id|passport)/i;
// Numeric values are masked ONLY when the key strongly implies a phone/postal/id number,
// so legitimate numbers (order ids, counts, timestamps) are never mangled.
const NUMERIC_PII_KEY_RE = /(phone|mobile|fax|zip|postal|siret|ssn|national_?id)/i;
const PHONE_KEY_RE = /(phone|mobile|fax)/i;
const MAX_DEPTH = 12;

function maskEmail(v: string): string {
  const at = v.indexOf('@');
  if (at <= 0) return '•••';
  const dot = v.lastIndexOf('.');
  const tld = dot > at ? v.slice(dot) : '';
  return `${v[0]}•••@•••${tld}`;
}
function maskPhone(v: string): string {
  return `•••••${v.replace(/\D/g, '').slice(-2)}`;
}
function maskName(v: string): string {
  return v.length <= 1 ? '•' : `${v[0]}•••`;
}

/** Masks a value purely by its SHAPE (whole-string email or phone), or null if neither. */
function maskByShape(v: string): string | null {
  if (EMAIL_RE.test(v)) return maskEmail(v);
  if (!ISO_DATE_RE.test(v) && PHONE_RE.test(v) && v.replace(/\D/g, '').length >= 7) return maskPhone(v);
  return null;
}

/** Masks emails (and +country-code phones) EMBEDDED inside a larger free-text string. */
function maskEmbedded(v: string): string {
  return v.replace(EMAIL_RE_G, (m) => maskEmail(m)).replace(PHONE_INTL_RE_G, (m) => maskPhone(m));
}

function walk(node: unknown, keyHint: string | null, seen: WeakSet<object>, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (typeof node === 'string') {
    const byShape = maskByShape(node);
    if (byShape !== null) return byShape;
    if (keyHint && PII_KEY_RE.test(keyHint)) {
      if (/e_?mail/i.test(keyHint)) return maskEmail(node);
      if (PHONE_KEY_RE.test(keyHint)) return maskPhone(node);
      return maskName(node);
    }
    // Neither the whole value nor its key is PII: still mask PII embedded in free text.
    return maskEmbedded(node);
  }
  // A number under a phone/postal/id key IS PII (`{"phone":33612345678}` must not leak).
  if (typeof node === 'number' && keyHint && NUMERIC_PII_KEY_RE.test(keyHint)) {
    return PHONE_KEY_RE.test(keyHint) ? maskPhone(String(node)) : '•••';
  }
  if (node === null || typeof node !== 'object') return node;
  if (seen.has(node)) return '[circular]';
  seen.add(node);
  if (Array.isArray(node)) return node.map((v) => walk(v, keyHint, seen, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    out[k] = walk(v, k, seen, depth + 1);
  }
  return out;
}

/** Returns a PII-masked copy of a serialized JSON string. Never throws. */
export function maskPiiJson(json: string | null | undefined): string {
  if (!json) return json ?? '';
  try {
    return JSON.stringify(walk(JSON.parse(json), null, new WeakSet(), 0));
  } catch {
    return maskEmbedded(json);
  }
}
