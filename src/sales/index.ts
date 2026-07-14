/**
 * Public surface of the Sales Coaching module.
 */
export * from './types';
export { resolveConfig, DEFAULT_THRESHOLDS, DEFAULT_PIP_CONFIG, METRIC_META, METRIC_KEYS } from './config';
export type { SalesConfig, PipConfig } from './config';
export { SalesService } from './service';
export type { SalesEnv, ServiceDeps, SyncResult } from './service';
export { D1SalesStore, MemorySalesStore, SCHEMA_STATEMENTS } from './store';
export type { SalesStore } from './store';
export { evaluateWeek, evaluateMetric, atRiskStreak, healthyStreak, metricValue } from './metrics';
export { pipRecommendation, createPip, evaluatePipProgress, buildPipMilestones } from './pip';
export {
  generateCoachingPlan,
  generatePipDocument,
  buildRuleBasedActivities,
  buildRuleBasedPlan,
  buildRuleBasedPipDocument,
  summarizeEvaluation,
} from './coaching';
export { createCrmAdapter } from './crm/adapter';
export type { CrmAdapter, CrmRep, CrmRepMetrics } from './crm/adapter';
export { MockCrmAdapter } from './crm/mock';
export { HubSpotCrmAdapter, aggregateDealsToMetrics, normalizeHubSpotDeal } from './crm/hubspot';
export { createCallProvider } from './calls/provider';
export type { CallAnalyticsProvider, CallRepRef, RawCall } from './calls/provider';
export { MockCallProvider } from './calls/mock';
export { ZoomCallProvider } from './calls/zoom';
export { GoogleMeetCallProvider } from './calls/meet';
export { parseVtt, talkRatio, repSpeakerMatcher, longestMonologueSec } from './calls/transcript';
export type { TranscriptSegment } from './calls/transcript';
export { aggregateCalls, buildCoachingOpportunity, TALK_HEAVY_SITUATION } from './calls/trigger';
export { analyzeTranscript } from './calls/analyze';
export {
  PLAYBOOK,
  situationsForMetric,
  primarySituation,
  matchSituations,
  situationToActivity,
} from './playbook';
export type { CoachingSituation } from './playbook';
export { formatMetricValue, formatDelta } from './format';
export { mondayOf, normalizeWeek, addWeeks, weeksBetween } from './dates';
