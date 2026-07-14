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
export { formatMetricValue, formatDelta } from './format';
export { mondayOf, normalizeWeek, addWeeks, weeksBetween } from './dates';
