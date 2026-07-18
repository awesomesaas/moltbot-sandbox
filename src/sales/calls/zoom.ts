/**
 * Zoom Cloud Recording call-analytics adapter.
 *
 * Live shape (requires a Zoom server-to-server OAuth app with scopes
 * `recording:read:admin` / `user:read:admin`, and audio transcription enabled
 * so recordings include a `transcript`/`audio_transcript` VTT file):
 *   1. token: POST https://zoom.us/oauth/token?grant_type=account_credentials
 *   2. list:  GET  /users/{userId}/recordings?from=...&to=...
 *   3. fetch: download the transcript file, parse VTT → segments → talk ratio.
 *
 * The transcript parsing (`parseVtt` / `talkRatio`) is fully unit-tested; the
 * HTTP wiring is inert until credentials are provided.
 */

import { addWeeks, normalizeWeek } from '../dates';
import { parseVtt, talkRatio, repSpeakerMatcher } from './transcript';
import type { CallAnalyticsProvider, CallRepRef, RawCall } from './provider';

export interface ZoomEnv {
  ZOOM_ACCOUNT_ID?: string;
  ZOOM_CLIENT_ID?: string;
  ZOOM_CLIENT_SECRET?: string;
}

const ZOOM_API = 'https://api.zoom.us/v2';
const ZOOM_OAUTH = 'https://zoom.us/oauth/token';

interface ZoomRecordingFile {
  recording_type?: string;
  file_type?: string;
  download_url?: string;
}
interface ZoomMeeting {
  uuid: string;
  topic?: string;
  start_time?: string;
  duration?: number; // minutes
  recording_files?: ZoomRecordingFile[];
}

export class ZoomCallProvider implements CallAnalyticsProvider {
  readonly name = 'zoom';
  private accessToken: string | null = null;

  constructor(private env: ZoomEnv) {}

  private creds(): { accountId: string; clientId: string; clientSecret: string } {
    const { ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET } = this.env;
    if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) {
      throw new Error('Zoom adapter requires ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, and ZOOM_CLIENT_SECRET.');
    }
    return { accountId: ZOOM_ACCOUNT_ID, clientId: ZOOM_CLIENT_ID, clientSecret: ZOOM_CLIENT_SECRET };
  }

  private async token(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const { accountId, clientId, clientSecret } = this.creds();
    const basic = btoa(`${clientId}:${clientSecret}`);
    const res = await fetch(`${ZOOM_OAUTH}?grant_type=account_credentials&account_id=${accountId}`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}` },
    });
    if (!res.ok) throw new Error(`Zoom OAuth failed: ${res.status}`);
    const data = (await res.json()) as { access_token: string };
    this.accessToken = data.access_token;
    return this.accessToken;
  }

  private async api<T>(path: string): Promise<T> {
    const res = await fetch(`${ZOOM_API}${path}`, {
      headers: { authorization: `Bearer ${await this.token()}` },
    });
    if (!res.ok) throw new Error(`Zoom API ${res.status} for ${path}`);
    return (await res.json()) as T;
  }

  async fetchCalls(weekOf: string, reps: CallRepRef[]): Promise<RawCall[]> {
    const week = normalizeWeek(weekOf);
    const from = week;
    const to = addWeeks(week, 1);
    const calls: RawCall[] = [];

    for (const rep of reps) {
      if (!rep.email) continue; // Zoom user lookup is by email
      const isRep = repSpeakerMatcher([rep.name, rep.email]);
      const data = await this.api<{ meetings: ZoomMeeting[] }>(
        `/users/${encodeURIComponent(rep.email)}/recordings?from=${from}&to=${to}&page_size=100`,
      );
      for (const m of data.meetings ?? []) {
        const transcriptFile = (m.recording_files ?? []).find(
          (f) => f.file_type === 'TRANSCRIPT' || f.recording_type === 'audio_transcript',
        );
        if (!transcriptFile?.download_url) continue;
        const vttRes = await fetch(`${transcriptFile.download_url}?access_token=${await this.token()}`);
        if (!vttRes.ok) continue;
        const segments = parseVtt(await vttRes.text());
        calls.push({
          id: m.uuid,
          repId: rep.repId,
          date: (m.start_time ?? `${week}T00:00:00Z`).slice(0, 10),
          durationSec: (m.duration ?? 0) * 60,
          talkRatio: talkRatio(segments, isRep),
          title: m.topic,
          transcript: undefined, // fetched above; not retained beyond ratio unless AI analysis runs
        });
      }
    }
    return calls;
  }
}
