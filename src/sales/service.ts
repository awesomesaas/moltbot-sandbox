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
import type { CallRecord, CallWeek, CoachingOpportunity } from './types';
import type { SalesConfig } from './config';
import type { SalesStore } from './store';
import { hasAnthropic, type AnthropicEnv } from './anthropic';
import type { CrmEnv } from './crm/adapter';
import { createCrmAdapter } from './crm/adapter';
import { createCallProvider, type CallEnv, type CallRepRef, type RawCall } from './calls/provider';
import { aggregateCalls, buildCoachingOpportunity } from './calls/trigger';
import { analyzeTranscript } from './calls/analyze';
import { evaluateWeek } from './metrics';
import { pipRecommendation, createPip, evaluatePipProgress } from './pip';
import { generateCoachingPlan, generatePipDocument } from './coaching';
import { addWeeks, mondayOf, normalizeWeek } from './dates';

/** Max calls per rep per week to run (token-costly) AI transcript analysis on. */
const MAX_AI_ANALYZED_CALLS = 3;

/** Injectable clock/id sources so the service is deterministic in tests. */
export interface ServiceDeps {
  now: () => Date;
  uuid: () => string;
}

const defaultDeps: ServiceDeps = {
  now: () => new Date(),
  uuid: () => crypto.randomUUID(),
};

