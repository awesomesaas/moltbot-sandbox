/**
 * Optional AI transcript analysis. Extracts richer call insights (questions
 * asked, longest monologue, next-step secured, missed objections) that the
 * raw talk ratio can't capture. Best-effort: returns null when Anthropic
 * isn't configured or the response is unusable — the ratio-based trigger works
 * without it.
 *
 * Transcripts are analyzed in-memory and never persisted; only the derived
 * CallInsights are stored.
 */

import type { CallInsights } from '../types';
import type { SalesConfig } from '../config';
import { callAnthropic, extractJson, hasAnthropic, type AnthropicEnv } from '../anthropic';

const SYSTEM = `You analyze a single sales call transcript and extract objective, structured signals a sales manager can coach on.
Count only what is present in the transcript. Do not invent details.
Respond with ONLY a JSON object matching this shape:
{
  "questionsAsked": number,          // discovery/qualifying questions the REP asked
  "longestMonologueSec": number,     // best estimate of the rep's longest uninterrupted stretch, in seconds
  "nextStepSecured": boolean,        // did the rep secure a concrete next step (meeting/decision)?
  "missedObjections": string[],      // prospect concerns the rep did not address
  "summary": string                  // one sentence on the call's dynamics
}`;

function coerce(raw: unknown): CallInsights {
  const o = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    questionsAsked: Math.max(0, Math.round(num(o.questionsAsked))),
    longestMonologueSec: Math.max(0, Math.round(num(o.longestMonologueSec))),
    nextStepSecured: o.nextStepSecured === true,
    missedObjections: Array.isArray(o.missedObjections)
      ? o.missedObjections.filter((x): x is string => typeof x === 'string').slice(0, 10)
      : [],
    summary: typeof o.summary === 'string' ? o.summary.trim() : '',
  };
}

/**
 * Analyze one transcript into CallInsights. Returns null when Anthropic is
 * unavailable or the call fails — callers keep the talk-ratio-only record.
 */
export async function analyzeTranscript(
  env: AnthropicEnv,
  config: SalesConfig,
  transcript: string,
  repName: string,
): Promise<CallInsights | null> {
  if (!hasAnthropic(env) || !transcript.trim()) return null;
  try {
    const text = await callAnthropic(env, {
      model: config.coachModel,
      system: SYSTEM,
      user: `Rep on the call: ${repName}\n\nTranscript:\n${transcript}`,
      maxTokens: 700,
    });
    return coerce(extractJson(text));
  } catch (err) {
    console.error('[sales] transcript analysis failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
