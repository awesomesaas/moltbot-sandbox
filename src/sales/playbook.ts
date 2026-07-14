/**
 * Coaching playbook: a library of concrete sales-coaching situations the
 * engine draws on. Each situation maps to the metric it usually moves, and
 * carries keyword cues so an owner's free-text observation about a rep can
 * be matched to the right play (e.g. "talks too much on calls").
 *
 * Situations feed three things:
 *   - the rule-based coaching path (deterministic activities),
 *   - the AI prompt (as worked examples that steer the model's output),
 *   - owner-note matching (behavioral issues the metrics can't reveal).
 */

import type { CoachingActivity, MetricKey } from './types';

export interface CoachingSituation {
  id: string;
  title: string;
  description: string;
  rationale: string;
  /** Metric this situation most directly affects. */
  metric: MetricKey;
  /** Lowercase keyword cues for matching an owner's observation text. */
  cues: string[];
}

/**
 * Ordered per intent; the first situation for a metric is its "primary"
 * play (used by the rule-based path). Behavioral situations that the
 * metrics can't detect on their own are surfaced via note matching and the
 * AI examples.
 */
export const PLAYBOOK: CoachingSituation[] = [
  // --- quota attainment ---
  {
    id: 'deal-review',
    metric: 'quotaAttainment',
    title: 'Deal-by-deal quota review',
    description:
      "Sit down 1:1 and walk every open deal expected to close this quarter. For each, confirm the next step, the decision-maker, and a realistic close date. Rebuild the week's number from committed deals only.",
    rationale: 'Bookings are below the weekly quota target — the gap needs a concrete recovery plan.',
    cues: ['quota', 'behind', 'missing number', 'not closing'],
  },
  // --- pipeline coverage ---
  {
    id: 'prospecting-blocks',
    metric: 'pipelineCoverage',
    title: 'Prospecting block + pipeline gen',
    description:
      'Schedule two protected 90-minute prospecting blocks this week with a target for new qualified opportunities. Review the outbound list and messaging together before they start.',
    rationale: 'Open pipeline has fallen below the coverage target, which starves future quota attainment.',
    cues: ['pipeline', 'no leads', 'not enough opportunities', 'prospecting'],
  },
  {
    id: 'decision-maker-access',
    metric: 'pipelineCoverage',
    title: 'Get to the decision-maker',
    description:
      'Map the buying committee for the top 5 open deals: who signs, who influences, who blocks. Coach a multi-threading plan — a referral-up ask to the current contact, plus a value-led outreach to the economic buyer. Role-play the "who else should be involved?" conversation.',
    rationale:
      "The rep is working deals but not reaching the people who can actually say yes, so opportunities stall or die at the wrong level.",
    cues: ['decision maker', 'decision-maker', 'decisionmaker', 'gatekeeper', 'wrong level', 'no authority', 'champion', 'economic buyer', 'reach the right'],
  },
  // --- close rate ---
  {
    id: 'win-loss-debrief',
    metric: 'closeRate',
    title: 'Win/loss deal debrief',
    description:
      'Take the last 3 lost deals and run a structured debrief: where did it stall, who else was in the room, what objection went unhandled? Role-play the objection handling that would have changed the outcome.',
    rationale: 'Win rate on decided deals is below target — the rep generates activity but is not converting.',
    cues: ['losing', 'lost deals', 'not converting', 'objection', 'close rate'],
  },
  {
    id: 'trial-conversion',
    metric: 'closeRate',
    title: 'Turn trials into commitments',
    description:
      'Before the next trial/pilot starts, agree the success criteria and the go/no-go decision date with the prospect in writing. Mid-trial, run a value check-in tied to those criteria; near the end, present outcomes vs. the agreed goals and ask for the commitment directly. Review the rep\'s last two stalled trials against this and rebuild the close plan.',
    rationale:
      "Prospects like the work but don't continue after trial projects — usually because success was never defined up front and there is no built-in path to a paid decision.",
    cues: ['trial', 'pilot', 'poc', 'proof of concept', 'not continuing', "won't continue", 'after trial', 'convert', 'renewal'],
  },
  {
    id: 'discovery-listening',
    metric: 'closeRate',
    title: 'Talk less, diagnose more',
    description:
      'Review a recent call recording together and measure the rep\'s talk-to-listen ratio. Coach a discovery framework (e.g. problem → impact → priority), and set a rule: no pitching until the prospect\'s top problem is named back to them and confirmed. Have the rep prepare 5 open questions for their next call and debrief what they heard, not what they said.',
    rationale:
      "The rep dominates calls and misses buying signals and objections, so conversations don't advance and deals are lost on fit that better questions would have surfaced.",
    cues: ['talks too much', 'talking too much', 'talk too much', 'not listening', "doesn't listen", 'monologue', 'pitching too early', 'reading the room', 'read the prospect', 'talk ratio', 'dominates'],
  },
  // --- proposals sent ---
  {
    id: 'proposal-cadence',
    metric: 'proposalsSent',
    title: 'Proposal cadence check',
    description:
      'Review which qualified opportunities are ready for a proposal and clear whatever is blocking the rep from sending them. Set a specific proposals-sent goal for the week and check in mid-week.',
    rationale: 'Proposal volume is below target — too few deals are reaching the commitment stage.',
    cues: ['proposals', 'not sending', 'few proposals'],
  },
  {
    id: 'proposal-stall',
    metric: 'proposalsSent',
    title: 'Unstick stalled discovery / proposal reviews',
    description:
      'Audit the deals stuck before a discovery or proposal-review meeting. Coach the rep to book the next meeting from within the current one (never leave a call without the next step on the calendar), give a concrete reason-to-meet tied to the prospect\'s goal, and send a short agenda in advance. Pick 3 stalled prospects and have the rep re-engage each with a specific next-meeting ask this week.',
    rationale:
      "Prospects aren't moving forward to proposal reviews or discovery calls — momentum is lost between meetings because the next step isn't being secured in the room.",
    cues: ['stall', 'stalled', 'not moving forward', "won't book", 'no next meeting', 'ghosting', 'ghosted', 'no-show', 'discovery call', 'proposal review', 'momentum'],
  },
  // --- profit margin ---
  {
    id: 'discounting-review',
    metric: 'profitMargin',
    title: 'Discounting & scoping review',
    description:
      'Review the last few closed contracts for discount levels and scope. Coach value framing and holding price, and agree a discount ceiling that needs manager sign-off before it is offered.',
    rationale: 'Average contract margin is below target — deals are being won but at eroding profitability.',
    cues: ['discount', 'margin', 'giving away', 'price', 'undercharging'],
  },
];

