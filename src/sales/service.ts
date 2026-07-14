/**
 * Orchestration for the Sales Coaching module. Ties together the CRM
 * adapter, the store, the rules engine, coaching generation, and PIP
 * lifecycle into the operations the API routes expose.
 */

import type {
  CoachingPlan,
  Pip,
  PipStatus,
  Rep,
  RepDashboard,
  RepOverview,
  RepWeek,
  WeekEvaluation,
} from './types';
import type { SalesConfig } from './config';
import type { SalesStore } from './store';
import type { AnthropicEnv } from './anthropic';
import type { CrmEnv } from './crm/adapter';
import { createCrmAdapter } from './crm/adapter';
import { evaluateWeek } from './metrics';
import { pipRecommendation, createPip, evaluatePipProgress } from './pip';
import { generateCoachingPlan, generatePipDocument } from './coaching';
import { addWeeks, mondayOf, normalizeWeek } from './dates';

/** Injectable clock/id sources so the service is deterministic in tests. */
export interface ServiceDeps {
  now: () => Date;
  uuid: () => string;
}

const defaultDeps: ServiceDeps = {
  now: () => new Date(),
  uuid: () => crypto.randomUUID(),
};

export type SalesEnv = AnthropicEnv & CrmEnv;

export interface SyncResult {
  weeksSynced: string[];
  repsUpdated: number;
  pipsOpened: number;
  pipsResolved: number;
}

export class SalesService {
  constructor(
    private store: SalesStore,
    private env: SalesEnv,
    private config: SalesConfig,
    private deps: ServiceDeps = defaultDeps,
  ) {}

  private nowIso(): string {
    return this.deps.now().toISOString();
  }

  private currentWeek(): string {
    return mondayOf(this.deps.now());
  }

  /** Build week-by-week evaluations for a rep, oldest-first. */
  private evaluate(weeks: RepWeek[], repId: string): WeekEvaluation[] {
    const evaluations: WeekEvaluation[] = [];
    for (let i = 0; i < weeks.length; i++) {
      const prior = i > 0 ? weeks[i - 1].metrics : undefined;
      evaluations.push(
        evaluateWeek(repId, weeks[i].weekOf, weeks[i].metrics, this.config.thresholds, prior),
      );
    }
    return evaluations;
  }

  /**
   * Pull the last `count` weeks from the CRM (ending at the current week),
   * upsert reps and weekly metrics, then reconcile PIP state for every rep.
   */
  async sync(count = 6): Promise<SyncResult> {
    const reference = this.currentWeek();
    const adapter = createCrmAdapter(this.config, this.env, reference);
    const crmReps = await adapter.listReps();

    // Ensure a stored rep exists for every CRM rep (match by crmId).
    const existing = await this.store.listReps();
    const byCrmId = new Map(existing.filter((r) => r.crmId).map((r) => [r.crmId as string, r]));
    const repIdByCrmId = new Map<string, string>();

    let repsUpdated = 0;
    for (const cr of crmReps) {
      const found = byCrmId.get(cr.crmId);
      if (found) {
        const updated: Rep = {
          ...found,
          name: cr.name,
          email: cr.email ?? found.email,
          startDate: cr.startDate ?? found.startDate,
          updatedAt: this.nowIso(),
        };
        await this.store.upsertRep(updated);
        repIdByCrmId.set(cr.crmId, found.id);
      } else {
        const rep: Rep = {
          id: this.deps.uuid(),
          name: cr.name,
          email: cr.email,
          crmId: cr.crmId,
          startDate: cr.startDate,
          active: true,
          createdAt: this.nowIso(),
          updatedAt: this.nowIso(),
        };
        await this.store.upsertRep(rep);
        repIdByCrmId.set(cr.crmId, rep.id);
      }
      repsUpdated++;
    }

    // Pull each of the last `count` weeks and store metrics.
    const weeks: string[] = [];
    for (let i = count - 1; i >= 0; i--) {
      weeks.push(addWeeks(reference, -i));
    }
    for (const weekOf of weeks) {
      const rows = await adapter.fetchWeek(weekOf);
      for (const row of rows) {
        const repId = repIdByCrmId.get(row.crmId);
        if (!repId) continue;
        await this.store.saveWeek({
          repId,
          weekOf,
          metrics: row.metrics,
          source: adapter.name,
          ingestedAt: this.nowIso(),
        });
      }
    }

    // Reconcile PIP state now that new weeks are in.
    let pipsOpened = 0;
    let pipsResolved = 0;
    for (const repId of repIdByCrmId.values()) {
      const outcome = await this.reconcilePip(repId);
      if (outcome === 'opened') pipsOpened++;
      else if (outcome === 'resolved') pipsResolved++;
    }

    return { weeksSynced: weeks, repsUpdated, pipsOpened, pipsResolved };
  }

