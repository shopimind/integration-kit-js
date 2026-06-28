/**
 * STREAMING pagination (avoids OOM). Iterates page by page without accumulating
 * the whole dataset in memory - safe even for a long backfill over large volumes.
 */

export interface PaginateOptions {
  /** First page (defaults to 1). */
  startPage?: number;
  /** Page size: a shorter page ends the stream. */
  pageSize?: number;
}

/**
 * Hard upper bound on the number of pages a single pagination may walk through.
 * A safety net against an infinite loop when `fetchPage` keeps returning full
 * pages without ever advancing (e.g. a misconfigured backfill that ignores the
 * page argument). 100k pages is far beyond any legitimate sync.
 */
const MAX_PAGES = 100000;

/** Iterates items one by one, page after page, without accumulating the dataset. */
export async function* paginate<T>(
  fetchPage: (page: number) => Promise<T[]>,
  opts: PaginateOptions = {},
): AsyncGenerator<T, void, void> {
  const start = opts.startPage ?? 1;
  for (let page = start; ; page++) {
    if (page - start >= MAX_PAGES) {
      throw new Error('pagination exceeded MAX_PAGES — fetchPage likely not advancing');
    }
    const rows = await fetchPage(page);
    if (!Array.isArray(rows) || rows.length === 0) return;
    for (const row of rows) yield row;
    if (opts.pageSize != null && rows.length < opts.pageSize) return;
  }
}

/** Variant that yields PAGES (useful for pushing in batches). */
export async function* streamPages<T>(
  fetchPage: (page: number) => Promise<T[]>,
  opts: PaginateOptions = {},
): AsyncGenerator<T[], void, void> {
  const start = opts.startPage ?? 1;
  for (let page = start; ; page++) {
    if (page - start >= MAX_PAGES) {
      throw new Error('pagination exceeded MAX_PAGES — fetchPage likely not advancing');
    }
    const rows = await fetchPage(page);
    if (!Array.isArray(rows) || rows.length === 0) return;
    yield rows;
    if (opts.pageSize != null && rows.length < opts.pageSize) return;
  }
}
