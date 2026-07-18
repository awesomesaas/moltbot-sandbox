/**
 * Tunable configuration for the Sales Coaching module: default targets,
 * PIP escalation cadence, and metric metadata. Owners can override the
 * defaults per deployment via environment variables (see resolveConfig).
 */

import type { MetricKey, Thresholds } from './types';

/** Default targets/thresholds. Conservative, generic B2B starting points. */
export const DEFAULT_THRESHOLDS: Thresholds = {
  quotaAttainment: 0.9, // hit at least 90% of weekly quota
  pipelineCoverage: 3.0, // keep 3x weekly quota in open pipeline
  closeRate: 0.2, // win at least 20% of decided deals
  proposalsSent: 4, // send at least 4 proposals per week
  profitMargin: 0.25, // keep average contract margin at/above 25%
};

/** Escalation cadence and PIP shape. */
export interface PipConfig {
  /** Consecutive at-risk weeks before a coaching flag. */
  coachingAfterWeeks: number;
  /** Consecutive at-risk weeks before an at-risk flag. */
  atRiskAfterWeeks: number;
  /** Consecutive at-risk weeks before a PIP is recommended. */
  pipAfterWeeks: number;
  /** Default PIP length. */
  pipDurationWeeks: number;
  /** Consecutive recovered (healthy) weeks required to pass a PIP. */
  recoveryWeeksToPass: number;
}

export const DEFAULT_PIP_CONFIG: PipConfig = {
  coachingAfterWeeks: 1,
  atRiskAfterWeeks: 2,
  pipAfterWeeks: 3,
  pipDurationWeeks: 6,
  recoveryWeeksToPass: 3,
};

/** Relative weight of each metric in the overall health score (sums to 1). */
export const METRIC_WEIGHTS: Record<MetricKey, number> = {
  quotaAttainment: 0.35,
  closeRate: 0.2,
  pipelineCoverage: 0.2,
  profitMargin: 0.15,
  proposalsSent: 0.1,
};

/** Human-readable labels and formatting hints per metric. */
export const METRIC_META: Record<
  MetricKey,
  { label: string; kind: 'percent' | 'ratio' | 'count' }
> = {
  quotaAttainment: { label: 'Quota attainment', kind: 'percent' },
  pipelineCoverage: { label: 'Pipeline coverage', kind: 'ratio' },
  closeRate: { label: 'Close rate', kind: 'percent' },
  proposalsSent: { label: 'Proposals sent', kind: 'count' },
  profitMargin: { label: 'Profit margin', kind: 'percent' },
};

/** Ordered list of metric keys for stable UI/iteration. */
export const METRIC_KEYS: MetricKey[] = [
  'quotaAttainment',
  'pipelineCoverage',
  'closeRate',
  'proposalsSent',
  'profitMargin',
];

/** Default Anthropic model for coaching generation. */
export const DEFAULT_COACH_MODEL = 'claude-opus-4-8';

/**
 * Rep talk-to-total ratio at/above which a call is "one-sided". Combined
 * with a declining close rate / revenue it triggers a coaching opportunity.
 */
export const DEFAULT_TALK_RATIO_THRESHOLD = 0.65;

/** Resolved runtime configuration for the module. */
export interface SalesConfig {
  thresholds: Thresholds;
  pip: PipConfig;
  coachModel: string;
  crmProvider: string;
  /** Call-recording analytics source: 'mock' (default) | 'zoom' | 'google_meet' | 'none'. */
  callProvider: string;
  /** Talk-ratio threshold for the coaching-opportunity trigger. */
  talkRatioThreshold: number;
}

/** Parse a positive number env var, falling back to a default. */
function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Build the effective config from environment overrides. Unknown/empty
 * values fall back to the defaults above so the module always has a
 * sensible configuration.
 */
export function resolveConfig(env: {
  SALES_QUOTA_ATTAINMENT_TARGET?: string;
  SALES_PIPELINE_COVERAGE_TARGET?: string;
  SALES_CLOSE_RATE_TARGET?: string;
  SALES_PROPOSALS_TARGET?: string;
  SALES_PROFIT_MARGIN_TARGET?: string;
  SALES_PIP_AFTER_WEEKS?: string;
  SALES_PIP_DURATION_WEEKS?: string;
  SALES_COACH_MODEL?: string;
  SALES_CRM_PROVIDER?: string;
  SALES_CALL_PROVIDER?: string;
  SALES_TALK_RATIO_THRESHOLD?: string;
}): SalesConfig {
  return {
    thresholds: {
      quotaAttainment: num(env.SALES_QUOTA_ATTAINMENT_TARGET, DEFAULT_THRESHOLDS.quotaAttainment),
      pipelineCoverage: num(env.SALES_PIPELINE_COVERAGE_TARGET, DEFAULT_THRESHOLDS.pipelineCoverage),
      closeRate: num(env.SALES_CLOSE_RATE_TARGET, DEFAULT_THRESHOLDS.closeRate),
      proposalsSent: num(env.SALES_PROPOSALS_TARGET, DEFAULT_THRESHOLDS.proposalsSent),
      profitMargin: num(env.SALES_PROFIT_MARGIN_TARGET, DEFAULT_THRESHOLDS.profitMargin),
    },
    pip: {
      ...DEFAULT_PIP_CONFIG,
      pipAfterWeeks: Math.max(1, Math.round(num(env.SALES_PIP_AFTER_WEEKS, DEFAULT_PIP_CONFIG.pipAfterWeeks))),
      pipDurationWeeks: Math.max(1, Math.round(num(env.SALES_PIP_DURATION_WEEKS, DEFAULT_PIP_CONFIG.pipDurationWeeks))),
    },
    coachModel: env.SALES_COACH_MODEL || DEFAULT_COACH_MODEL,
    crmProvider: (env.SALES_CRM_PROVIDER || 'mock').toLowerCase(),
    callProvider: (env.SALES_CALL_PROVIDER || 'mock').toLowerCase(),
    talkRatioThreshold: (() => {
      const v = num(env.SALES_TALK_RATIO_THRESHOLD, DEFAULT_TALK_RATIO_THRESHOLD);
      return v > 0 && v < 1 ? v : DEFAULT_TALK_RATIO_THRESHOLD;
    })(),
  };
}
