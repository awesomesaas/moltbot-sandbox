/**
 * Google Meet call-analytics adapter.
 *
 * Live shape (requires Google Workspace with Meet transcripts enabled and an
 * OAuth token with the Meet REST scopes):
 *   1. list conferences: GET https://meet.googleapis.com/v2/conferenceRecords
 *   2. list transcripts: GET .../conferenceRecords/{id}/transcripts
 *   3. list entries:     GET .../transcripts/{id}/entries  (participant + timing)
 *      → convert entries to segments → talk ratio.
 *
 * Meet transcript entries carry per-participant start/end times, so talk ratio
 * comes straight from them (no VTT parsing needed). Inert without a token.
 */

import { addWeeks, normalizeWeek } from '../dates';
import { talkRatio, repSpeakerMatcher, type TranscriptSegment } from './transcript';
import type { CallAnalyticsProvider, CallRepRef, RawCall } from './provider';

export interface GoogleMeetEnv {
  /** OAuth access token with Meet REST scopes (short-lived; refresh upstream). */
  GOOGLE_MEET_ACCESS_TOKEN?: string;
}

const MEET_API = 'https://meet.googleapis.com/v2';

interface MeetTranscriptEntry {
  participant?: string;
  text?: string;
  startTime?: string; // RFC3339
  endTime?: string;
}

/** Convert Meet transcript entries to speaker segments (times relative to first entry). */
export function meetEntriesToSegments(entries: MeetTranscriptEntry[]): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  let base = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e.startTime || !e.endTime || !e.participant) continue;
    const start = Date.parse(e.startTime) / 1000;
    const end = Date.parse(e.endTime) / 1000;
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    if (i === 0) base = start;
    segs.push({ speaker: e.participant, startSec: start - base, endSec: end - base });
  }
  return segs;
}

export class GoogleMeetCallProvider implements CallAnalyticsProvider {
  readonly name = 'google_meet';

  constructor(private env: GoogleMeetEnv) {}

  private token(): string {
    if (!this.env.GOOGLE_MEET_ACCESS_TOKEN) {
      throw new Error('Google Meet adapter requires GOOGLE_MEET_ACCESS_TOKEN.');
    }
    return this.env.GOOGLE_MEET_ACCESS_TOKEN;
  }

  private async api<T>(path: string): Promise<T> {
    const res = await fetch(`${MEET_API}${path}`, {
      headers: { authorization: `Bearer ${this.token()}` },
    });
    if (!res.ok) throw new Error(`Google Meet API ${res.status} for ${path}`);
    return (await res.json()) as T;
  }

  async fetchCalls(weekOf: string, reps: CallRepRef[]): Promise<RawCall[]> {
    const week = normalizeWeek(weekOf);
    const start = `${week}T00:00:00Z`;
    const end = `${addWeeks(week, 1)}T00:00:00Z`;
    const calls: RawCall[] = [];

    // Conference records for the week (space.name maps to the organizer/rep upstream).
    const filter = encodeURIComponent(`start_time>="${start}" AND start_time<"${end}"`);
    const conf = await this.api<{ conferenceRecords?: Array<{ name: string; space?: string }> }>(
      `/conferenceRecords?filter=${filter}`,
    );

    for (const record of conf.conferenceRecords ?? []) {
      const transcripts = await this.api<{ transcripts?: Array<{ name: string }> }>(
        `/${record.name}/transcripts`,
      );
      for (const t of transcripts.transcripts ?? []) {
        const entriesResp = await this.api<{ transcriptEntries?: MeetTranscriptEntry[] }>(
          `/${t.name}/entries?pageSize=1000`,
        );
        const segments = meetEntriesToSegments(entriesResp.transcriptEntries ?? []);
        // Attribute the conference to a rep by matching a speaker to their identity.
        const rep = reps.find((r) => {
          const isRep = repSpeakerMatcher([r.name, r.email]);
          return segments.some((s) => isRep(s.speaker));
        });
        if (!rep) continue;
        const isRep = repSpeakerMatcher([rep.name, rep.email]);
        const totalSec = segments.reduce((a, s) => a + Math.max(0, s.endSec - s.startSec), 0);
        calls.push({
          id: t.name,
          repId: rep.repId,
          date: week,
          durationSec: Math.round(totalSec),
          talkRatio: talkRatio(segments, isRep),
        });
      }
    }
    return calls;
  }
}
