import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../src/lib/concurrency';

describe('mapWithConcurrency', () => {
  it('preserves input order in the results', async () => {
    const out = await mapWithConcurrency([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n * 5));
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it('never exceeds the concurrency limit', async () => {
    let running = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 6, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
    });

    expect(peak).toBeLessThanOrEqual(6);
    expect(peak).toBeGreaterThan(1);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 6, async (x) => x)).toEqual([]);
  });

  it('propagates the first rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
