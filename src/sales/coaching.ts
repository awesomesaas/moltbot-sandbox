/**
 * Coaching generation: rule-based activity templates (deterministic,
 * always available) plus an Anthropic-backed generator that produces
 * specific, tailored weekly activities. AI output is validated and falls
 * back to rules on any failure, so the tool always returns a usable plan.
 */

import type {
  CoachingActivity,
  CoachingOpportunity,
  CoachingPlan,
  MetricEvaluation,
  MetricKey,
  Pip,
  Rep,
  WeekEvaluation,
} from './types';
import type { SalesConfig } from './config';
import { METRIC_META } from './config';
import { formatDelta, formatMetricValue } from './format';
import { callAnthropic, extractJson, hasAnthropic, type AnthropicEnv } from './anthropic';
import { PLAYBOOK, matchSituations, primarySituation, situationById, situationToActivity } from './playbook';

/** Max activities in a single rule-based plan. */
const MAX_ACTIVITIES = 6;

/** Format one metric line for a prompt or summary. */
function metricLine(m: MetricEvaluation): string {
  return `- ${m.label}: ${formatMetricValue(m.key, m.value)} (target ${formatMetricValue(
    m.key,
    m.target,
  )}, ${m.status}, WoW ${formatDelta(m.deltaPct)})`;
}

/** A compact human-readable summary of a week's evaluation. */
export function summarizeEvaluation(evaluation: WeekEvaluation): string {
  const slipping = evaluation.slipping.map((k) => METRIC_META[k].label);
  if (evaluation.health === 'healthy') {
    return `Healthy week (score ${evaluation.score}/100). All key metrics on track.`;
  }
  const focus = slipping.length > 0 ? ` Focus: ${slipping.join(', ')}.` : '';
  return `${evaluation.health === 'at_risk' ? 'At risk' : 'Watch'} (score ${evaluation.score}/100).${focus}`;
}

/**
 * Build deterministic coaching activities from an evaluation and (optionally)
 * the owner's observed challenges. Order of priority:
 *   1. behavioral situations matched from the owner's notes,
 *   2. the primary play for each slipping metric (worst first),
 *   3. the primary play for each watch metric.
 * Always returns at least one activity.
 */
export function buildRuleBasedActivities(
  evaluation: WeekEvaluation,
  notes?: string,
  opportunity?: CoachingOpportunity | null,
): CoachingActivity[] {
  const activities: CoachingActivity[] = [];
  const usedIds = new Set<string>();

  const add = (situationId: string, activity: CoachingActivity): void => {
    if (usedIds.has(situationId)) return;
    usedIds.add(situationId);
    activities.push(activity);
  };

  // 1. Data-driven call-analytics trigger, with its evidence attached.
  if (opportunity) {
    const s = situationById(opportunity.situationId);
    if (s) {
      const activity = situationToActivity(s, 'high');
      add(s.id, { ...activity, rationale: `${activity.rationale} ${opportunity.evidence}` });
    }
  }

  // 2. Owner-observed challenges the metrics can't reveal.
  for (const s of matchSituations(notes)) {
    add(s.id, situationToActivity(s, 'high'));
  }

  // 2. Primary play for each slipping metric, worst first.
  for (const key of evaluation.slipping) {
    const s = primarySituation(key);
    add(s.id, situationToActivity(s, 'high'));
  }

  // 3. Primary play for each watch metric.
  for (const m of evaluation.metrics) {
    if (m.status !== 'watch') continue;
    const s = primarySituation(m.key);
    add(s.id, situationToActivity(s, 'medium'));
  }

  if (activities.length === 0) {
    activities.push({
      metric: 'general',
      title: 'Reinforce what’s working',
      description:
        'The rep is on track across the board. Acknowledge the wins specifically, ask what’s driving the results, and set a modest stretch goal to keep momentum.',
      rationale: 'All metrics are healthy — protect the trajectory and capture what’s working for the rest of the team.',
      priority: 'low',
    });
  }
  return activities.slice(0, MAX_ACTIVITIES);
}

/** Build a rule-based coaching plan (no LLM). */
export function buildRuleBasedPlan(
  rep: Rep,
  evaluation: WeekEvaluation,
  nowIso: string,
  opportunity?: CoachingOpportunity | null,
): CoachingPlan {
  return {
    repId: rep.id,
    weekOf: evaluation.weekOf,
    summary: summarizeEvaluation(evaluation),
    focusAreas: evaluation.slipping,
    activities: buildRuleBasedActivities(evaluation, rep.notes, opportunity),
    source: 'rules',
    createdAt: nowIso,
  };
}

/** Worked examples from the playbook, injected into the system prompt to steer output. */
const PLAYBOOK_REFERENCE = PLAYBOOK.map(
  (s) => `- ${s.title} (${s.metric}): ${s.rationale}`,
).join('\n');

