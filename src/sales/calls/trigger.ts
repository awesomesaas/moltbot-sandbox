/**
 * Call-analytics aggregation and the coaching-opportunity trigger.
 *
 * The trigger fires when a behavioral signal (high rep talk ratio) co-occurs
 * with a declining outcome metric (close rate or revenue/quota) — exactly the
 * "explain a metric drop with call behavior" loop. Pure and fully testable.
 */

import type { CallRecord, CallWeek, CoachingOpportunity, MetricEvaluation, WeekEvaluation } from '../types';
import { METRIC_META } from '../config';
import { formatMetricValue } from '../format';

/** Playbook situation the trigger surfaces. */
export const TALK_HEAVY_SITUATION = 'discovery-listening';

/** Duration-weighted weekly aggregate of a rep's analyzed calls. */
export function aggregateCalls(repId: string, weekOf: string, calls: CallRecord[]): CallWeek | null {
  if (calls.length === 0) return null;

  let weightedRatio = 0;
  let totalDuration = 0;
  for (const c of calls) {
    const w = Math.max(1, c.durationSec);
    weightedRatio += c.talkRatio * w;
    totalDuration += c.durationSec;
  }
  const denom = calls.reduce((a, c) => a + Math.max(1, c.durationSec), 0);
  const avgTalkRatio = weightedRatio / denom;

  const withInsights = calls.filter((c) => c.insights);
  const base: CallWeek = {
    repId,
    weekOf,
    callsAnalyzed: calls.length,
    avgTalkRatio,
    totalDurationSec: totalDuration,
  };
  if (withInsights.length > 0) {
    base.avgQuestionsAsked =
      withInsights.reduce((a, c) => a + (c.insights!.questionsAsked || 0), 0) / withInsights.length;
    base.maxMonologueSec = Math.max(...withInsights.map((c) => c.insights!.longestMonologueSec || 0));
    base.nextStepRate =
      withInsights.filter((c) => c.insights!.nextStepSecured).length / withInsights.length;
  }
  return base;
}

/** A metric is "declining" if it's below target or trending down week-over-week. */
function isDeclining(m: MetricEvaluation | undefined): boolean {
  if (!m) return false;
  return m.status !== 'on_track' || m.trend === 'down';
}

/**
 * Build a coaching opportunity when talk ratio is high AND an outcome metric
 * (close rate first, then quota attainment/revenue) is declining. Returns null
 * otherwise — a high talk ratio with healthy outcomes does not trigger.
 */
export function buildCoachingOpportunity(
  evaluation: WeekEvaluation,
  callWeek: CallWeek | null,
  talkRatioThreshold: number,
): CoachingOpportunity | null {
  if (!callWeek || callWeek.callsAnalyzed === 0) return null;
  if (callWeek.avgTalkRatio < talkRatioThreshold) return null;

  const closeRate = evaluation.metrics.find((m) => m.key === 'closeRate');
  const quota = evaluation.metrics.find((m) => m.key === 'quotaAttainment');

  const target = isDeclining(closeRate) ? closeRate : isDeclining(quota) ? quota : undefined;
  if (!target) return null;

  const ratioPct = Math.round(callWeek.avgTalkRatio * 100);
  const trendBit =
    target.deltaPct !== null && target.deltaPct < 0
      ? `${METRIC_META[target.key].label} ${Math.round(target.deltaPct * 100)}% WoW`
      : `${METRIC_META[target.key].label} at ${formatMetricValue(target.key, target.value)} (below target)`;

  return {
    repId: evaluation.repId,
    weekOf: evaluation.weekOf,
    metric: target.key,
    situationId: TALK_HEAVY_SITUATION,
    talkRatio: callWeek.avgTalkRatio,
    evidence: `Avg talk ratio ${ratioPct}% across ${callWeek.callsAnalyzed} call(s), while ${trendBit}.`,
  };
}
