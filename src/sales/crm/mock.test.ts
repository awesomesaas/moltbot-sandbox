import { describe, it, expect } from 'vitest';
import { MockCrmAdapter } from './mock';

describe('MockCrmAdapter', () => {
  const ref = '2026-07-13';

  it('lists a stable set of reps', async () => {
    const reps = await new MockCrmAdapter(ref).listReps();
    expect(reps.map((r) => r.crmId)).toEqual(['crm-ava', 'crm-ben', 'crm-carla', 'crm-dan']);
  });

  it('is deterministic for the same rep + week', async () => {
    const a = await new MockCrmAdapter(ref).fetchWeek('2026-07-06');
    const b = await new MockCrmAdapter(ref).fetchWeek('2026-07-06');
    expect(a).toEqual(b);
  });

  it('models Carla as consistently below quota', async () => {
    const rows = await new MockCrmAdapter(ref).fetchWeek('2026-07-13');
    const carla = rows.find((r) => r.crmId === 'crm-carla')!;
    expect(carla.metrics.bookings).toBeLessThan(carla.metrics.quotaTarget);
  });

  it('models Ben as slipping only in recent weeks', async () => {
    const adapter = new MockCrmAdapter(ref);
    const recent = (await adapter.fetchWeek('2026-07-13')).find((r) => r.crmId === 'crm-ben')!;
    const older = (await adapter.fetchWeek('2026-06-01')).find((r) => r.crmId === 'crm-ben')!;
    expect(recent.metrics.bookings).toBeLessThan(older.metrics.bookings);
  });

  it('normalizes the requested week to its Monday', async () => {
    const monday = await new MockCrmAdapter(ref).fetchWeek('2026-07-13');
    const midweek = await new MockCrmAdapter(ref).fetchWeek('2026-07-15');
    expect(monday).toEqual(midweek);
  });
});
