import { describe, it, expect } from 'vitest';
import {
  buildRuleBasedActivities,
  buildRuleBasedPlan,
  buildRuleBasedPipDocument,
  generateCoachingPlan,
  summarizeEvaluation,
} from './coaching';
import { evaluateWeek } from './metrics';
import { createPip } from './pip';
import { resolveConfig, DEFAULT_THRESHOLDS, DEFAULT_PIP_CONFIG } from './config';
import type { Rep, WeeklyMetrics } from './types';

const rep: Rep = {
  id: 'r1',
  name: 'Test Rep',
  active: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

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

describe('rule-based coaching', () => {
  it('produces a high-priority activity for each slipping metric', () => {
    const e = evaluateWeek('r1', '2026-07-13', failing, DEFAULT_THRESHOLDS);
    const activities = buildRuleBasedActivities(e);
    expect(activities.length).toBeGreaterThan(0);
    expect(activities.some((a) => a.metric === 'quotaAttainment' && a.priority === 'high')).toBe(true);
  });

  it('returns a positive reinforcement activity when all is well', () => {
    const e = evaluateWeek('r1', '2026-07-13', healthy, DEFAULT_THRESHOLDS);
    const activities = buildRuleBasedActivities(e);
    expect(activities).toHaveLength(1);
    expect(activities[0].metric).toBe('general');
  });

  it('builds a full plan tagged as rules-sourced', () => {
    const e = evaluateWeek('r1', '2026-07-13', failing, DEFAULT_THRESHOLDS);
    const plan = buildRuleBasedPlan(rep, e, '2026-07-13T00:00:00Z');
    expect(plan.source).toBe('rules');
    expect(plan.focusAreas).toContain('quotaAttainment');
  });
});

describe('generateCoachingPlan', () => {
  it('falls back to rules when no Anthropic credentials are present', async () => {
    const e = evaluateWeek('r1', '2026-07-13', failing, DEFAULT_THRESHOLDS);
    const plan = await generateCoachingPlan(rep, e, [e], {}, resolveConfig({}), '2026-07-13T00:00:00Z');
    expect(plan.source).toBe('rules');
    expect(plan.activities.length).toBeGreaterThan(0);
  });
});

describe('PIP document', () => {
  it('renders the required sections', () => {
    const e = evaluateWeek('r1', '2026-07-13', failing, DEFAULT_THRESHOLDS);
    const pip = createPip({
      id: 'pip-1',
      repId: 'r1',
      latest: e,
      thresholds: DEFAULT_THRESHOLDS,
      config: DEFAULT_PIP_CONFIG,
      reason: 'At risk 3 weeks',
      nowIso: '2026-07-13T00:00:00Z',
    });
    const doc = buildRuleBasedPipDocument(rep, pip, e);
    expect(doc).toContain('Performance Improvement Plan');
    expect(doc).toContain('Success criteria');
    expect(doc).toContain('Consequences');
    expect(doc).toContain(pip.targetEndWeek);
  });
});

describe('summarizeEvaluation', () => {
  it('summarizes healthy vs at-risk', () => {
    const good = evaluateWeek('r1', '2026-07-13', healthy, DEFAULT_THRESHOLDS);
    const bad = evaluateWeek('r1', '2026-07-13', failing, DEFAULT_THRESHOLDS);
    expect(summarizeEvaluation(good)).toMatch(/Healthy/);
    expect(summarizeEvaluation(bad)).toMatch(/At risk/);
  });
});