const BY_ID = new Map(PLAYBOOK.map((s) => [s.id, s]));

/** All situations for a metric, primary first. */
export function situationsForMetric(metric: MetricKey): CoachingSituation[] {
  return PLAYBOOK.filter((s) => s.metric === metric);
}

/** The primary (first) situation for a metric. */
export function primarySituation(metric: MetricKey): CoachingSituation {
  const s = PLAYBOOK.find((x) => x.metric === metric);
  // Every metric has at least one situation defined above.
  return s as CoachingSituation;
}

export function situationById(id: string): CoachingSituation | undefined {
  return BY_ID.get(id);
}

/**
 * Match an owner's free-text observation to situations by keyword cue.
 * Case-insensitive substring match; returns situations in playbook order.
 */
export function matchSituations(notes: string | undefined): CoachingSituation[] {
  if (!notes || !notes.trim()) return [];
  const hay = notes.toLowerCase();
  return PLAYBOOK.filter((s) => s.cues.some((cue) => hay.includes(cue)));
}

/** Convert a situation into a coaching activity at the given priority. */
export function situationToActivity(
  s: CoachingSituation,
  priority: CoachingActivity['priority'],
): CoachingActivity {
  return {
    title: s.title,
    description: s.description,
    rationale: s.rationale,
    metric: s.metric,
    priority,
  };
}
