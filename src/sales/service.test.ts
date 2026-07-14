import { describe, it, expect } from 'vitest';
import { SalesService, type ServiceDeps } from './service';
import { MemorySalesStore } from './store';
import { resolveConfig } from './config';

/** Fixed clock at 2026-07-14 (a Tuesday → week of 2026-07-13). */
function makeDeps(): ServiceDeps {
  let n = 0;
  return {
    now: () => new Date('2026-07-14T00:00:00Z'),
    uuid: () => `id-${n++}`,
  };
}

function makeService(store = new MemorySalesStore()): { svc: SalesService; store: MemorySalesStore } {
  // No Anthropic creds → coaching/PIP docs use the deterministic rule path.
  const svc = new SalesService(store, {}, resolveConfig({}), makeDeps());
  return { svc, store };
}

describe('SalesService.sync', () => {
  it('imports reps and weeks from the mock CRM', async () => {
    const { svc, store } = makeService();
    const result = await svc.sync(6);

    expect(result.weeksSynced).toHaveLength(6);
    expect(result.repsUpdated).toBe(8);

    const reps = await store.listReps();
    expect(reps.map((r) => r.name).sort()).toEqual([
      'Ava Chen',
      'Ben Ortiz',
      'Carla Diaz',
      'Dan Kim',
      'Erin Walsh',
      'Frank Boyle',
      'Gina Reyes',
      'Henry Cole',
    ]);

    const carla = reps.find((r) => r.name === 'Carla Diaz')!;
    const weeks = await store.getWeeks(carla.id);
    expect(weeks).toHaveLength(6);
    expect(weeks.map((w) => w.weekOf)).toEqual([
      '2026-06-08',
      '2026-06-15',
      '2026-06-22',
      '2026-06-29',
      '2026-07-06',
      '2026-07-13',
    ]);
  });

  it('auto-opens a PIP for a chronically at-risk rep', async () => {
    const { svc } = makeService();
    const result = await svc.sync(6);
    expect(result.pipsOpened).toBeGreaterThanOrEqual(1);

    const overview = await svc.getOverview();
    const carla = overview.find((r) => r.rep.name === 'Carla Diaz')!;
    expect(carla.pipStatus).toBe('pip_active');
    expect(carla.activePipId).not.toBeNull();
    expect(carla.atRiskStreak).toBeGreaterThanOrEqual(3);
  });

  it('does not flag a consistently healthy rep', async () => {
    const { svc } = makeService();
    await svc.sync(6);
    const overview = await svc.getOverview();
    const ava = overview.find((r) => r.rep.name === 'Ava Chen')!;
    expect(ava.pipStatus).toBe('none');
    expect(ava.activePipId).toBeNull();
    expect(ava.atRiskStreak).toBe(0);
  });

  it('flags a recently-slipping rep as at_risk without a PIP', async () => {
    const { svc } = makeService();
    await svc.sync(6);
    const overview = await svc.getOverview();
    const ben = overview.find((r) => r.rep.name === 'Ben Ortiz')!;
    expect(['at_risk', 'coaching']).toContain(ben.pipStatus);
    expect(ben.activePipId).toBeNull();
  });

  it('is idempotent across repeated syncs (no duplicate reps or PIPs)', async () => {
    const { svc, store } = makeService();
    await svc.sync(6);
    await svc.sync(6);
    expect((await store.listReps())).toHaveLength(8);
    const overview = await svc.getOverview();
    const carla = overview.find((r) => r.rep.name === 'Carla Diaz')!;
    const carlaPips = await store.listPips(carla.rep.id);
    expect(carlaPips).toHaveLength(1);
  });
});

