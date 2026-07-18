import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveAnthropic, hasAnthropic, extractJson, callAnthropic } from './anthropic';

/** Build a minimal fetch Response stand-in for the parts callAnthropic uses. */
function mockResponse(opts: { ok?: boolean; status?: number; json?: unknown; text?: string }) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.json,
    text: async () => opts.text ?? '',
  } as Response;
}

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

describe('callAnthropic', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts a correctly shaped request and returns the text output', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      mockResponse({ json: { content: [{ type: 'text', text: 'coaching output' }] } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await callAnthropic(
      { ANTHROPIC_API_KEY: 'sk-test' },
      { model: 'claude-opus-4-8', system: 'sys', user: 'usr', maxTokens: 123 },
    );

    expect(out).toBe('coaching output');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-test');
    expect((init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: 'claude-opus-4-8',
      max_tokens: 123,
      system: 'sys',
      messages: [{ role: 'user', content: 'usr' }],
    });
  });

  it('routes through an Anthropic AI Gateway when configured', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      mockResponse({ json: { content: [{ type: 'text', text: 'ok' }] } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await callAnthropic(
      {
        AI_GATEWAY_API_KEY: 'gw',
        AI_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic',
      },
      { model: 'm', system: 's', user: 'u' },
    );

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages',
    );
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ ok: false, status: 500, text: 'boom' })));
    await expect(callAnthropic({ ANTHROPIC_API_KEY: 'k' }, { model: 'm', system: 's', user: 'u' })).rejects.toThrow(
      /500/,
    );
  });

  it('throws when the response has no text content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ json: { content: [] } })));
    await expect(callAnthropic({ ANTHROPIC_API_KEY: 'k' }, { model: 'm', system: 's', user: 'u' })).rejects.toThrow();
  });

  it('throws without credentials before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(callAnthropic({}, { model: 'm', system: 's', user: 'u' })).rejects.toThrow(/credentials/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
