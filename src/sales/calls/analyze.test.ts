import { describe, it, expect, vi, afterEach } from 'vitest';
import { analyzeTranscript } from './analyze';
import { GoogleMeetCallProvider, meetEntriesToSegments } from './meet';
import { ZoomCallProvider } from './zoom';
import { resolveConfig } from '../config';

const config = resolveConfig({});

function stubText(text: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text }] }),
      text: async () => '',
    })),
  );
}

describe('analyzeTranscript', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns null without Anthropic credentials (no network call)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await analyzeTranscript({}, config, 'Rep: hi', 'Rep');
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses valid insight JSON', async () => {
    stubText(
      JSON.stringify({
        questionsAsked: 4,
        longestMonologueSec: 90,
        nextStepSecured: true,
        missedObjections: ['pricing'],
        summary: 'Balanced discovery call.',
      }),
    );
    const out = await analyzeTranscript({ ANTHROPIC_API_KEY: 'k' }, config, 'transcript', 'Rep');
    expect(out).toEqual({
      questionsAsked: 4,
      longestMonologueSec: 90,
      nextStepSecured: true,
      missedObjections: ['pricing'],
      summary: 'Balanced discovery call.',
    });
  });

  it('coerces missing/invalid fields to safe defaults', async () => {
    stubText(JSON.stringify({ questionsAsked: 'lots', nextStepSecured: 'yes' }));
    const out = await analyzeTranscript({ ANTHROPIC_API_KEY: 'k' }, config, 'transcript', 'Rep');
    expect(out).toMatchObject({ questionsAsked: 0, nextStepSecured: false, missedObjections: [] });
  });

  it('returns null on API error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' })));
    expect(await analyzeTranscript({ ANTHROPIC_API_KEY: 'k' }, config, 't', 'Rep')).toBeNull();
  });
});

describe('meetEntriesToSegments', () => {
  it('converts Meet transcript entries to relative-time segments', () => {
    const segs = meetEntriesToSegments([
      { participant: 'Rep', startTime: '2026-07-13T10:00:00Z', endTime: '2026-07-13T10:00:10Z' },
      { participant: 'Prospect', startTime: '2026-07-13T10:00:10Z', endTime: '2026-07-13T10:00:16Z' },
    ]);
    expect(segs).toEqual([
      { speaker: 'Rep', startSec: 0, endSec: 10 },
      { speaker: 'Prospect', startSec: 10, endSec: 16 },
    ]);
  });
});

describe('live provider stubs require credentials', () => {
  it('Zoom throws without credentials', async () => {
    await expect(new ZoomCallProvider({}).fetchCalls('2026-07-13', [{ repId: 'r', name: 'R', email: 'r@x.com' }])).rejects.toThrow(
      /ZOOM_/,
    );
  });
  it('Google Meet throws without a token', async () => {
    await expect(new GoogleMeetCallProvider({}).fetchCalls('2026-07-13', [{ repId: 'r', name: 'R' }])).rejects.toThrow(
      /GOOGLE_MEET/,
    );
  });
});
