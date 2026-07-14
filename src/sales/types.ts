/**
 * Domain types for the Sales Coaching module.
 *
 * The module helps an owner manage each sales rep week by week: it pulls
 * weekly figures (from a CRM adapter), evaluates them against targets and
 * trends, generates specific coaching activities (rules + Anthropic), and
 * escalates to a Performance Improvement Plan (PIP) when a rep keeps missing.
 */

/** The five metrics the tool tracks, keyed for evaluation/UI. */
export type MetricKey =
  | 'quotaAttainment'
  | 'pipelineCoverage'
  | 'closeRate'
  | 'proposalsSent'
  | 'profitMargin';

/** Per-metric evaluation status, worst-last ordering. */
export type MetricStatus = 'on_track' | 'watch' | 'slipping';

/** Week-over-week direction for a metric. */
export type Trend = 'up' | 'down' | 'flat';

/** Overall health of a rep for a given week. */
export type HealthStatus = 'healthy' | 'watch' | 'at_risk';

/** A sales rep managed by the owner. */
export interface Rep {
  id: string;
  name: string;
  email?: string;
  /** Identifier used to match this rep in the source CRM. */
  crmId?: string;
  /** ISO date (YYYY-MM-DD) the rep started; used for ramp context. */
  startDate?: string;
  /**
   * Owner-set weekly quota ($). When present it overrides whatever the CRM
   * reports, so attainment and pipeline coverage reflect the owner's target.
   */
  weeklyQuota?: number;
  /**
   * Free-text observations from the owner about qualitative challenges the
   * metrics can't reveal (e.g. "talks too much on calls", "not reaching
   * decision-makers"). Fed into coaching so plays can target the behavior.
   */
  notes?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Raw figures for a single rep for a single week, as pulled from the CRM.
 * All monetary values are in whole currency units (e.g. dollars).
 */
export interface WeeklyMetrics {
  /** Weekly quota target ($). */
  quotaTarget: number;
  /** Revenue booked / closed-won this week ($). */
  bookings: number;
  /** Total open pipeline value ($). */
  pipelineValue: number;
  /** Win rate as a fraction 0..1 (won / decided opportunities). */
  closeRate: number;
  /** Number of proposals sent this week. */
  proposalsSent: number;
  /** Average profit margin across contracts closed this week, 0..1. */
  avgProfitMargin: number;
  /** Number of contracts won this week (optional context). */
  contractsWon?: number;
}

/** A stored weekly record for a rep. */
export interface RepWeek {
  repId: string;
  /** ISO date (YYYY-MM-DD) of the Monday that starts the week. */
  weekOf: string;
  metrics: WeeklyMetrics;
  /** Name of the CRM adapter that produced this record. */
  source: string;
  ingestedAt: string;
}

/** Targets and slippage thresholds used by the rules engine. */
export interface Thresholds {
  /** Minimum acceptable quota attainment (bookings / target), e.g. 0.9. */
  quotaAttainment: number;
  /** Minimum acceptable pipeline coverage (pipeline / target), e.g. 3. */
  pipelineCoverage: number;
  /** Minimum acceptable close rate, e.g. 0.2. */
  closeRate: number;
  /** Minimum acceptable proposals sent per week, e.g. 4. */
  proposalsSent: number;
  /** Minimum acceptable average profit margin, e.g. 0.25. */
  profitMargin: number;
}

/** Evaluation of a single metric for a single week. */
export interface MetricEvaluation {
  key: MetricKey;
  label: string;
  /** The observed value (fraction for rates, count for proposals). */
  value: number;
  /** The target the value is compared against. */
  target: number;
  status: MetricStatus;
  trend: Trend;
  /** Week-over-week change as a fraction, or null when no prior week. */
  deltaPct: number | null;
  /** True when the value is below target. */
  belowTarget: boolean;
}

/** Full evaluation of a rep for a single week. */
export interface WeekEvaluation {
  repId: string;
  weekOf: string;
  metrics: MetricEvaluation[];
  /** 0..100 weighted health score. */
  score: number;
  health: HealthStatus;
  /** Keys of metrics that slipped this week, worst first. */
  slipping: MetricKey[];
}

/** PIP lifecycle state for a rep. */
export type PipStatus =
  | 'none'
  | 'coaching'
  | 'at_risk'
  | 'pip_active'
  | 'pip_passed'
  | 'pip_failed';

/** A single measurable milestone within a PIP. */
export interface PipMilestone {
  metric: MetricKey;
  label: string;
  /** Target value the rep must reach. */
  target: number;
  /** ISO date (YYYY-MM-DD) the milestone is due. */
  dueWeek: string;
  met?: boolean;
}

/** A Performance Improvement Plan record. */
export interface Pip {
  id: string;
  repId: string;
  status: Extract<PipStatus, 'pip_active' | 'pip_passed' | 'pip_failed'>;
  /** ISO date (YYYY-MM-DD) the PIP started (Monday of that week). */
  startedWeek: string;
  /** ISO date (YYYY-MM-DD) by which the rep must recover. */
  targetEndWeek: string;
  durationWeeks: number;
  /** How many consecutive recovered weeks are required to pass. */
  recoveryWeeksToPass: number;
  reason: string;
  milestones: PipMilestone[];
  /** Rendered PIP document (markdown). */
  document: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  outcome?: 'passed' | 'failed';
}

/** A single coaching activity the owner should run with a rep. */
export interface CoachingActivity {
  title: string;
  /** What to do, concretely. */
  description: string;
  /** Why it matters this week (ties to the slipped metric). */
  rationale: string;
  /** The metric this activity is meant to move. */
  metric: MetricKey | 'general';
  /** low | medium | high priority for the owner's week. */
  priority: 'low' | 'medium' | 'high';
}

/** A weekly coaching plan for one rep. */
export interface CoachingPlan {
  repId: string;
  weekOf: string;
  /** Short summary of where the rep stands. */
  summary: string;
  /** Focus areas (metric keys) for the week, worst first. */
  focusAreas: MetricKey[];
  activities: CoachingActivity[];
  /** 'ai' when generated via Anthropic, 'rules' for the deterministic fallback. */
  source: 'ai' | 'rules';
  createdAt: string;
}

/**
 * AI-derived insights from a single call transcript. Optional — populated
 * only when transcript analysis (Anthropic) is enabled and succeeds.
 */
export interface CallInsights {
  /** Number of questions the rep asked. */
  questionsAsked: number;
  /** Longest uninterrupted rep monologue, in seconds. */
  longestMonologueSec: number;
  /** Whether a concrete next step was secured on the call. */
  nextStepSecured: boolean;
  /** Objections raised by the prospect that the rep left unhandled. */
  missedObjections: string[];
  /** One-line summary of the call dynamics. */
  summary: string;
}

/**
 * Derived record for one analyzed call. Note: raw transcripts are NOT stored
 * — only these derived signals — to minimize PII retention.
 */
export interface CallRecord {
  id: string;
  repId: string;
  /** ISO date (YYYY-MM-DD) of the call. */
  date: string;
  /** Monday-anchored week the call belongs to. */
  weekOf: string;
  durationSec: number;
  /** Rep speaking time / total speaking time, 0..1. */
  talkRatio: number;
  title?: string;
  source: string;
  insights?: CallInsights;
}

/** Weekly call-analytics aggregate for a rep. */
export interface CallWeek {
  repId: string;
  weekOf: string;
  callsAnalyzed: number;
  /** Duration-weighted average rep talk ratio, 0..1. */
  avgTalkRatio: number;
  totalDurationSec: number;
  /** Present when any call in the week has AI insights. */
  avgQuestionsAsked?: number;
  maxMonologueSec?: number;
  /** Fraction of calls where a next step was secured, 0..1. */
  nextStepRate?: number;
}

/**
 * A data-driven coaching trigger: a call-behavior signal (high talk ratio)
 * that co-occurs with a declining outcome metric (close rate / revenue).
 */
export interface CoachingOpportunity {
  repId: string;
  weekOf: string;
  /** The outcome metric that is slipping/declining. */
  metric: MetricKey;
  /** Playbook situation to run (e.g. 'discovery-listening'). */
  situationId: string;
  /** Human-readable evidence tying the behavior to the metric. */
  evidence: string;
  talkRatio: number;
}

/** Rep summary row for the owner overview dashboard. */
export interface RepOverview {
  rep: Rep;
  latestWeek: string | null;
  evaluation: WeekEvaluation | null;
  pipStatus: PipStatus;
  activePipId: string | null;
  /** Consecutive weeks the rep has been at_risk (most recent backward). */
  atRiskStreak: number;
  /** The single most important focus area, if any. */
  topFocus: MetricKey | null;
  /** Latest week's call analytics, if any calls were analyzed. */
  callWeek: CallWeek | null;
  /** A data-driven coaching trigger from call behavior, if fired. */
  opportunity: CoachingOpportunity | null;
}

/** Full detail for a single rep (drill-down view). */
export interface RepDashboard {
  rep: Rep;
  history: RepWeek[];
  evaluations: WeekEvaluation[];
  latestEvaluation: WeekEvaluation | null;
  pipStatus: PipStatus;
  atRiskStreak: number;
  activePip: Pip | null;
  pips: Pip[];
  latestCoaching: CoachingPlan | null;
  /** Latest week's call analytics aggregate, if any. */
  callWeek: CallWeek | null;
  /** Individual analyzed calls for the latest week (most recent first). */
  latestCalls: CallRecord[];
  /** A data-driven coaching trigger from call behavior, if fired. */
  opportunity: CoachingOpportunity | null;
}
