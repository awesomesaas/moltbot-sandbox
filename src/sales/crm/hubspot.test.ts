import { describe, it, expect } from 'vitest';
import { aggregateDealsToMetrics, normalizeHubSpotDeal, HubSpotCrmAdapter, type NormalizedDeal } from './hubspot';

describe('aggregateDealsToMetrics', () => {
  it('sums bookings, pipeline, win rate, proposals, and margin', () => {
    const deals: NormalizedDeal[] = [
      { amount: 10000, margin: 0.3, stage: 'won', isProposal: true },
      { amount: 5000, margin: 0.2, stage: 'won', isProposal: false },
      { amount: 8000, stage: 'lost', isProposal: true },
      { amount: 12000, stage: 'open', isProposal: true },
    ];
    const m = aggregateDealsToMetrics(deals, 20000);
    expect(m.bookings).toBe(15000);
    expect(m.pipelineValue).toBe(12000);
    expect(m.contractsWon).toBe(2);
    expect(m.closeRate).toBeCloseTo(2 / 3); // 2 won of 3 decided
    expect(m.proposalsSent).toBe(3);
    expect(m.avgProfitMargin).toBeCloseTo(0.25);
    expect(m.quotaTarget).toBe(20000);
  });

  it('handles no decided deals without dividing by zero', () => {
    const m = aggregateDealsToMetrics([{ amount: 5000, stage: 'open', isProposal: false }], 20000);
    expect(m.closeRate).toBe(0);
    expect(m.avgProfitMargin).toBe(0);
  });
});

describe('normalizeHubSpotDeal', () => {
  it('maps closed-won deals', () => {
    const d = normalizeHubSpotDeal({ amount: '9000', hs_is_closed: 'true', hs_is_closed_won: 'true' });
    expect(d.stage).toBe('won');
    expect(d.amount).toBe(9000);
  });

  it('maps closed-lost deals', () => {
    const d = normalizeHubSpotDeal({ amount: '9000', hs_is_closed: 'true', hs_is_closed_won: 'false' });
    expect(d.stage).toBe('lost');
  });

  it('treats non-closed deals as open pipeline', () => {
    const d = normalizeHubSpotDeal({ amount: '9000', dealstage: 'presentationscheduled' });
    expect(d.stage).toBe('open');
  });

  it('detects proposal stages and percent-style margins', () => {
    const d = normalizeHubSpotDeal({ amount: '9000', dealstage: 'Proposal Sent', profit_margin: '30' });
    expect(d.isProposal).toBe(true);
    expect(d.margin).toBeCloseTo(0.3);
  });
});

describe('HubSpotCrmAdapter', () => {
  it('throws a clear error without a token', async () => {
    const adapter = new HubSpotCrmAdapter({});
    await expect(adapter.listReps()).rejects.toThrow(/HUBSPOT_ACCESS_TOKEN/);
  });
});
