/** Small helpers for bounded background work: chunks, bounded parallelism, deadlines, keyset loops. */

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Map with at most `limit` calls in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** A point in time after which background work should stop starting new steps. 0/undefined = never. */
export function deadlineIn(ms: number | undefined, now = Date.now()): number {
  return ms && ms > 0 ? now + ms : Infinity;
}
export const expired = (deadline: number, now = Date.now()) => now >= deadline;

/**
 * Keyset loop: `fetch(cursor)` returns up to `size` rows after the cursor, `handle` processes them,
 * the loop continues while batches are full and the deadline has not passed. Returns whether it ran
 * to the end (`complete`) and the cursor to resume from.
 */
export async function keysetLoop<Row, Cursor>(opts: {
  size: number;
  deadline?: number;
  start: Cursor | null;
  fetch(cursor: Cursor | null, size: number): Promise<Row[]>;
  cursorOf(row: Row): Cursor;
  handle(rows: Row[]): Promise<void>;
}): Promise<{ batches: number; rows: number; complete: boolean; cursor: Cursor | null }> {
  let cursor = opts.start;
  let batches = 0;
  let rows = 0;
  const deadline = opts.deadline ?? Infinity;
  for (;;) {
    // a budgeted call always makes one batch of progress: a budget that is already spent when the loop starts (a
    // slow machine, a long first fetch elsewhere) must not leave the cursor where it was forever
    if (batches > 0 && expired(deadline)) return { batches, rows, complete: false, cursor };
    const page = await opts.fetch(cursor, opts.size);
    if (!page.length) return { batches, rows, complete: true, cursor };
    await opts.handle(page);
    batches++;
    rows += page.length;
    cursor = opts.cursorOf(page[page.length - 1]!);
    if (page.length < opts.size) return { batches, rows, complete: true, cursor };
  }
}
