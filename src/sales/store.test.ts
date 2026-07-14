import { describe, it, expect } from 'vitest';
import { MemorySalesStore, SCHEMA_STATEMENTS } from './store';
import type { CoachingPlan, Pip, Rep, RepWeek } from './types';

function rep(id: string, name: string): Rep {
  return { id, name, active: true, createdAt: 'now', updatedAt: 'now', crmId: `crm-${id}` };
}

function week(repId: string, weekOf: string): RepWeek {
  return {
    repId,
    weekOf,
    source: 'mock',
    ingestedAt: 'now',
    metrics: {
      quotaTarget: 20000,
      bookings: 10000,
      pipelineValue: 30000,
      closeRate: 0.1,
      proposalsSent: 2,
      avgProfitMargin: 0.18,
    },
  };
}

describe('MemorySalesStore', () => {
  it('upserts and lists reps sorted by name', async () => {
    const s = new MemorySalesStore();
    await s.upsertRep(rep('2', 'Zed'));
    await s.upsertRep(rep('1', 'Ann'));
    const reps = await s.listReps();
    expect(reps.map((r) => r.name)).toEqual(['Ann', 'Zed']);
  });

  it('stores weeks oldest-first and upserts by (rep, week)', async () => {
    const s = new MemorySalesStore();
    await s.saveWeek(week('1', '2026-07-13'));
    await s.saveWeek(week('1', '2026-07-06'));
    await s.saveWeek({ ...week('1', '2026-07-13'), source: 'updated' });
    const weeks = await s.getWeeks('1');
    expect(weeks.map((w) => w.weekOf)).toEqual(['2026-07-06', '2026-07-13']);
    expect(weeks[1].source).toBe('updated');
  });

  it('returns the latest coaching plan', async () => {
    const s = new MemorySalesStore();
    const plan = (weekOf: string): CoachingPlan => ({
      repId: '1',
      weekOf,
      summary: '',
      focusAreas: [],
      activities: [],
      source: 'rules',
      createdAt: 'now',
    });
    await s.saveCoachingPlan(plan('2026-07-06'));
    await s.saveCoachingPlan(plan('2026-07-13'));
    const latest = await s.getLatestCoachingPlan('1');
    expect(latest?.weekOf).toBe('2026-07-13');
  });

  it('tracks the active PIP per rep', async () => {
    const s = new MemorySalesStore();
    const pip: Pip = {
      id: 'p1',
      repId: '1',
      status: 'pip_active',
      startedWeek: '2026-07-06',
      targetEndWeek: '2026-08-17',
      durationWeeks: 6,
      recoveryWeeksToPass: 3,
      reason: 'test',
      milestones: [],
      document: '',
      createdAt: 'now',
      updatedAt: 'now',
    };
    await s.savePip(pip);
    expect((await s.getActivePip('1'))?.id).toBe('p1');
    await s.savePip({ ...pip, status: 'pip_passed', outcome: 'passed', resolvedAt: 'now' });
    expect(await s.getActivePip('1')).toBeNull();
    expect((await s.listPips('1')).length).toBe(1);
  });
});

describe('schema', () => {
  it('defines the expected tables', () => {
    const joined = SCHEMA_STATEMENTS.join('\n');
    expect(joined).toContain('sales_reps');
    expect(joined).toContain('sales_rep_weeks');
    expect(joined).toContain('sales_coaching_plans');
    expect(joined).toContain('sales_pips');
  });
});
