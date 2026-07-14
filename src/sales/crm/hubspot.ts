/**
 * HubSpot CRM adapter.
 *
 * This is a real, HTTP-backed adapter shape. The pure aggregation function
 * (`aggregateDealsToMetrics`) is fully unit-tested; the network calls map
 * HubSpot's deal/owner objects onto the normalized shape it consumes.
 *
 * Pipeline stages vary per HubSpot account, so the deal→stage mapping uses
 * HubSpot's built-in `hs_is_closed` / `hs_is_closed_won` flags plus a
 * proposal-stage heuristic; tune `PROPOSAL_STAGE_HINT` for your pipeline.
 */

import type { WeeklyMetrics } from '../types';
import { addWeeks, normalizeWeek } from '../dates';
import type { CrmAdapter, CrmRep, CrmRepMetrics } from './adapter';

export interface HubSpotEnv {
  /** Private app access token (Bearer). */
  HUBSPOT_ACCESS_TOKEN?: string;
  /** Default weekly quota target ($) when not available per-rep. */
  SALES_DEFAULT_WEEKLY_QUOTA?: string;
}

/** Normalized deal used by the pure aggregator. */
export interface NormalizedDeal {
  amount: number;
  /** Fraction 0..1, if known. */
  margin?: number;
  stage: 'won' | 'lost' | 'open';
  /** True if a proposal was sent for this deal in the period. */
  isProposal: boolean;
}

const HUBSPOT_API = 'https://api.hubapi.com';
const PROPOSAL_STAGE_HINT = 'proposal';

/**
 * Aggregate a rep's deals for one week into the module's WeeklyMetrics.
 * Pure and deterministic — the tested core of the HubSpot adapter.
 */
export function aggregateDealsToMetrics(deals: NormalizedDeal[], quotaTarget: number): WeeklyMetrics {
  let bookings = 0;
  let pipelineValue = 0;
  let won = 0;
  let lost = 0;
  let proposalsSent = 0;
  let marginSum = 0;
  let marginCount = 0;

  for (const d of deals) {
    if (d.isProposal) proposalsSent++;
    if (d.stage === 'won') {
      bookings += d.amount;
      won++;
      if (typeof d.margin === 'number') {
        marginSum += d.margin;
        marginCount++;
      }
    } else if (d.stage === 'lost') {
      lost++;
    } else {
      pipelineValue += d.amount;
    }
  }

  const decided = won + lost;
  return {
    quotaTarget,
    bookings,
    pipelineValue,
    closeRate: decided > 0 ? won / decided : 0,
    proposalsSent,
    avgProfitMargin: marginCount > 0 ? marginSum / marginCount : 0,
    contractsWon: won,
  };
}

/** Map a raw HubSpot deal record to the normalized shape. */
export function normalizeHubSpotDeal(
  props: Record<string, string | null | undefined>,
): NormalizedDeal {
  const amount = Number(props.amount ?? '0') || 0;
  const closed = props.hs_is_closed === 'true';
  const closedWon = props.hs_is_closed_won === 'true';
  const stageLabel = (props.dealstage ?? '').toLowerCase();

  let stage: NormalizedDeal['stage'] = 'open';
  if (closedWon) stage = 'won';
  else if (closed) stage = 'lost';

  const marginRaw = props.profit_margin ?? props.hs_margin;
  const margin = marginRaw != null && marginRaw !== '' ? clampFraction(Number(marginRaw)) : undefined;

  return {
    amount,
    margin,
    stage,
    isProposal: stageLabel.includes(PROPOSAL_STAGE_HINT),
  };
}

function clampFraction(v: number): number {
  if (!Number.isFinite(v)) return 0;
  // Accept either 0..1 or 0..100 (percent) inputs.
  const frac = v > 1 ? v / 100 : v;
  return Math.max(0, Math.min(1, frac));
}

export class HubSpotCrmAdapter implements CrmAdapter {
  readonly name = 'hubspot';
  private readonly token: string | undefined;
  private readonly defaultQuota: number;

  constructor(env: HubSpotEnv) {
    this.token = env.HUBSPOT_ACCESS_TOKEN;
    this.defaultQuota = Number(env.SALES_DEFAULT_WEEKLY_QUOTA ?? '') || 20000;
  }

  private ensureToken(): string {
    if (!this.token) {
      throw new Error('HubSpot adapter requires HUBSPOT_ACCESS_TOKEN to be set.');
    }
    return this.token;
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${HUBSPOT_API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.ensureToken()}`,
        'content-type': 'application/json',
        ...(init?.headers || {}),
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HubSpot API ${res.status}: ${detail.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  async listReps(): Promise<CrmRep[]> {
    const data = await this.api<{
      results: Array<{ id: string; firstName?: string; lastName?: string; email?: string }>;
    }>('/crm/v3/owners?limit=100');
    return data.results.map((o) => ({
      crmId: o.id,
      name: [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || o.id,
      email: o.email,
    }));
  }

  async fetchWeek(weekOf: string): Promise<CrmRepMetrics[]> {
    const week = normalizeWeek(weekOf);
    const weekStart = new Date(`${week}T00:00:00Z`).getTime();
    const weekEnd = new Date(`${addWeeks(week, 1)}T00:00:00Z`).getTime();
    const reps = await this.listReps();

    const results: CrmRepMetrics[] = [];
    for (const rep of reps) {
      // Deals owned by this rep, either open or closed within the week.
      const search = await this.api<{
        results: Array<{ properties: Record<string, string | null> }>;
      }>('/crm/v3/objects/deals/search', {
        method: 'POST',
        body: JSON.stringify({
          filterGroups: [
            {
              filters: [
                { propertyName: 'hubspot_owner_id', operator: 'EQ', value: rep.crmId },
                { propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(weekStart) },
                { propertyName: 'hs_lastmodifieddate', operator: 'LT', value: String(weekEnd) },
              ],
            },
          ],
          properties: [
            'amount',
            'dealstage',
            'hs_is_closed',
            'hs_is_closed_won',
            'profit_margin',
            'hs_margin',
          ],
          limit: 100,
        }),
      });

      const deals = search.results.map((d) => normalizeHubSpotDeal(d.properties));
      results.push({ crmId: rep.crmId, metrics: aggregateDealsToMetrics(deals, this.defaultQuota) });
    }
    return results;
  }
}
