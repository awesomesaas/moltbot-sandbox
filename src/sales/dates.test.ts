import { describe, it, expect } from 'vitest';
import { mondayOf, normalizeWeek, addWeeks, weeksBetween } from './dates';

describe('dates', () => {
  it('mondayOf returns the Monday of the week', () => {
    // 2026-07-14 is a Tuesday
    expect(mondayOf(new Date('2026-07-14T12:00:00Z'))).toBe('2026-07-13');
    // 2026-07-13 is a Monday
    expect(mondayOf(new Date('2026-07-13T00:00:00Z'))).toBe('2026-07-13');
    // 2026-07-19 is a Sunday
    expect(mondayOf(new Date('2026-07-19T23:59:59Z'))).toBe('2026-07-13');
  });

  it('normalizeWeek snaps any day to its Monday', () => {
    expect(normalizeWeek('2026-07-16')).toBe('2026-07-13');
    expect(normalizeWeek('2026-07-13')).toBe('2026-07-13');
  });

  it('normalizeWeek throws on invalid input', () => {
    expect(() => normalizeWeek('not-a-date')).toThrow();
  });

  it('addWeeks moves by whole weeks', () => {
    expect(addWeeks('2026-07-13', 1)).toBe('2026-07-20');
    expect(addWeeks('2026-07-13', -2)).toBe('2026-06-29');
  });

  it('weeksBetween counts weeks', () => {
    expect(weeksBetween('2026-07-13', '2026-07-27')).toBe(2);
    expect(weeksBetween('2026-07-27', '2026-07-13')).toBe(-2);
    expect(weeksBetween('2026-07-13', '2026-07-13')).toBe(0);
  });
});
