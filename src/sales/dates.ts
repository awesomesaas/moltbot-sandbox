/**
 * Small date helpers for week bucketing. Weeks are identified by the ISO
 * date (YYYY-MM-DD) of the Monday that starts them.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Return the Monday (UTC) of the week containing the given date. */
export function mondayOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // getUTCDay: 0 = Sunday .. 6 = Saturday. Shift so Monday is the anchor.
  const day = d.getUTCDay();
  const diff = (day + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

/** Normalize an arbitrary YYYY-MM-DD (or ISO) string to its week's Monday. */
export function normalizeWeek(weekOf: string): string {
  const d = new Date(`${weekOf.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid weekOf: ${weekOf}`);
  }
  return mondayOf(d);
}

/** Add (or subtract) whole weeks to a Monday-anchored week string. */
export function addWeeks(weekOf: string, weeks: number): string {
  const d = new Date(`${normalizeWeek(weekOf)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

/** Whole weeks between two week strings (b - a). */
export function weeksBetween(a: string, b: string): number {
  const da = new Date(`${normalizeWeek(a)}T00:00:00Z`).getTime();
  const db = new Date(`${normalizeWeek(b)}T00:00:00Z`).getTime();
  return Math.round((db - da) / (7 * DAY_MS));
}
