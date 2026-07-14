/**
 * Minimal Anthropic Messages API client used by the coaching layer.
 *
 * The worker deliberately avoids the Anthropic SDK (small Workers bundle,
 * and it must honor the project's existing AI Gateway vs direct-Anthropic
 * URL routing). This is a single `fetch` against POST /v1/messages.
 */

/** Env fields relevant to resolving Anthropic credentials. */
export interface AnthropicEnv {
  AI_GATEWAY_API_KEY?: string;
  AI_GATEWAY_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
}

interface Resolved {
  baseUrl: string;
  apiKey: string;
}

/**
 * Resolve base URL + key, preferring AI Gateway when configured for an
 * Anthropic provider, then a direct Anthropic key. Returns null when no
 * usable credentials are present (callers fall back to rule-based output).
 */
export function resolveAnthropic(env: AnthropicEnv): Resolved | null {
  const stripSlashes = (u: string): string => u.replace(/\/+$/, '');

  if (env.AI_GATEWAY_API_KEY && env.AI_GATEWAY_BASE_URL) {
    const base = stripSlashes(env.AI_GATEWAY_BASE_URL);
    // AI Gateway URLs are provider-scoped; only use it here for Anthropic.
    if (base.toLowerCase().includes('anthropic')) {
      return { baseUrl: base, apiKey: env.AI_GATEWAY_API_KEY };
    }
  }

  if (env.ANTHROPIC_API_KEY) {
    return {
      baseUrl: stripSlashes(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'),
      apiKey: env.ANTHROPIC_API_KEY,
    };
  }

  return null;
}

/** True when the module can reach Anthropic (or an AI Gateway Anthropic route). */
export function hasAnthropic(env: AnthropicEnv): boolean {
  return resolveAnthropic(env) !== null;
}

export interface MessageRequest {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}

/**
 * Send a single-turn message and return the concatenated text output.
 * Throws on transport or non-2xx responses; callers decide whether to
 * fall back.
 */
export async function callAnthropic(env: AnthropicEnv, req: MessageRequest): Promise<string> {
  const resolved = resolveAnthropic(env);
  if (!resolved) {
    throw new Error('No Anthropic credentials configured');
  }

  const res = await fetch(`${resolved.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': resolved.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens ?? 2048,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Anthropic request failed: ${res.status} ${detail.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
  };

  const text = (data.content || [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();

  if (!text) {
    throw new Error('Anthropic response contained no text');
  }
  return text;
}

/**
 * Extract the first JSON object/array from a model response. Models
 * sometimes wrap JSON in prose or code fences; this is tolerant of both.
 */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) {
    throw new Error('No JSON found in model response');
  }
  // Walk to the matching closing bracket for the opening one.
  const open = candidate[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return JSON.parse(candidate.slice(start, i + 1)) as T;
      }
    }
  }
  throw new Error('Unbalanced JSON in model response');
}
