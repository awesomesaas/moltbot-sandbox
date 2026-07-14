import { describe, it, expect } from 'vitest';
import { resolveAnthropic, hasAnthropic, extractJson } from './anthropic';

describe('resolveAnthropic', () => {
  it('prefers an Anthropic AI Gateway route', () => {
    const r = resolveAnthropic({
      AI_GATEWAY_API_KEY: 'gw-key',
      AI_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/',
    });
    expect(r).toEqual({
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic',
      apiKey: 'gw-key',
    });
  });

  it('ignores a non-Anthropic gateway and falls back to direct key', () => {
    const r = resolveAnthropic({
      AI_GATEWAY_API_KEY: 'gw-key',
      AI_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/acct/gw/openai',
      ANTHROPIC_API_KEY: 'direct',
    });
    expect(r?.apiKey).toBe('direct');
    expect(r?.baseUrl).toBe('https://api.anthropic.com');
  });

  it('returns null with no credentials', () => {
    expect(resolveAnthropic({})).toBeNull();
    expect(hasAnthropic({})).toBe(false);
  });
});

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });

  it('parses JSON inside a code fence with surrounding prose', () => {
    const text = 'Here you go:\n```json\n{"a": 1, "b": [2,3]}\n```\nDone.';
    expect(extractJson<{ a: number; b: number[] }>(text)).toEqual({ a: 1, b: [2, 3] });
  });

  it('ignores braces inside strings', () => {
    expect(extractJson<{ s: string }>('prefix {"s": "a}b{c"} suffix')).toEqual({ s: 'a}b{c' });
  });

  it('throws when no JSON is present', () => {
    expect(() => extractJson('no json here')).toThrow();
  });
});
