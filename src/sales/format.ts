/**
 * Value formatting shared by the coaching prompts, PIP documents, and any
 * server-rendered text. (The React client has its own formatters.)
 */

import type { MetricKey } from './types';
import { METRIC_META } from './config';

/** Format a metric value for display given its kind (percent/ratio/count). */
export function formatMetricValue(key: MetricKey, value: number): string {
  const kind = METRIC_META[key].kind;
  switch (kind) {
    case 'percent':
      return `${Math.round(value * 100)}%`;
    case 'ratio':
      return `${value.toFixed(1)}x`;
    case 'count':
      return `${Math.round(value)}`;
  }
}

/** Format a week-over-week delta fraction, or "—" when unavailable. */
export function formatDelta(deltaPct: number | null): string {
  if (deltaPct === null) return '—';
  const pct = Math.round(deltaPct * 100);
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct}%`;
}
