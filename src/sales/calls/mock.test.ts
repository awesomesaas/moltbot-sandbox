import { describe, it, expect } from 'vitest';
import { MockCallProvider } from './mock';
import type { CallRepRef } from './provider';

const reps: CallRepRef[] = [
  { repId: 'r-henry', name: 'Henry Cole', email: 'henry@example.com' },
  { repId: 'r-ava', name: 'Ava Chen', email: 'ava@example.com' },
];

describe('MockCallProvider', () => {
  it('is deterministic for the same rep + week', async () => {
    const a = await new MockCallProvider().fetchCalls('2026-07-13', reps);
    const b = await new MockCallProvider().fetchCalls('2026-07-13', reps);
    expect(a).toEqual(b);
  });

  it('returns 3–5 calls per rep with valid talk ratios', async () => {
    const calls = await new MockCallProvider().fetchCalls('2026-07-13', reps);
    const henry = calls.filter((c) => c.repId === 'r-henry');
    expect(henry.length).toBeGreaterThanOrEqual(3);
    expect(henry.length).toBeLessThanOrEqual(5);
    for (const c of calls) {
      expect(c.talkRatio).toBeGreaterThan(0);
      expect(c.talkRatio).toBeLessThanOrEqual(1);
      expect(c.durationSec).toBeGreaterThan(0);
      expect(c.transcript).toBeTruthy();
    }
  });

  it('models Henry as talking more than Ava', async () => {
    const calls = await new MockCallProvider().fetchCalls('2026-07-13', reps);
    const avg = (repId: string) => {
      const rs = calls.filter((c) => c.repId === repId).map((c) => c.talkRatio);
      return rs.reduce((a, b) => a + b, 0) / rs.length;
    };
    expect(avg('r-henry')).toBeGreaterThan(0.65);
    expect(avg('r-henry')).toBeGreaterThan(avg('r-ava'));
  });
});
