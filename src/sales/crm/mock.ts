/**
 * Deterministic mock CRM adapter. Provides a working, believable dataset
 * so the tool is usable immediately (no external CRM required) and so the
 * evaluation/PIP logic can be exercised end-to-end.
 *
 * Metrics are a pure function of (rep, weeksAgo) where weeksAgo is measured
 * from a reference week, plus small deterministic noise. Narratives:
 *   - Ava:   consistently healthy
 *   - Ben:   recently slipping (last ~2 weeks)
 *   - Carla: chronically at risk (PIP candidate)
 *   - Dan:   ramping new hire, improving toward healthy
 */

import type { WeeklyMetrics } from '../types';
import { mondayOf, normalizeWeek, weeksBetween } from '../dates';
import type { CrmAdapter, CrmRep, CrmRepMetrics } from './adapter';

interface MockProfile extends CrmRep {
  /** Compute metrics for a given number of weeks before the reference week. */
  build: (weeksAgo: number, noise: (metric: string) => number) => WeeklyMetrics;
}

/** Deterministic noise in roughly [-1, 1] from a string seed. */
function hashNoise(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Map to [-1, 1)
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const PROFILES: MockProfile[] = [
  {
    crmId: 'crm-ava',
    name: 'Ava Chen',
    email: 'ava@example.com',
    startDate: '2023-02-06',
    build: (_weeksAgo, n) => ({
      quotaTarget: 20000,
      bookings: Math.round(21000 + 2000 * n('bk')),
      pipelineValue: Math.round(74000 + 6000 * n('pl')),
      closeRate: clamp(0.31 + 0.03 * n('cr'), 0.1, 0.6),
      proposalsSent: Math.max(0, Math.round(6 + 1 * n('ps'))),
      avgProfitMargin: clamp(0.33 + 0.02 * n('pm'), 0.1, 0.5),
      contractsWon: Math.max(0, Math.round(3 + n('cw'))),
    }),
  },
  {
    crmId: 'crm-ben',
    name: 'Ben Ortiz',
    email: 'ben@example.com',
    startDate: '2022-09-05',
    // Healthy until ~2 weeks ago, then a sharp, sustained drop.
    build: (weeksAgo, n) => {
      const slipping = weeksAgo <= 1;
      return {
        quotaTarget: 20000,
        bookings: Math.round((slipping ? 12500 : 20500) + 1500 * n('bk')),
        pipelineValue: Math.round((slipping ? 46000 : 66000) + 5000 * n('pl')),
        closeRate: clamp((slipping ? 0.15 : 0.27) + 0.02 * n('cr'), 0.05, 0.5),
        proposalsSent: Math.max(0, Math.round((slipping ? 2 : 5) + n('ps'))),
        avgProfitMargin: clamp((slipping ? 0.21 : 0.29) + 0.02 * n('pm'), 0.05, 0.5),
        contractsWon: Math.max(0, Math.round((slipping ? 1 : 3) + n('cw'))),
      };
    },
  },
  {
    crmId: 'crm-carla',
    name: 'Carla Diaz',
    email: 'carla@example.com',
    startDate: '2023-06-05',
    // Persistently below target across all weeks — a PIP candidate.
    build: (_weeksAgo, n) => ({
      quotaTarget: 20000,
      bookings: Math.round(11000 + 1500 * n('bk')),
      pipelineValue: Math.round(38000 + 4000 * n('pl')),
      closeRate: clamp(0.13 + 0.02 * n('cr'), 0.03, 0.4),
      proposalsSent: Math.max(0, Math.round(2 + n('ps'))),
      avgProfitMargin: clamp(0.19 + 0.02 * n('pm'), 0.05, 0.4),
      contractsWon: Math.max(0, Math.round(1 + n('cw'))),
    }),
  },
  {
    crmId: 'crm-dan',
    name: 'Dan Kim',
    email: 'dan@example.com',
    startDate: '2025-05-05',
    // Ramping: worse further back, improving toward the reference week.
    build: (weeksAgo, n) => {
      const ramp = clamp(1 - weeksAgo * 0.06, 0.4, 1); // 1.0 now → lower earlier
      return {
        quotaTarget: 15000,
        bookings: Math.round(15500 * ramp + 1200 * n('bk')),
        pipelineValue: Math.round(52000 * ramp + 4000 * n('pl')),
        closeRate: clamp(0.24 * ramp + 0.02 * n('cr'), 0.03, 0.5),
        proposalsSent: Math.max(0, Math.round(5 * ramp + n('ps'))),
        avgProfitMargin: clamp(0.24 + 0.06 * ramp + 0.02 * n('pm'), 0.05, 0.5),
        contractsWon: Math.max(0, Math.round(2 * ramp + n('cw'))),
      };
    },
  },
];

export class MockCrmAdapter implements CrmAdapter {
  readonly name = 'mock';
  private readonly referenceWeek: string;

  constructor(referenceWeek?: string) {
    this.referenceWeek = referenceWeek ? normalizeWeek(referenceWeek) : mondayOf(new Date());
  }

  async listReps(): Promise<CrmRep[]> {
    return PROFILES.map(({ crmId, name, email, startDate }) => ({ crmId, name, email, startDate }));
  }

  async fetchWeek(weekOf: string): Promise<CrmRepMetrics[]> {
    const week = normalizeWeek(weekOf);
    const weeksAgo = Math.max(0, weeksBetween(week, this.referenceWeek));
    return PROFILES.map((p) => ({
      crmId: p.crmId,
      metrics: p.build(weeksAgo, (metric) => hashNoise(`${p.crmId}:${week}:${metric}`)),
    }));
  }
}