const COACH_SYSTEM = `You are an expert sales manager and coach helping a small-business owner manage individual sales reps week by week.
You turn a rep's weekly metrics — and the manager's own observations — into a short list of specific, high-leverage coaching activities the owner can run THIS week.
Be concrete and practical: name the activity, describe exactly what to do, and tie it to the metric or behavior it addresses.
Do not invent metrics or numbers that are not provided. Keep each activity realistic for a busy owner.

Draw on these common coaching situations when they fit the data or the manager's notes (adapt them, don't copy verbatim):
${PLAYBOOK_REFERENCE}

If the manager has noted a specific challenge for this rep (e.g. talking too much on calls, not reaching decision-makers, deals stalling before a meeting, trials not converting), prioritize activities that directly address it — these behaviors often won't show up in the metrics alone.

Respond with ONLY a JSON object, no prose, matching this shape:
{
  "summary": "one or two sentence read on where the rep stands",
  "focusAreas": ["metricKey", ...],
  "activities": [
    {
      "title": "short title",
      "description": "what to do, concretely",
      "rationale": "why it matters this week",
      "metric": "quotaAttainment|pipelineCoverage|closeRate|proposalsSent|profitMargin|general",
      "priority": "low|medium|high"
    }
  ]
}`;

function buildCoachUserPrompt(
  rep: Rep,
  evaluation: WeekEvaluation,
  history: WeekEvaluation[],
  opportunity?: CoachingOpportunity | null,
): string {
  const trend = history
    .slice(-4)
    .map((e) => `  ${e.weekOf}: ${e.health} (score ${e.score})`)
    .join('\n');

  return [
    `Rep: ${rep.name}${rep.startDate ? ` (started ${rep.startDate})` : ''}`,
    `Week of: ${evaluation.weekOf}`,
    `Overall: ${evaluation.health} (health score ${evaluation.score}/100)`,
    '',
    'This week’s metrics:',
    ...evaluation.metrics.map(metricLine),
    ...(rep.notes && rep.notes.trim()
      ? ['', `Manager's observed challenges for this rep: ${rep.notes.trim()}`]
      : []),
    ...(opportunity
      ? ['', `Call-analytics signal: ${opportunity.evidence} Prioritize a play that addresses this.`]
      : []),
    '',
    'Recent health trend:',
    trend || '  (no prior weeks)',
    '',
    'Produce 2–4 coaching activities prioritizing the metrics that are slipping, the call-analytics signal, and any challenge the manager noted.',
  ].join('\n');
}

const VALID_METRICS = new Set<CoachingActivity['metric']>([
  'quotaAttainment',
  'pipelineCoverage',
  'closeRate',
  'proposalsSent',
  'profitMargin',
  'general',
]);

const VALID_PRIORITIES = new Set<CoachingActivity['priority']>(['low', 'medium', 'high']);

/** Validate and normalize a parsed AI plan; throws if unusable. */
function parseAiPlan(
  raw: unknown,
  rep: Rep,
  evaluation: WeekEvaluation,
  nowIso: string,
): CoachingPlan {
  const obj = raw as {
    summary?: unknown;
    focusAreas?: unknown;
    activities?: unknown;
  };
  if (!obj || !Array.isArray(obj.activities) || obj.activities.length === 0) {
    throw new Error('AI plan missing activities');
  }

  const activities: CoachingActivity[] = obj.activities.map((a) => {
    const act = a as Record<string, unknown>;
    const metric = VALID_METRICS.has(act.metric as CoachingActivity['metric'])
      ? (act.metric as CoachingActivity['metric'])
      : 'general';
    const priority = VALID_PRIORITIES.has(act.priority as CoachingActivity['priority'])
      ? (act.priority as CoachingActivity['priority'])
      : 'medium';
    const title = typeof act.title === 'string' ? act.title.trim() : '';
    const description = typeof act.description === 'string' ? act.description.trim() : '';
    if (!title || !description) {
      throw new Error('AI activity missing title/description');
    }
    return {
      title,
      description,
      rationale: typeof act.rationale === 'string' ? act.rationale.trim() : '',
      metric,
      priority,
    };
  });

  const focusAreas = Array.isArray(obj.focusAreas)
    ? (obj.focusAreas.filter((f) => VALID_METRICS.has(f as CoachingActivity['metric']) && f !== 'general') as MetricKey[])
    : evaluation.slipping;

  return {
    repId: rep.id,
    weekOf: evaluation.weekOf,
    summary: typeof obj.summary === 'string' && obj.summary.trim()
      ? obj.summary.trim()
      : summarizeEvaluation(evaluation),
    focusAreas: focusAreas.length > 0 ? focusAreas : evaluation.slipping,
    activities,
    source: 'ai',
    createdAt: nowIso,
  };
}

/**
 * Generate a weekly coaching plan. Uses Anthropic when configured and the
 * response is valid; otherwise returns the deterministic rule-based plan.
 */
