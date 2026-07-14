/**
 * CRM integration interface. The rest of the module depends only on this
 * abstraction; concrete adapters (mock, HubSpot, Salesforce, …) implement
 * it. A factory selects the adapter from configuration so new CRMs can be
 * added without touching the service or routes.
 */

import type { WeeklyMetrics } from '../types';
import type { SalesConfig } from '../config';
import { normalizeWeek } from '../dates';
import { MockCrmAdapter } from './mock';
import { HubSpotCrmAdapter, type HubSpotEnv } from './hubspot';

/** A rep as described by the source CRM. */
export interface CrmRep {
  crmId: string;
  name: string;
  email?: string;
  startDate?: string;
}

/** One rep's raw metrics for a requested week. */
export interface CrmRepMetrics {
  crmId: string;
  metrics: WeeklyMetrics;
}

/** Pluggable CRM data source. */
export interface CrmAdapter {
  /** Adapter identifier, stored on each ingested week. */
  readonly name: string;
  /** List the reps tracked in the CRM. */
  listReps(): Promise<CrmRep[]>;
  /** Fetch each rep's aggregated metrics for the given week (Monday-anchored). */
  fetchWeek(weekOf: string): Promise<CrmRepMetrics[]>;
}

/** Env fields consumed by CRM adapters. */
export type CrmEnv = HubSpotEnv;

/**
 * Build the configured CRM adapter. Defaults to the mock adapter, which
 * provides a working dataset out of the box. `referenceWeek` anchors the
 * mock's narrative (defaults to the current week).
 */
export function createCrmAdapter(
  config: SalesConfig,
  env: CrmEnv,
  referenceWeek?: string,
): CrmAdapter {
  const ref = referenceWeek ? normalizeWeek(referenceWeek) : undefined;
  switch (config.crmProvider) {
    case 'hubspot':
      return new HubSpotCrmAdapter(env);
    case 'salesforce':
      // Not yet implemented; fail loudly rather than silently returning mock data.
      throw new Error(
        'Salesforce CRM adapter is not implemented yet. Set SALES_CRM_PROVIDER=mock or hubspot.',
      );
    case 'mock':
    default:
      return new MockCrmAdapter(ref);
  }
}
