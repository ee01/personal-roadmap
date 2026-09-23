import { describe, expect, it } from 'vitest';

import {
  AGENT_CREATE_CONCURRENCY,
  runWithConcurrency,
} from '../composables/runWithConcurrency';

describe('runWithConcurrency', () => {
  it('keeps Agent create at two in-flight Epics', () => {
    expect(AGENT_CREATE_CONCURRENCY).toBe(2);
  });

  it('never runs more workers than the cap', async () => {
    const started: number[] = [];
    let inflight = 0;
    let peak = 0;
    const items = [0, 1, 2, 3, 4];
    await runWithConcurrency(items, 2, async (item) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      started.push(item);
      await new Promise((r) => setTimeout(r, 15));
      inflight -= 1;
    });
    expect(peak).toBe(2);
    expect(started.sort()).toEqual(items);
  });

  it('lets later items run after an earlier worker throws if the caller catches', async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3], 2, async (item) => {
      try {
        if (item === 1) throw new Error('epic failed');
        seen.push(item);
      } catch {
        seen.push(-item);
      }
    });
    expect(seen.sort((a, b) => a - b)).toEqual([-1, 2, 3]);
  });
});
