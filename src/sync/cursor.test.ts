import { describe, it, expect } from 'vitest';
import { shouldAdvanceCursor, nextCursorValue } from './cursor.js';

describe('safe cursor (prevents data loss)', () => {
  const at = new Date('2026-06-21T00:00:00.000Z');

  it('advances if there is no error', () => {
    expect(shouldAdvanceCursor({ errors: [], advanceCursorTo: at })).toBe(true);
    expect(nextCursorValue({ errors: [], advanceCursorTo: at })).toBe(at);
  });

  it('DOES NOT advance on a partial run', () => {
    const outcome = { errors: ['store 3 failed'], advanceCursorTo: at };
    expect(shouldAdvanceCursor(outcome)).toBe(false);
    expect(nextCursorValue(outcome)).toBeNull();
  });

  it('does not advance without an advancement bound', () => {
    expect(shouldAdvanceCursor({ errors: [] })).toBe(false);
    expect(nextCursorValue({ errors: [] })).toBeNull();
  });
});
