import { describe, it, expect, vi, afterEach } from 'vitest';
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

  it('surfaces a behavioral play from owner notes, even on a healthy rep', () => {
    const e = evaluateWeek('r1', '2026-07-13', healthy, DEFAULT_THRESHOLDS);
    const activities = buildRuleBasedActivities(e, 'talks too much on calls, does not listen');
    expect(activities.some((a) => a.title === 'Talk less, diagnose more')).toBe(true);
    // A noted challenge replaces the generic "all good" reinforcement.
    expect(activities.some((a) => a.metric === 'general')).toBe(false);
  });

  it('flows rep.notes into the rule-based plan', () => {
    const e = evaluateWeek('r1', '2026-07-13', healthy, DEFAULT_THRESHOLDS);
    const noted = { ...rep, notes: 'not reaching decision makers' };
    const plan = buildRuleBasedPlan(noted, e, '2026-07-13T00:00:00Z');
    expect(plan.activities.some((a) => a.title === 'Get to the decision-maker')).toBe(true);
  });

  it('caps the number of activities', () => {
    const e = evaluateWeek('r1', '2026-07-13', failing, DEFAULT_THRESHOLDS);
    const activities = buildRuleBasedActivities(e, 'talks too much; not reaching decision makers; trial not continuing');
    expect(activities.length).toBeLessThanOrEqual(6);
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

describe('generateCoachingPlan (AI path, mocked Anthropic)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const env = { ANTHROPIC_API_KEY: 'sk-test' };
  const config = resolveConfig({});

  function stubAnthropicText(text: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text }] }),
        text: async () => '',
      })),
    );
  }

  it('parses a valid AI response into an ai-sourced plan', async () => {
    const e = evaluateWeek('r1', '2026-07-13', failing, DEFAULT_THRESHOLDS);
    stubAnthropicText(
      JSON.stringify({
        summary: 'Quota and close rate both slipped hard this week.',
        focusAreas: ['quotaAttainment', 'closeRate'],
        activities: [
          {
            title: 'Pipeline triage',
            description: 'Review every open deal and confirm the next step.',
            rationale: 'Bookings are well below target.',
            metric: 'quotaAttainment',
            priority: 'high',
          },
        ],
      }),
    );

    const plan = await generateCoachingPlan(rep, e, [e], env, config, '2026-07-13T00:00:00Z');
    expect(plan.source).toBe('ai');
    expect(plan.summary).toMatch(/slipped hard/);
    expect(plan.focusAreas).toEqual(['quotaAttainment', 'closeRate']);
    expect(plan.activities).toHaveLength(1);
    expect(plan.activities[0].title).toBe('Pipeline triage');
  });

  it('extracts JSON even when the model wraps it in prose / code fences', async () => {
    const e = evaluateWeek('r1', '2026-07-13', failing, DEFAULT_THRESHOLDS);
    stubAnthropicText(
      'Sure, here is the plan:\n```json\n' +
        JSON.stringify({
          summary: 'ok',
          focusAreas: ['closeRate'],
          activities: [{ title: 'T', description: 'D', rationale: 'R', metric: 'closeRate', priority: 'medium' }],
        }) +
        '\n```\nHope that helps!',
    );
    const plan = await generateCoachingPlan(rep, e, [e], env, config, '2026-07-13T00:00:00Z');
    expect(plan.source).toBe('ai');
    expect(plan.activities[0].title).toBe('T');
  });

  it('defaults invalid metric/priority values rather than failing', async () => {
    const e = evaluateWeek('r1', '2026-07-13', failing, DEFAULT_THRESHOLDS);
    stubAnthropicText(
      JSON.stringify({
        summary: 's',
        focusAreas: ['bogus'],
        activities: [{ title: 'T', description: 'D', rationale: 'R', metric: 'made_up', priority: 'urgent' }],
      }),
    );
    const plan = await generateCoachingPlan(rep, e, [e], env, config, '2026-07-13T00:00:00Z');
    expect(plan.source).toBe('ai');
    expect(plan.activities[0].metric).toBe('general');
    expect(plan.activities[0].priority).toBe('medium');
    // Unknown focus areas are dropped; falls back to the evaluation's slipping set.
    expect(plan.focusAreas).toEqual(e.slipping);
  });

  it('falls back to rules when the model returns unparseable output', async () => {
    const e = evaluateWeek('r1', '2026-07-13', failing, DEFAULT_THRESHOLDS);
    stubAnthropicText('I could not produce JSON, sorry.');
    const plan = await generateCoachingPlan(rep, e, [e], env, config, '2026-07-13T00:00:00Z');
    expect(plan.source).toBe('rules');
    expect(plan.activities.length).toBeGreaterThan(0);
  });

  it('falls back to rules when an activity is missing required fields', async () => {
    const e = evaluateWeek('r1', '2026-07-13', failing, DEFAULT_THRESHOLDS);
    stubAnthropicText(JSON.stringify({ summary: 's', activities: [{ description: 'no title' }] }));
    const plan = await generateCoachingPlan(rep, e, [e], env, config, '2026-07-13T00:00:00Z');
    expect(plan.source).toBe('rules');
  });

  it('falls back to rules when the API errors', async () => {
    const e = evaluateWeek('r1', '2026-07-13', failing, DEFAULT_THRESHOLDS);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 529, json: async () => ({}), text: async () => 'overloaded' })),
    );
    const plan = await generateCoachingPlan(rep, e, [e], env, config, '2026-07-13T00:00:00Z');
    expect(plan.source).toBe('rules');
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