describe('SalesService coaching + PIP + dashboard', () => {
  it('generates a coaching plan for a rep', async () => {
    const { svc, store } = makeService();
    await svc.sync(6);
    const carla = (await store.listReps()).find((r) => r.name === 'Carla Diaz')!;
    const plan = await svc.generateCoaching(carla.id);
    expect(plan.source).toBe('rules');
    expect(plan.activities.length).toBeGreaterThan(0);
    expect(plan.weekOf).toBe('2026-07-13');

    const dashboard = await svc.getRepDashboard(carla.id);
    expect(dashboard?.latestCoaching?.weekOf).toBe('2026-07-13');
    expect(dashboard?.history).toHaveLength(6);
    expect(dashboard?.activePip).not.toBeNull();
    expect(dashboard?.activePip?.document).toContain('Performance Improvement Plan');
  });

  it('openPip is idempotent while one is active', async () => {
    const { svc, store } = makeService();
    await svc.sync(6);
    const carla = (await store.listReps()).find((r) => r.name === 'Carla Diaz')!;
    const first = await svc.openPip(carla.id);
    const second = await svc.openPip(carla.id);
    expect(second.id).toBe(first.id);
  });

  it('applies an owner-set weekly quota, overriding the CRM target', async () => {
    const { svc, store } = makeService()
    await svc.sync(6)
    const ava = (await store.listReps()).find((r) => r.name === 'Ava Chen')!

    // Ava is healthy against the default quota; raise it so she misses.
    await svc.saveRep({ id: ava.id, name: ava.name, weeklyQuota: 45000 })
    await svc.sync(6)

    const weeks = await store.getWeeks(ava.id)
    expect(weeks[weeks.length - 1].metrics.quotaTarget).toBe(45000)

    const dash = await svc.getRepDashboard(ava.id)
    const attainment = dash!.latestEvaluation!.metrics.find((m) => m.key === 'quotaAttainment')!
    expect(attainment.value).toBeLessThan(0.9)
    expect(dash!.latestEvaluation!.health).not.toBe('healthy')

    // crmId is preserved so re-sync still matches (no duplicate reps).
    expect((await store.listReps())).toHaveLength(8)
  })

  it('supports manually creating a rep', async () => {
    const { svc } = makeService();
    const rep = await svc.saveRep({ name: 'New Rep', email: 'new@example.com' });
    expect(rep.id).toBeTruthy();
    const overview = await svc.getOverview();
    expect(overview.some((r) => r.rep.name === 'New Rep')).toBe(true);
  });

  it('single-metric archetypes surface the expected coaching focus', async () => {
    const { svc } = makeService();
    await svc.sync(6);
    const overview = await svc.getOverview();
    const focusOf = (name: string) => overview.find((r) => r.rep.name === name)!.topFocus;
    expect(focusOf('Erin Walsh')).toBe('pipelineCoverage');
    expect(focusOf('Frank Boyle')).toBe('profitMargin');
    expect(focusOf('Henry Cole')).toBe('closeRate');
  });

  it('uses seeded owner notes to target behavioral coaching', async () => {
    const { svc, store } = makeService();
    await svc.sync(6);
    const henry = (await store.listReps()).find((r) => r.name === 'Henry Cole')!;
    expect(henry.notes).toMatch(/talks too much/i);
    const plan = await svc.generateCoaching(henry.id);
    expect(plan.activities.some((a) => a.title === 'Talk less, diagnose more')).toBe(true);
  });

  it('preserves owner notes across re-sync (never overwritten by the CRM)', async () => {
    const { svc, store } = makeService();
    await svc.sync(6);
    const gina = (await store.listReps()).find((r) => r.name === 'Gina Reyes')!;
    await svc.saveRep({ id: gina.id, name: gina.name, notes: 'custom owner note about discounting' });
    await svc.sync(6);
    const after = await store.getRep(gina.id);
    expect(after?.notes).toBe('custom owner note about discounting');
  });

  it('fires a call-analytics coaching opportunity for a high-talk-ratio rep with slipping outcomes', async () => {
    const { svc } = makeService();
    await svc.sync(6);
    const overview = await svc.getOverview();

    const henry = overview.find((r) => r.rep.name === 'Henry Cole')!;
    expect(henry.callWeek).not.toBeNull();
    expect(henry.callWeek!.avgTalkRatio).toBeGreaterThan(0.65);
    expect(henry.opportunity).not.toBeNull();
    expect(henry.opportunity!.situationId).toBe('discovery-listening');
    expect(henry.opportunity!.metric).toBe('closeRate');

    // A strong listener with healthy outcomes gets no opportunity.
    const ava = overview.find((r) => r.rep.name === 'Ava Chen')!;
    expect(ava.opportunity).toBeNull();
  });

  it('folds the call-analytics evidence into the coaching plan', async () => {
    const { svc, store } = makeService();
    await svc.sync(6);
    const henry = (await store.listReps()).find((r) => r.name === 'Henry Cole')!;
    const plan = await svc.generateCoaching(henry.id);
    const play = plan.activities.find((a) => a.title === 'Talk less, diagnose more');
    expect(play).toBeDefined();
    expect(play!.rationale).toMatch(/talk ratio/i);
  });

  it('stores analyzed calls for the latest week', async () => {
    const { svc, store } = makeService();
    await svc.sync(6);
    const henry = (await store.listReps()).find((r) => r.name === 'Henry Cole')!;
    const dash = await svc.getRepDashboard(henry.id);
    expect(dash!.latestCalls.length).toBeGreaterThanOrEqual(3);
    expect(dash!.callWeek).not.toBeNull();
  });

  it('seedDemo populates weeks and coaching for every rep', async () => {
    const { svc, store } = makeService();
    const result = await svc.seedDemo(6);
    expect(result.repsUpdated).toBe(8);
    expect(result.coached).toBe(8);
    expect(result.failed).toBe(0);
    for (const rep of await store.listReps()) {
      expect(await store.getLatestCoachingPlan(rep.id)).not.toBeNull();
    }
  });
});
