/**
 * Rules engine: turns raw weekly figures into per-metric evaluations, an
 * overall health score, and a slippage list. Pure functions, fully unit
 * tested — this is the deterministic backbone the coaching and PIP layers
 * build on.
 */

import type {
  MetricEvaluation,
  MetricKey,
  MetricStatus,
  Thresholds,
  Trend,
  WeekEvaluation,
  WeeklyMetrics,
} from './types';
import { METRIC_KEYS, METRIC_META, METRIC_WEIGHTS } from './config';

/** Fraction below target at which a metric is considered "watch". */
const WATCH_BAND = 0.85;
/** Week-over-week change magnitude that counts as a real move. */
const TREND_BAND = 0.05;
/** A healthy metric declining faster than this is downgraded to "watch". */
const DECLINE_TO_WATCH = 0.15;

/** Points awarded to the health score per metric status. */
const STATUS_POINTS: Record<MetricStatus, number> = {
  on_track: 100,
  watch: 60,
  slipping: 20,
};

/** Compute the observed value for a metric from raw weekly figures. */
export function metricValue(key: MetricKey, m: WeeklyMetrics): number {
  switch (key) {
    case 'quotaAttainment':
      return m.quotaTarget > 0 ? m.bookings / m.quotaTarget : 0;
    case 'pipelineCoverage':
      return m.quotaTarget > 0 ? m.pipelineValue / m.quotaTarget : 0;
    case 'closeRate':
      return m.closeRate;
    case 'proposalsSent':
      return m.proposalsSent;
    case 'profitMargin':
      return m.avgProfitMargin;
  }
}

/** Target for a metric from the configured thresholds. */
function metricTarget(key: MetricKey, t: Thresholds): number {
  return t[key];
}

function computeTrend(value: number, prior: number | undefined): { trend: Trend; deltaPct: number | null } {
  if (prior === undefined || prior === null) {
    return { trend: 'flat', deltaPct: null };
  }
  if (prior === 0) {
    // No baseline to divide by; treat any positive as up.
    if (value > 0) return { trend: 'up', deltaPct: null };
    return { trend: 'flat', deltaPct: null };
  }
  const deltaPct = (value - prior) / Math.abs(prior);
  let trend: Trend = 'flat';
  if (deltaPct > TREND_BAND) trend = 'up';
  else if (deltaPct < -TREND_BAND) trend = 'down';
  return { trend, deltaPct };
}

/** Evaluate a single metric against its target and prior-week value. */
export function evaluateMetric(
  key: MetricKey,
  current: WeeklyMetrics,
  thresholds: Thresholds,
  prior?: WeeklyMetrics,
): MetricEvaluation {
  const value = metricValue(key, current);
  const target = metricTarget(key, thresholds);
  const priorValue = prior ? metricValue(key, prior) : undefined;
  const { trend, deltaPct } = computeTrend(value, priorValue);

  let status: MetricStatus;
  if (value >= target) {
    status = 'on_track';
    // A metric that's on target but falling fast deserves attention.
    if (deltaPct !== null && deltaPct < -DECLINE_TO_WATCH) {
      status = 'watch';
    }
  } else if (value >= target * WATCH_BAND) {
    status = 'watch';
  } else {
    status = 'slipping';
  }

  return {
    key,
    label: METRIC_META[key].label,
    value,
    target,
    status,
    trend,
    deltaPct,
    belowTarget: value < target,
  };
}

/** Full weekly evaluation for a rep. */
export function evaluateWeek(
  repId: string,
  weekOf: string,
  current: WeeklyMetrics,
  thresholds: Thresholds,
  prior?: WeeklyMetrics,
): WeekEvaluation {
  const metrics = METRIC_KEYS.map((key) => evaluateMetric(key, current, thresholds, prior));

  let score = 0;
  for (const m of metrics) {
    score += STATUS_POINTS[m.status] * METRIC_WEIGHTS[m.key];
  }
  score = Math.round(score);

  let health: WeekEvaluation['health'];
  if (score >= 80) health = 'healthy';
  else if (score >= 55) health = 'watch';
  else health = 'at_risk';

  // Slipping metrics, worst first (biggest shortfall relative to target).
  const slipping = metrics
    .filter((m) => m.status === 'slipping')
    .sort((a, b) => shortfall(a) - shortfall(b))
    .map((m) => m.key);

  return { repId, weekOf, metrics, score, health, slipping };
}

/** Normalized shortfall (value/target - 1); more negative = worse. */
function shortfall(m: MetricEvaluation): number {
  if (m.target === 0) return 0;
  return m.value / m.target - 1;
}

/**
 * Count consecutive at-risk weeks working backward from the most recent.
 * `evaluations` must be ordered oldest-first.
 */
export function atRiskStreak(evaluations: WeekEvaluation[]): number {
  let streak = 0;
  for (let i = evaluations.length - 1; i >= 0; i--) {
    if (evaluations[i].health === 'at_risk') streak++;
    else break;
  }
  return streak;
}

/**
 * Count consecutive healthy weeks working backward from the most recent.
 * Used to decide whether a rep on a PIP has recovered.
 */
export function healthyStreak(evaluations: WeekEvaluation[]): number {
  let streak = 0;
  for (let i = evaluations.length - 1; i >= 0; i--) {
    if (evaluations[i].health === 'healthy') streak++;
    else break;
  }
  return streak;
}
