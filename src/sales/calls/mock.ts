/**
 * Deterministic mock call-analytics provider. Produces believable per-call
 * talk ratios (and a short synthetic transcript for optional AI analysis) so
 * the coaching-opportunity trigger can be exercised without Zoom/Meet.
 *
 * Ratios are keyed to the demo reps: Henry is the "talks too much" case
 * (matching his seeded note), Gina is moderately high, others are balanced.
 */

import { normalizeWeek } from '../dates';
import type { CallAnalyticsProvider, CallRepRef, RawCall } from './provider';

/** Deterministic value in [0, 1) from a string seed. */
function hash01(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Base talk ratio for a rep, by email local-part where known. */
function baseTalkRatio(rep: CallRepRef): number {
  const key = (rep.email ?? rep.name).toLowerCase();
  if (key.includes('henry')) return 0.74; // talks too much
  if (key.includes('gina')) return 0.6;
  if (key.includes('ava')) return 0.44; // strong listener
  return 0.5;
}

function synthTranscript(rep: CallRepRef, talkHeavy: boolean): string {
  const r = rep.name;
  return talkHeavy
    ? `${r}: Thanks for the time — let me walk you through everything we do.\n` +
        `${r}: So our platform handles onboarding, analytics, reporting, and a lot more, and I really think...\n` +
        `Prospect: We're mainly worried about migration effort.\n` +
        `${r}: Right, and also our roadmap includes even more features next quarter, let me cover those too.\n`
    : `${r}: What's the main outcome you're hoping to get from this?\n` +
        `Prospect: We need to cut reporting time in half.\n` +
        `${r}: Got it — what's making it slow today?\n` +
        `Prospect: Manual exports. If you can automate that, that's the win.\n` +
        `${r}: Makes sense. Should we set a follow-up to scope that with your ops lead?\n`;
}

export class MockCallProvider implements CallAnalyticsProvider {
  readonly name = 'mock';

  async fetchCalls(weekOf: string, reps: CallRepRef[]): Promise<RawCall[]> {
    const week = normalizeWeek(weekOf);
    const calls: RawCall[] = [];

    for (const rep of reps) {
      const base = baseTalkRatio(rep);
      const count = 3 + Math.floor(hash01(`${rep.repId}:${week}:count`) * 3); // 3–5 calls
      for (let i = 0; i < count; i++) {
        const noise = (hash01(`${rep.repId}:${week}:${i}:r`) - 0.5) * 0.12;
        const ratio = clamp(base + noise, 0.2, 0.92);
        const durationSec = Math.round((25 + hash01(`${rep.repId}:${week}:${i}:d`) * 20) * 60);
        calls.push({
          id: `mock-${rep.repId}-${week}-${i}`,
          repId: rep.repId,
          date: offsetDay(week, i % 5),
          durationSec,
          talkRatio: ratio,
          title: `Discovery call ${i + 1}`,
          transcript: synthTranscript(rep, ratio >= 0.65),
        });
      }
    }
    return calls;
  }
}

/** Add whole days to a Monday-anchored date string. */
function offsetDay(week: string, days: number): string {
  const d = new Date(`${week}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
