/** Agent create-Jira: one OpenClaw run per Epic, at most this many at once. */
export const AGENT_CREATE_CONCURRENCY = 2;

/**
 * Run `worker` over `items` with a fixed in-flight cap. Items start in order;
 * a later item is not started until a slot frees. Worker errors propagate
 * after in-flight work settles only if the caller does not catch them —
 * AiCreateModal catches per group so one Epic cannot abort siblings.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const cap = Math.max(1, Math.floor(limit) || 1);
  if (!items.length) return;

  let next = 0;
  const workers = Array.from({ length: Math.min(cap, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}
