import { describe, it, expect } from 'vitest';
import {
  PLAYBOOK,
  matchSituations,
  primarySituation,
  situationsForMetric,
  situationToActivity,
} from './playbook';
import { METRIC_KEYS } from './config';

describe('playbook', () => {
  it('defines at least one situation for every metric', () => {
    for (const key of METRIC_KEYS) {
      expect(situationsForMetric(key).length).toBeGreaterThan(0);
      expect(primarySituation(key).metric).toBe(key);
    }
  });

  it('has unique situation ids', () => {
    const ids = PLAYBOOK.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('converts a situation to a prioritized activity', () => {
    const a = situationToActivity(primarySituation('closeRate'), 'high');
    expect(a.priority).toBe('high');
    expect(a.metric).toBe('closeRate');
    expect(a.title).toBeTruthy();
    expect(a.description).toBeTruthy();
  });

  describe('matchSituations (behavioral notes)', () => {
    it('matches "talks too much on calls" to the discovery/listening play', () => {
      const ids = matchSituations('Rep talks too much on calls and misses feedback').map((s) => s.id);
      expect(ids).toContain('discovery-listening');
    });

    it('matches "not reaching decision makers" to decision-maker access', () => {
      const ids = matchSituations('Struggles to reach the decision maker in prospecting').map((s) => s.id);
      expect(ids).toContain('decision-maker-access');
    });

    it('matches "trials not continuing" to trial conversion', () => {
      const ids = matchSituations('Clients like the pilot but the trial does not continue').map((s) => s.id);
      expect(ids).toContain('trial-conversion');
    });

    it('matches "deals stall before discovery" to proposal-stall', () => {
      const ids = matchSituations('Prospects stall before the discovery call').map((s) => s.id);
      expect(ids).toContain('proposal-stall');
    });

    it('is case-insensitive and returns nothing for empty/irrelevant text', () => {
      expect(matchSituations('TALKS TOO MUCH').map((s) => s.id)).toContain('discovery-listening');
      expect(matchSituations('')).toEqual([]);
      expect(matchSituations(undefined)).toEqual([]);
      expect(matchSituations('everything is going great')).toEqual([]);
    });
  });
});
