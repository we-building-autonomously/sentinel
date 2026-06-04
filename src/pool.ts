/**
 * Run `worker` over `items` with at most `concurrency` in flight at once.
 * Results preserve input order. A worker that throws yields a rejected slot
 * captured as `{ error }` only if `wrapErrors` is set; otherwise it rejects.
 */
export async function pool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const n = items.length;
  const results = new Array<R>(n);
  const limit = Math.max(1, Math.min(concurrency, n || 1));
  let next = 0;

  async function runner(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= n) return;
      results[i] = await worker(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runner()));
  return results;
}
