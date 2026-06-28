/**
 * BOUNDED-concurrency map (avoids 429s). At most `limit` promises in flight at a
 * time, with result order preserved - avoids bursts of calls that trigger a 429
 * on the third-party API side.
 *
 * IMPORTANT — this MATERIALIZES the input iterable eagerly (`[...items]`) and
 * returns a fully-buffered result array. Unlike `paginate`/`streamPages`, it is
 * NOT streaming: both the input and the output are held in memory at once. Do not
 * pass a huge lazy stream (e.g. a long backfill) to it — page it with `paginate`
 * first and map each bounded batch instead.
 */
export async function mapWithConcurrency<I, O>(
  items: Iterable<I>,
  limit: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('concurrency limit must be an integer >= 1');
  }
  const all = [...items];
  const results = new Array<O>(all.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= all.length) return;
      results[index] = await fn(all[index] as I, index);
    }
  };

  const workerCount = Math.min(limit, all.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
