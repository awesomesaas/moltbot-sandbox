import { describe, it, expect } from 'vitest';
import { pipRecommendation, createPip, buildPipMilestones, evaluatePipProgress } from './pip';
import { DEFAULT_PIP_CONFIG, DEFAULT_THRESHOLDS } from './config';
import { evaluateWeek } from './metrics';
import type { WeeklyMetrics, WeekEvaluation } from './types';

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

function week(weekOf: string, m: WeeklyMetrics): WeekEvaluation {
  return evaluateWeek('r1', weekOf, m, DEFAULT_THRESHOLDS);
}

describe('pipRecommendation', () => {
  it('recommends a PIP after enough consecutive at-risk weeks', () => {
    const evals = [
      week('2026-06-22', failing),
      week('2026-06-29', failing),
      week('2026-07-06', failing),
    ];
    const rec = pipRecommendation(evals, DEFAULT_PIP_CONFIG);
    expect(rec.status).toBe('pip_recommended');
    expect(rec.atRiskStreak).toBe(3);
  });

  it('flags at_risk before the PIP threshold', () => {
    const evals = [week('2026-06-29', failing), week('2026-07-06', failing)];
    expect(pipRecommendation(evals, DEFAULT_PIP_CONFIG).status).toBe('at_risk');
  });

  it('flags coaching after a single miss', () => {
    const evals = [week('2026-06-29', healthy), week('2026-07-06', failing)];
    expect(pipRecommendation(evals, DEFAULT_PIP_CONFIG).status).toBe('coaching');
  });

  it('returns none when healthy', () => {
    const evals = [week('2026-07-06', healthy)];
    expect(pipRecommendation(evals, DEFAULT_PIP_CONFIG).status).toBe('none');
  });
});

describe('buildPipMilestones', () => {
  it('includes slipping metrics and always quota attainment', () => {
    const e = week('2026-07-06', failing);
    const ms = buildPipMilestones(e, DEFAULT_THRESHOLDS, '2026-08-17');
    const keys = ms.map((m) => m.metric);
    expect(keys).toContain('quotaAttainment');
    expect(keys).toContain('closeRate');
    expect(ms.every((m) => m.dueWeek === '2026-08-17')).toBe(true);
  });
});

describe('createPip + evaluatePipProgress', () => {
  const latest = week('2026-07-06', failing);
  const pip = createPip({
    id: 'pip-1',
    repId: 'r1',
    latest,
    thresholds: DEFAULT_THRESHOLDS,
    config: DEFAULT_PIP_CONFIG,
    reason: 'test',
    nowIso: '2026-07-06T00:00:00Z',
    startWeek: '2026-07-06',
  });

  it('sets the end week from the configured duration', () => {
    expect(pip.startedWeek).toBe('2026-07-06');
    expect(pip.targetEndWeek).toBe('2026-08-17'); // +6 weeks
    expect(pip.status).toBe('pip_active');
  });

  it('passes after enough consecutive recovered weeks', () => {
    const evals = [
      week('2026-07-06', failing),
      week('2026-07-13', healthy),
      week('2026-07-20', healthy),
      week('2026-07-27', healthy),
    ];
    const progress = evaluatePipProgress(pip, evals, '2026-07-27');
    expect(progress.outcome).toBe('passed');
    expect(progress.shouldResolve).toBe(true);
  });

  it('fails when the window elapses without recovery', () => {
    const evals = [
      week('2026-07-06', failing),
      week('2026-07-13', failing),
      week('2026-08-17', failing),
    ];
    const progress = evaluatePipProgress(pip, evals, '2026-08-17');
    expect(progress.outcome).toBe('failed');
    expect(progress.shouldResolve).toBe(true);
  });

  it('stays in progress mid-window', () => {
    const evals = [week('2026-07-06', failing), week('2026-07-13', failing)];
    const progress = evaluatePipProgress(pip, evals, '2026-07-13');
    expect(progress.shouldResolve).toBe(false);
    expect(progress.outcome).toBeUndefined();
  });

  it('refreshes milestone met status from the latest week', () => {
    const evals = [week('2026-07-06', failing), week('2026-07-13', healthy)];
    const progress = evaluatePipProgress(pip, evals, '2026-07-13');
    const quota = progress.milestones.find((m) => m.metric === 'quotaAttainment');
    expect(quota?.met).toBe(true);
  });
});