export async function generateCoachingPlan(
  rep: Rep,
  evaluation: WeekEvaluation,
  history: WeekEvaluation[],
  env: AnthropicEnv,
  config: SalesConfig,
  nowIso: string,
  opportunity?: CoachingOpportunity | null,
): Promise<CoachingPlan> {
  if (!hasAnthropic(env)) {
    return buildRuleBasedPlan(rep, evaluation, nowIso, opportunity);
  }
  try {
    const text = await callAnthropic(env, {
      model: config.coachModel,
      system: COACH_SYSTEM,
      user: buildCoachUserPrompt(rep, evaluation, history, opportunity),
      maxTokens: 1500,
    });
    return parseAiPlan(extractJson(text), rep, evaluation, nowIso);
  } catch (err) {
    console.error('[sales] coaching AI generation failed, using rules:', err);
    return buildRuleBasedPlan(rep, evaluation, nowIso, opportunity);
  }
}

/** Deterministic PIP document (markdown) used as the AI fallback. */
export function buildRuleBasedPipDocument(
  rep: Rep,
  pip: Pip,
  evaluation: WeekEvaluation,
): string {
  const lines: string[] = [];
  lines.push(`# Performance Improvement Plan — ${rep.name}`);
  lines.push('');
  lines.push(`**Start week:** ${pip.startedWeek}  `);
  lines.push(`**Target end week:** ${pip.targetEndWeek} (${pip.durationWeeks} weeks)  `);
  lines.push(`**Recovery requirement:** ${pip.recoveryWeeksToPass} consecutive weeks meeting targets`);
  lines.push('');
  lines.push('## Reason for this plan');
  lines.push('');
  lines.push(pip.reason);
  lines.push('');
  lines.push('## Current standing');
  lines.push('');
  for (const m of evaluation.metrics) {
    lines.push(metricLine(m));
  }
  lines.push('');
  lines.push('## Success criteria');
  lines.push('');
  lines.push('To successfully complete this plan, the following targets must be met and sustained:');
  lines.push('');
  for (const ms of pip.milestones) {
    lines.push(`- **${ms.label}:** reach ${formatMetricValue(ms.metric, ms.target)} by ${ms.dueWeek}.`);
  }
  lines.push('');
  lines.push('## Support the manager will provide');
  lines.push('');
  lines.push('- Weekly 1:1 to review progress against the metrics above.');
  lines.push('- Targeted coaching activities each week (see the weekly coaching plan).');
  lines.push('- Removal of blockers the rep raises that are within the manager’s control.');
  lines.push('');
  lines.push('## Consequences');
  lines.push('');
  lines.push(
    `If the targets are not met and sustained by ${pip.targetEndWeek}, further action may be taken up to and including termination, consistent with company policy.`,
  );
  return lines.join('\n');
}

const PIP_SYSTEM = `You are an experienced sales manager and HR-aware writer drafting a fair, professional Performance Improvement Plan (PIP) for a sales rep.
Write in clear, respectful, specific language. Base everything on the metrics and targets provided — do not invent numbers.
The document must include: reason for the plan, the rep's current standing, measurable success criteria with dates, the support the manager will provide, and consequences if targets are not met.
Return ONLY a markdown document (no code fences, no preamble).`;

function buildPipUserPrompt(rep: Rep, pip: Pip, evaluation: WeekEvaluation): string {
  return [
    `Rep: ${rep.name}${rep.startDate ? ` (started ${rep.startDate})` : ''}`,
    `PIP start week: ${pip.startedWeek}`,
    `PIP target end week: ${pip.targetEndWeek} (${pip.durationWeeks} weeks)`,
    `Recovery requirement: ${pip.recoveryWeeksToPass} consecutive weeks meeting targets`,
    `Reason: ${pip.reason}`,
    '',
    'Current metrics:',
    ...evaluation.metrics.map(metricLine),
    '',
    'Required milestones:',
    ...pip.milestones.map(
      (ms) => `- ${ms.label}: reach ${formatMetricValue(ms.metric, ms.target)} by ${ms.dueWeek}`,
    ),
    '',
    'Write the full PIP document now.',
  ].join('\n');
}

/**
 * Generate a PIP document. Uses Anthropic when configured; otherwise
 * returns the deterministic template.
 */
export async function generatePipDocument(
  rep: Rep,
  pip: Pip,
  evaluation: WeekEvaluation,
  env: AnthropicEnv,
  config: SalesConfig,
): Promise<{ document: string; source: 'ai' | 'rules' }> {
  if (!hasAnthropic(env)) {
    return { document: buildRuleBasedPipDocument(rep, pip, evaluation), source: 'rules' };
  }
  try {
    const text = await callAnthropic(env, {
      model: config.coachModel,
      system: PIP_SYSTEM,
      user: buildPipUserPrompt(rep, pip, evaluation),
      maxTokens: 2000,
    });
    if (!text.trim()) throw new Error('empty PIP document');
    return { document: text.trim(), source: 'ai' };
  } catch (err) {
    console.error('[sales] PIP document AI generation failed, using template:', err);
    return { document: buildRuleBasedPipDocument(rep, pip, evaluation), source: 'rules' };
  }
}