export type SalesEnv = AnthropicEnv & CrmEnv & CallEnv;

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
    // Owner-set weekly quota per rep, used to override the CRM's reported target.
    const quotaByRepId = new Map<string, number | undefined>();

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
        quotaByRepId.set(found.id, found.weeklyQuota);
      } else {
        const rep: Rep = {
          id: this.deps.uuid(),
          name: cr.name,
          email: cr.email,
          crmId: cr.crmId,
          startDate: cr.startDate,
          // Seed the owner-notes field from the CRM only on first creation;
          // owner edits afterward are never overwritten by a sync.
          notes: cr.notes,
          active: true,
          createdAt: this.nowIso(),
          updatedAt: this.nowIso(),
        };
        await this.store.upsertRep(rep);
        repIdByCrmId.set(cr.crmId, rep.id);
        quotaByRepId.set(rep.id, rep.weeklyQuota);
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
        // Owner-set quota overrides the CRM's reported target for this rep.
        const quota = quotaByRepId.get(repId);
        const metrics =
          quota != null && quota > 0 ? { ...row.metrics, quotaTarget: quota } : row.metrics;
        await this.store.saveWeek({
          repId,
          weekOf,
          metrics,
          source: adapter.name,
          ingestedAt: this.nowIso(),
        });
      }
    }

    // Pull and store call analytics for the same weeks (if enabled).
    const callReps: CallRepRef[] = crmReps
      .map((cr) => ({ repId: repIdByCrmId.get(cr.crmId) as string, name: cr.name, email: cr.email }))
      .filter((r) => r.repId);
    await this.syncCalls(callReps, weeks);

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
   * Pull call recordings for the given reps/weeks, compute talk ratios, and
   * (for the latest week, when Anthropic is configured) enrich a capped number
   * of calls with AI transcript insights. Transcripts are never persisted.
   */
  private async syncCalls(reps: CallRepRef[], weeks: string[]): Promise<void> {
    const provider = createCallProvider(this.config, this.env);
    if (!provider || reps.length === 0) return;

    const latestWeek = weeks[weeks.length - 1];
    const canAnalyze = hasAnthropic(this.env);
    const repById = new Map(reps.map((r) => [r.repId, r]));

    for (const weekOf of weeks) {
      let raw: RawCall[];
      try {
        raw = await provider.fetchCalls(weekOf, reps);
      } catch (err) {
        console.error(`[sales] call fetch failed for week ${weekOf}:`, err instanceof Error ? err.message : err);
        continue;
      }

      const analyzedPerRep = new Map<string, number>();
      const records: CallRecord[] = [];
      for (const c of raw) {
        let insights = c.insights;
        if (!insights && canAnalyze && weekOf === latestWeek && c.transcript) {
          const n = analyzedPerRep.get(c.repId) ?? 0;
          if (n < MAX_AI_ANALYZED_CALLS) {
            analyzedPerRep.set(c.repId, n + 1);
            const rep = repById.get(c.repId);
            insights =
              (await analyzeTranscript(this.env, this.config, c.transcript, rep?.name ?? '')) ?? undefined;
          }
        }
        records.push({
          id: c.id,
          repId: c.repId,
          date: c.date,
          weekOf,
          durationSec: c.durationSec,
          talkRatio: c.talkRatio,
          title: c.title,
          source: provider.name,
          insights,
        });
      }
      if (records.length > 0) await this.store.saveCalls(records);
    }
  }

  /** Load latest-week call analytics + the coaching opportunity for a rep. */
  private async callContext(
    repId: string,
    latest: WeekEvaluation | null,
  ): Promise<{ callWeek: CallWeek | null; opportunity: CoachingOpportunity | null; calls: CallRecord[] }> {
    if (!latest) return { callWeek: null, opportunity: null, calls: [] };
    const calls = await this.store.getCalls(repId, latest.weekOf);
    const callWeek = aggregateCalls(repId, latest.weekOf, calls);
    const opportunity = buildCoachingOpportunity(latest, callWeek, this.config.talkRatioThreshold);
    return { callWeek, opportunity, calls };
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

    // Fold in the call-analytics coaching opportunity for this week, if any.
    const calls = await this.store.getCalls(repId, targetWeek);
    const callWeek = aggregateCalls(repId, targetWeek, calls);
    const opportunity = buildCoachingOpportunity(evaluation, callWeek, this.config.talkRatioThreshold);

    const plan = await generateCoachingPlan(
      rep,
      evaluation,
      evaluations,
      this.env,
      this.config,
      this.nowIso(),
      opportunity,
    );
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
      const { callWeek, opportunity } = await this.callContext(rep.id, latest);
      rows.push({
        rep,
        latestWeek: latest?.weekOf ?? null,
        evaluation: latest,
        pipStatus: this.derivePipStatus(activePip, pips, rec.status),
        activePipId: activePip?.id ?? null,
        atRiskStreak: rec.atRiskStreak,
        topFocus: latest?.slipping[0] ?? null,
        callWeek,
        opportunity,
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
    const { callWeek, opportunity, calls } = await this.callContext(repId, latest);
    const callTrend = await this.buildCallTrend(repId);

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
      callWeek,
      callTrend,
      latestCalls: calls,
      opportunity,
    };
  }

  /** Per-week talk-ratio aggregates for a rep, oldest-first. */
  private async buildCallTrend(repId: string): Promise<CallWeek[]> {
    const all = await this.store.getCalls(repId);
    const byWeek = new Map<string, CallRecord[]>();
    for (const c of all) {
      const bucket = byWeek.get(c.weekOf);
      if (bucket) bucket.push(c);
      else byWeek.set(c.weekOf, [c]);
    }
    return [...byWeek.keys()]
      .sort()
      .map((week) => aggregateCalls(repId, week, byWeek.get(week) as CallRecord[]))
      .filter((cw): cw is CallWeek => cw !== null);
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
      weeklyQuota: input.weeklyQuota,
      notes: input.notes,
      active: input.active ?? true,
      createdAt: now,
      updatedAt: now,
    };
    return this.store.upsertRep(rep);
  }

  async listPips(): Promise<Pip[]> {
    return this.store.listPips();
  }

  /**
   * Generate a coaching plan for every rep that has weekly data. Used to
   * fully populate a demo (metrics + coaching in one action). Resilient:
   * a failure for one rep doesn't abort the rest.
   */
  async generateCoachingForAll(): Promise<{ coached: number; failed: number }> {
    const reps = await this.store.listReps();
    let coached = 0;
    let failed = 0;
    for (const rep of reps) {
      const weeks = await this.store.getWeeks(rep.id);
      if (weeks.length === 0) continue;
      try {
        await this.generateCoaching(rep.id);
        coached++;
      } catch (err) {
        failed++;
        console.error(`[sales] coaching failed for ${rep.name}:`, err instanceof Error ? err.message : err);
      }
    }
    return { coached, failed };
  }

  /**
   * One-shot demo populate: sync recent weeks from the (mock) CRM and
   * generate a coaching plan for every rep so the whole flow is testable.
   */
  async seedDemo(count = 6): Promise<SyncResult & { coached: number; failed: number }> {
    const sync = await this.sync(count);
    const coaching = await this.generateCoachingForAll();
    return { ...sync, ...coaching };
  }
}
