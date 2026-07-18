import { describe, it, expect } from 'vitest';
import { aggregateCalls, buildCoachingOpportunity, TALK_HEAVY_SITUATION } from './trigger';
import { evaluateWeek } from '../metrics';
import { DEFAULT_THRESHOLDS } from '../config';
import type { CallRecord, WeeklyMetrics } from '../types';

function call(id: string, talkRatio: number, durationSec: number): CallRecord {
  return { id, repId: 'r1', date: '2026-07-13', weekOf: '2026-07-13', durationSec, talkRatio, source: 'mock' };
}

const failing: WeeklyMetrics = {
  quotaTarget: 20000,
  bookings: 10000,
  pipelineValue: 30000,
  closeRate: 0.1,
  proposalsSent: 2,
  avgProfitMargin: 0.18,
};
const healthy: WeeklyMetrics = {
  quotaTarget: 20000,
  bookings: 22000,
  pipelineValue: 70000,
  closeRate: 0.3,
  proposalsSent: 6,
  avgProfitMargin: 0.33,
};

describe('aggregateCalls', () => {
  it('duration-weights the average talk ratio', () => {
    const cw = aggregateCalls('r1', '2026-07-13', [call('a', 0.8, 3000), call('b', 0.4, 1000)]);
    // (0.8*3000 + 0.4*1000) / 4000 = 0.7
    expect(cw?.avgTalkRatio).toBeCloseTo(0.7);
    expect(cw?.callsAnalyzed).toBe(2);
    expect(cw?.totalDurationSec).toBe(4000);
  });
  it('returns null with no calls', () => {
    expect(aggregateCalls('r1', '2026-07-13', [])).toBeNull();
  });
  it('aggregates AI insights when present', () => {
    const withInsights: CallRecord = {
      ...call('c', 0.7, 1800),
      insights: { questionsAsked: 2, longestMonologueSec: 120, nextStepSecured: true, missedObjections: [], summary: '' },
    };
    const cw = aggregateCalls('r1', '2026-07-13', [withInsights]);
    expect(cw?.avgQuestionsAsked).toBe(2);
    expect(cw?.maxMonologueSec).toBe(120);
    expect(cw?.nextStepRate).toBe(1);
  });
});

describe('buildCoachingOpportunity', () => {
  const threshold = 0.65;

  it('fires when talk ratio is high AND close rate is slipping', () => {
    const e = evaluateWeek('r1', '2026-07-13', failing, DEFAULT_THRESHOLDS);
    const cw = aggregateCalls('r1', '2026-07-13', [call('a', 0.72, 1800)]);
    const opp = buildCoachingOpportunity(e, cw, threshold);
    expect(opp).not.toBeNull();
    expect(opp?.metric).toBe('closeRate');
    expect(opp?.situationId).toBe(TALK_HEAVY_SITUATION);
    expect(opp?.evidence).toMatch(/talk ratio/i);
  });

  it('does not fire when talk ratio is below threshold', () => {
    const e = evaluateWeek('r1', '2026-07-13', failing, DEFAULT_THRESHOLDS);
    const cw = aggregateCalls('r1', '2026-07-13', [call('a', 0.5, 1800)]);
    expect(buildCoachingOpportunity(e, cw, threshold)).toBeNull();
  });

  it('does not fire when outcomes are healthy even with a high talk ratio', () => {
    const e = evaluateWeek('r1', '2026-07-13', healthy, DEFAULT_THRESHOLDS);
    const cw = aggregateCalls('r1', '2026-07-13', [call('a', 0.8, 1800)]);
    expect(buildCoachingOpportunity(e, cw, threshold)).toBeNull();
  });

  it('falls back to quota attainment when close rate is fine but revenue drops', () => {
    // close rate on target, but bookings well below quota
    const m: WeeklyMetrics = { ...healthy, bookings: 8000, closeRate: 0.3 };
    const e = evaluateWeek('r1', '2026-07-13', m, DEFAULT_THRESHOLDS);
    const cw = aggregateCalls('r1', '2026-07-13', [call('a', 0.7, 1800)]);
    const opp = buildCoachingOpportunity(e, cw, threshold);
    expect(opp?.metric).toBe('quotaAttainment');
  });

  it('returns null when there are no calls', () => {
    const e = evaluateWeek('r1', '2026-07-13', failing, DEFAULT_THRESHOLDS);
    expect(buildCoachingOpportunity(e, null, threshold)).toBeNull();
  });
});
