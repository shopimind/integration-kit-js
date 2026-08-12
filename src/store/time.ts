/**
 * Store timestamps, generated in JS (never by the database engine).
 *
 * Every adapter persists timestamps as TEXT in the SAME format — ISO-8601 UTC
 * with a `Z` suffix (`new Date().toISOString()`), lexicographically sortable —
 * so behaviour is identical across backends and no SQL dialect function
 * (`datetime('now')`, `now()`, `interval`) is ever needed. Retention cutoffs are
 * computed here too and passed as plain parameters.
 *
 * Legacy note: rows written by kit v1 (SQLite `datetime('now')`) hold
 * `YYYY-MM-DD HH:MM:SS` — UTC, but without the `T` separator, `Z` suffix or
 * milliseconds. `parseStoreTimestamp` accepts both formats; comparisons against
 * cutoffs stay correct because the date part sorts identically in both.
 */

/** Clock used by an adapter. Injectable for tests; defaults to the real clock. */
export type StoreClock = () => Date;

export const realClock: StoreClock = () => new Date();

/** Current instant in the canonical store format (ISO-8601 UTC, `Z` suffix). */
export const nowIso = (clock: StoreClock = realClock): string => clock().toISOString();

/** Cutoff `days` days in the past, canonical format (for retention purges). */
export const isoDaysAgo = (days: number, clock: StoreClock = realClock): string =>
  new Date(clock().getTime() - days * 86_400_000).toISOString();

/** Cutoff `hours` hours in the past, canonical format (for dashboard windows). */
export const isoHoursAgo = (hours: number, clock: StoreClock = realClock): string =>
  new Date(clock().getTime() - hours * 3_600_000).toISOString();

const LEGACY_SQLITE_FORMAT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Parses a store timestamp into epoch milliseconds. Accepts the canonical
 * ISO-8601 `Z` format AND the legacy kit-v1 SQLite format (`YYYY-MM-DD HH:MM:SS`,
 * implicitly UTC). Returns `NaN` for unparseable input (mirrors `Date.parse`).
 */
export function parseStoreTimestamp(value: string): number {
  if (LEGACY_SQLITE_FORMAT.test(value)) {
    return Date.parse(value.replace(' ', 'T') + 'Z');
  }
  return Date.parse(value);
}
