import { describe, it, expect } from 'vitest';
import { evaluateMetric, evaluateWeek, atRiskStreak, healthyStreak, metricValue } from './metrics';
import { DEFAULT_THRESHOLDS } from './config';
import type { WeeklyMetrics, WeekEvaluation } from './types';

const healthy: WeeklyMetrics = {
  quotaTarget: 20000,
  bookings: 22000,
  pipelineValue: 70000,
  closeRate: 0.3,
  proposalsSent: 6,
  avgProfitMargin: 0.33,
};

const failing: WeeklyMetrics = {
  quotaTarget: 20000,
  bookings: 10000,
  pipelineValue: 30000,
  closeRate: 0.1,
  proposalsSent: 2,
  avgProfitMargin: 0.18,
};

describe('metricValue', () => {
  it('derives attainment and coverage from raw figures', () => {
    expect(metricValue('quotaAttainment', healthy)).toBeCloseTo(1.1);
    expect(metricValue('pipelineCoverage', healthy)).toBeCloseTo(3.5);
  });

  it('guards against zero quota', () => {
    expect(metricValue('quotaAttainment', { ...healthy, quotaTarget: 0 })).toBe(0);
  });
});

describe('evaluateMetric', () => {
  it('marks on_track when at/above target', () => {
    const e = evaluateMetric('quotaAttainment', healthy, DEFAULT_THRESHOLDS);
    expect(e.status).toBe('on_track');
    expect(e.belowTarget).toBe(false);
  });

  it('marks slipping when well below target', () => {
    const e = evaluateMetric('quotaAttainment', failing, DEFAULT_THRESHOLDS);
    expect(e.status).toBe('slipping');
    expect(e.belowTarget).toBe(true);
  });

  it('computes week-over-week trend', () => {
    const up = evaluateMetric('closeRate', healthy, DEFAULT_THRESHOLDS, failing);
    expect(up.trend).toBe('up');
    const down = evaluateMetric('closeRate', failing, DEFAULT_THRESHOLDS, healthy);
    expect(down.trend).toBe('down');
    expect(down.deltaPct).toBeLessThan(0);
  });

  it('downgrades an on-target metric that is falling sharply', () => {
    const prior: WeeklyMetrics = { ...healthy, closeRate: 0.6 };
    const e = evaluateMetric('closeRate', healthy, DEFAULT_THRESHOLDS, prior);
    // 0.3 is above target (0.2) but a 50% drop → watch
    expect(e.status).toBe('watch');
  });
});

describe('evaluateWeek', () => {
  it('scores a healthy week high and reports no slipping metrics', () => {
    const e = evaluateWeek('r1', '2026-07-13', healthy, DEFAULT_THRESHOLDS);
    expect(e.health).toBe('healthy');
    expect(e.score).toBeGreaterThanOrEqual(80);
    expect(e.slipping).toEqual([]);
  });

  it('scores a failing week as at_risk with slipping metrics', () => {
    const e = evaluateWeek('r1', '2026-07-13', failing, DEFAULT_THRESHOLDS);
    expect(e.health).toBe('at_risk');
    expect(e.score).toBeLessThan(55);
    expect(e.slipping).toContain('quotaAttainment');
  });
});

function evalOf(health: WeekEvaluation['health']): WeekEvaluation {
  return { repId: 'r', weekOf: '2026-07-13', metrics: [], score: 0, health, slipping: [] };
}

describe('streaks', () => {
  it('counts consecutive at_risk weeks from the end', () => {
    const evals = [evalOf('healthy'), evalOf('at_risk'), evalOf('at_risk')];
    expect(atRiskStreak(evals)).toBe(2);
  });

  it('breaks the streak on a non-at_risk week', () => {
    const evals = [evalOf('at_risk'), evalOf('healthy'), evalOf('at_risk')];
    expect(atRiskStreak(evals)).toBe(1);
  });

  it('counts healthy streaks from the end', () => {
    const evals = [evalOf('at_risk'), evalOf('healthy'), evalOf('healthy')];
    expect(healthyStreak(evals)).toBe(2);
  });
});
