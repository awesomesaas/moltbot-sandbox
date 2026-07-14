import { describe, it, expect } from 'vitest';
import {
  parseVtt,
  parseVttTimestamp,
  talkRatio,
  longestMonologueSec,
  repSpeakerMatcher,
} from './transcript';

const VTT = `WEBVTT

1
00:00:00.000 --> 00:00:10.000
Alice Rep: Hi, thanks for joining today.

2
00:00:10.000 --> 00:00:16.000
Bob Prospect: Happy to be here.

3
00:00:16.000 --> 00:00:40.000
Alice Rep: Let me walk you through everything we do in detail.
`;

describe('parseVttTimestamp', () => {
  it('parses HH:MM:SS and MM:SS', () => {
    expect(parseVttTimestamp('00:01:30.000')).toBe(90);
    expect(parseVttTimestamp('01:30.000')).toBe(90);
    expect(parseVttTimestamp('02:00:00.000')).toBe(7200);
  });
  it('returns NaN for garbage', () => {
    expect(Number.isNaN(parseVttTimestamp('nope'))).toBe(true);
  });
});

describe('parseVtt', () => {
  it('extracts speaker segments with timings', () => {
    const segs = parseVtt(VTT);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ speaker: 'Alice Rep', startSec: 0, endSec: 10 });
    expect(segs[2].speaker).toBe('Alice Rep');
  });
});

describe('talkRatio', () => {
  it('computes rep share of speaking time', () => {
    const segs = parseVtt(VTT);
    const isRep = repSpeakerMatcher(['Alice Rep']);
    // Alice: 10 + 24 = 34; Bob: 6; total 40 → 0.85
    expect(talkRatio(segs, isRep)).toBeCloseTo(0.85);
  });
  it('returns 0 when there is no speech', () => {
    expect(talkRatio([], () => true)).toBe(0);
  });
});

describe('longestMonologueSec', () => {
  it('finds the longest uninterrupted rep run', () => {
    const segs = parseVtt(VTT);
    const isRep = repSpeakerMatcher(['Alice Rep']);
    // Runs: 0-10 (10s), then 16-40 (24s) → 24
    expect(longestMonologueSec(segs, isRep)).toBe(24);
  });
});

describe('repSpeakerMatcher', () => {
  it('matches by name or email, case-insensitively', () => {
    const isRep = repSpeakerMatcher(['Ava Chen', 'ava@example.com']);
    expect(isRep('ava chen')).toBe(true);
    expect(isRep('AVA@EXAMPLE.COM')).toBe(true);
    expect(isRep('Bob Prospect')).toBe(false);
  });
  it('ignores empty identifiers', () => {
    const isRep = repSpeakerMatcher([undefined, '']);
    expect(isRep('anyone')).toBe(false);
  });
});