  /**
   * Auto-flag/track PIPs for a rep: refresh an active PIP (resolving it if
   * the window closed or the rep recovered), or open one if the rep has
   * been at risk long enough. Returns what happened.
   */
  async reconcilePip(repId: string): Promise<'opened' | 'resolved' | 'refreshed' | 'none'> {
    const rep = await this.store.getRep(repId);
    if (!rep) return 'none';
    const weeks = await this.store.getWeeks(repId);
    if (weeks.length === 0) return 'none';
    const evaluations = this.evaluate(weeks, repId);

    const active = await this.store.getActivePip(repId);
    if (active) {
      const progress = evaluatePipProgress(active, evaluations, this.currentWeek());
      const updated: Pip = {
        ...active,
        milestones: progress.milestones,
        updatedAt: this.nowIso(),
      };
      if (progress.shouldResolve && progress.outcome) {
        updated.status = progress.outcome === 'passed' ? 'pip_passed' : 'pip_failed';
        updated.outcome = progress.outcome;
        updated.resolvedAt = this.nowIso();
        await this.store.savePip(updated);
        return 'resolved';
      }
      await this.store.savePip(updated);
      return 'refreshed';
    }

    const rec = pipRecommendation(evaluations, this.config.pip);
    if (rec.status === 'pip_recommended') {
      await this.openPip(repId, rec.reason);
      return 'opened';
    }
    return 'none';
  }

  /**
   * Open a PIP for a rep from their latest evaluation and generate the PIP
   * document. Throws if the rep has no data or already has an active PIP.
   */
  async openPip(repId: string, reason?: string): Promise<Pip> {
    const rep = await this.store.getRep(repId);
    if (!rep) throw new Error('Rep not found');
    const existing = await this.store.getActivePip(repId);
    if (existing) return existing;

    const weeks = await this.store.getWeeks(repId);
    if (weeks.length === 0) throw new Error('No weekly data for rep');
    const evaluations = this.evaluate(weeks, repId);
    const latest = evaluations[evaluations.length - 1];
    const rec = pipRecommendation(evaluations, this.config.pip);

    const pip = createPip({
      id: this.deps.uuid(),
      repId,
      latest,
      thresholds: this.config.thresholds,
      config: this.config.pip,
      reason: reason ?? rec.reason,
      nowIso: this.nowIso(),
      startWeek: latest.weekOf,
    });

    const { document } = await generatePipDocument(rep, pip, latest, this.env, this.config);
    pip.document = document;
    await this.store.savePip(pip);
    return pip;
  }

  /** Re-evaluate an active PIP against the latest weeks and persist changes. */
  async refreshPip(pipId: string): Promise<Pip> {
    const pip = await this.store.getPip(pipId);
    if (!pip) throw new Error('PIP not found');
    if (pip.status !== 'pip_active') return pip;

    const weeks = await this.store.getWeeks(pip.repId);
    const evaluations = this.evaluate(weeks, pip.repId);
    const progress = evaluatePipProgress(pip, evaluations, this.currentWeek());

    const updated: Pip = { ...pip, milestones: progress.milestones, updatedAt: this.nowIso() };
    if (progress.shouldResolve && progress.outcome) {
      updated.status = progress.outcome === 'passed' ? 'pip_passed' : 'pip_failed';
      updated.outcome = progress.outcome;
      updated.resolvedAt = this.nowIso();
    }
    await this.store.savePip(updated);
    return updated;
  }

