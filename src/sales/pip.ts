/**
 * Performance Improvement Plan (PIP) logic: decides when a rep should be
 * flagged/escalated, builds measurable milestones, and evaluates progress
 * of an active PIP against subsequent weeks.
 */

import type {
  MetricKey,
  Pip,
  PipMilestone,
  Thresholds,
  WeekEvaluation,
} from './types';
import type { PipConfig } from './config';
import { METRIC_KEYS, METRIC_META } from './config';
import { atRiskStreak, healthyStreak } from './metrics';
import { addWeeks, normalizeWeek, weeksBetween } from './dates';

/** A non-active recommendation for where a rep sits on the escalation path. */
export type PipRecommendationStatus = 'none' | 'coaching' | 'at_risk' | 'pip_recommended';

export interface PipRecommendation {
  status: PipRecommendationStatus;
  atRiskStreak: number;
  reason: string;
}

/**
 * Decide the escalation status for a rep based on their consecutive
 * at-risk weeks. `evaluations` must be ordered oldest-first.
 */
export function pipRecommendation(
  evaluations: WeekEvaluation[],
  config: PipConfig,
): PipRecommendation {
  const streak = atRiskStreak(evaluations);

  if (streak >= config.pipAfterWeeks) {
    return {
      status: 'pip_recommended',
      atRiskStreak: streak,
      reason: `At risk for ${streak} consecutive weeks (threshold: ${config.pipAfterWeeks}).`,
    };
  }
  if (streak >= config.atRiskAfterWeeks) {
    return {
      status: 'at_risk',
      atRiskStreak: streak,
      reason: `At risk for ${streak} consecutive weeks — one more triggers a PIP.`,
    };
  }
  if (streak >= config.coachingAfterWeeks) {
    return {
      status: 'coaching',
      atRiskStreak: streak,
      reason: `Slipped this week — coach now before it compounds.`,
    };
  }
  return { status: 'none', atRiskStreak: streak, reason: 'On track.' };
}

/**
 * Build measurable milestones for a PIP from the rep's most recent
 * evaluation. Prioritizes the metrics that are actually slipping; always
 * includes quota attainment as the anchor metric.
 */
export function buildPipMilestones(
  latest: WeekEvaluation,
  thresholds: Thresholds,
  targetEndWeek: string,
): PipMilestone[] {
  const focus = new Set<MetricKey>(latest.slipping);
  focus.add('quotaAttainment');

  // Preserve the canonical metric ordering for stable output.
  return METRIC_KEYS.filter((k) => focus.has(k)).map((metric) => ({
    metric,
    label: METRIC_META[metric].label,
    target: thresholds[metric],
    dueWeek: targetEndWeek,
    met: false,
  }));
}

/**
 * Assemble a PIP record (document is filled in by the coaching layer).
 * `startWeek` is normalized to its Monday.
 */
export function createPip(params: {
  id: string;
  repId: string;
  latest: WeekEvaluation;
  thresholds: Thresholds;
  config: PipConfig;
  reason: string;
  nowIso: string;
  startWeek?: string;
}): Pip {
  const startedWeek = normalizeWeek(params.startWeek ?? params.latest.weekOf);
  const targetEndWeek = addWeeks(startedWeek, params.config.pipDurationWeeks);
  const milestones = buildPipMilestones(params.latest, params.thresholds, targetEndWeek);

  return {
    id: params.id,
    repId: params.repId,
    status: 'pip_active',
    startedWeek,
    targetEndWeek,
    durationWeeks: params.config.pipDurationWeeks,
    recoveryWeeksToPass: params.config.recoveryWeeksToPass,
    reason: params.reason,
    milestones,
    document: '',
    createdAt: params.nowIso,
    updatedAt: params.nowIso,
  };
}

export interface PipProgress {
  /** Milestones with their met/unmet status refreshed from latest week. */
  milestones: PipMilestone[];
  /** Consecutive healthy weeks since the PIP started. */
  healthyStreak: number;
  /** Weeks elapsed since the PIP started (relative to the current week). */
  weeksElapsed: number;
  /** True when the PIP should transition to a terminal state. */
  shouldResolve: boolean;
  outcome?: 'passed' | 'failed';
  summary: string;
}

/**
 * Evaluate an active PIP against subsequent weekly evaluations.
 * `evaluations` must be ordered oldest-first and may include weeks before
 * the PIP started (they are filtered out).
 */
export function evaluatePipProgress(
  pip: Pip,
  evaluations: WeekEvaluation[],
  currentWeek: string,
): PipProgress {
  const since = evaluations.filter((e) => weeksBetween(pip.startedWeek, e.weekOf) >= 0);
  const latest = since.length > 0 ? since[since.length - 1] : null;

  // Refresh milestone status from the latest evaluation's metric values.
  const milestones: PipMilestone[] = pip.milestones.map((ms) => {
    if (!latest) return { ...ms };
    const evalMetric = latest.metrics.find((m) => m.key === ms.metric);
    return { ...ms, met: evalMetric ? evalMetric.value >= ms.target : ms.met };
  });

  const recovered = healthyStreak(since);
  const weeksElapsed = Math.max(0, weeksBetween(pip.startedWeek, currentWeek));

  if (recovered >= pip.recoveryWeeksToPass) {
    return {
      milestones,
      healthyStreak: recovered,
      weeksElapsed,
      shouldResolve: true,
      outcome: 'passed',
      summary: `Recovered for ${recovered} consecutive weeks — PIP passed.`,
    };
  }

  if (weeksElapsed >= pip.durationWeeks) {
    return {
      milestones,
      healthyStreak: recovered,
      weeksElapsed,
      shouldResolve: true,
      outcome: 'failed',
      summary: `PIP window of ${pip.durationWeeks} weeks elapsed without sustained recovery.`,
    };
  }

  const remaining = pip.durationWeeks - weeksElapsed;
  return {
    milestones,
    healthyStreak: recovered,
    weeksElapsed,
    shouldResolve: false,
    summary: `Week ${weeksElapsed} of ${pip.durationWeeks}; ${remaining} week(s) left, ${recovered}/${pip.recoveryWeeksToPass} recovered.`,
  };
}