  /**
   * Generate (or regenerate) a coaching plan for a rep for a given week
   * (defaults to the latest week) and persist it.
   */
  async generateCoaching(repId: string, weekOf?: string): Promise<CoachingPlan> {
    const rep = await this.store.getRep(repId);
    if (!rep) throw new Error('Rep not found');
    const weeks = await this.store.getWeeks(repId);
    if (weeks.length === 0) throw new Error('No weekly data for rep');
    const evaluations = this.evaluate(weeks, repId);

    const targetWeek = weekOf ? normalizeWeek(weekOf) : evaluations[evaluations.length - 1].weekOf;
    const evaluation = evaluations.find((e) => e.weekOf === targetWeek);
    if (!evaluation) throw new Error(`No data for week ${targetWeek}`);

    const plan = await generateCoachingPlan(rep, evaluation, evaluations, this.env, this.config, this.nowIso());
    await this.store.saveCoachingPlan(plan);
    return plan;
  }

  private derivePipStatus(activePip: Pip | null, pips: Pip[], recStatus: string): PipStatus {
    if (activePip) return 'pip_active';
    if (recStatus === 'pip_recommended' || recStatus === 'at_risk') return 'at_risk';
    if (recStatus === 'coaching') return 'coaching';
    const lastResolved = pips.find((p) => p.resolvedAt);
    if (lastResolved?.outcome) return lastResolved.outcome === 'passed' ? 'pip_passed' : 'pip_failed';
    return 'none';
  }

  /** Owner overview: one summary row per rep. */
  async getOverview(): Promise<RepOverview[]> {
    const reps = await this.store.listReps();
    const rows: RepOverview[] = [];
    for (const rep of reps) {
      const weeks = await this.store.getWeeks(rep.id);
      const evaluations = this.evaluate(weeks, rep.id);
      const latest = evaluations.length > 0 ? evaluations[evaluations.length - 1] : null;
      const activePip = await this.store.getActivePip(rep.id);
      const pips = await this.store.listPips(rep.id);
      const rec = pipRecommendation(evaluations, this.config.pip);
      rows.push({
        rep,
        latestWeek: latest?.weekOf ?? null,
        evaluation: latest,
        pipStatus: this.derivePipStatus(activePip, pips, rec.status),
        activePipId: activePip?.id ?? null,
        atRiskStreak: rec.atRiskStreak,
        topFocus: latest?.slipping[0] ?? null,
      });
    }
    return rows;
  }

  /** Full detail for one rep. */
  async getRepDashboard(repId: string): Promise<RepDashboard | null> {
    const rep = await this.store.getRep(repId);
    if (!rep) return null;
    const history = await this.store.getWeeks(repId);
    const evaluations = this.evaluate(history, repId);
    const latest = evaluations.length > 0 ? evaluations[evaluations.length - 1] : null;
    const activePip = await this.store.getActivePip(repId);
    const pips = await this.store.listPips(repId);
    const rec = pipRecommendation(evaluations, this.config.pip);
    const latestCoaching = await this.store.getLatestCoachingPlan(repId);

    return {
      rep,
      history,
      evaluations,
      latestEvaluation: latest,
      pipStatus: this.derivePipStatus(activePip, pips, rec.status),
      atRiskStreak: rec.atRiskStreak,
      activePip,
      pips,
      latestCoaching,
    };
  }

  /** Manually create/update a rep. */
  async saveRep(input: Partial<Rep> & { name: string }): Promise<Rep> {
    const now = this.nowIso();
    if (input.id) {
      const existing = await this.store.getRep(input.id);
      if (existing) {
        const updated: Rep = { ...existing, ...input, id: existing.id, updatedAt: now };
        return this.store.upsertRep(updated);
      }
    }
    const rep: Rep = {
      id: input.id ?? this.deps.uuid(),
      name: input.name,
      email: input.email,
      crmId: input.crmId,
      startDate: input.startDate,
      active: input.active ?? true,
      createdAt: now,
      updatedAt: now,
    };
    return this.store.upsertRep(rep);
  }

  async listPips(): Promise<Pip[]> {
    return this.store.listPips();
  }
}
