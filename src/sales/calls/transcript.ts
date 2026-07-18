/**
 * Transcript parsing and talk-ratio computation. Pure and testable — this is
 * the core the Zoom/Meet adapters rely on. Talk ratio needs no ML: the
 * platforms already diarize (label speakers), so we just sum per-speaker
 * durations from the timestamped transcript.
 */

export interface TranscriptSegment {
  speaker: string;
  startSec: number;
  endSec: number;
}

/** Parse a WEBVTT timestamp (HH:MM:SS.mmm or MM:SS.mmm) to seconds. */
export function parseVttTimestamp(ts: string): number {
  const parts = ts.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return NaN;
  const nums = parts.map(Number);
  if (nums.some((n) => Number.isNaN(n))) return NaN;
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  return nums[0] * 60 + nums[1];
}

/**
 * Parse a WEBVTT transcript (Zoom's `transcript.vtt` format) into speaker
 * segments. Cue text is expected as "Speaker Name: spoken words".
 */
export function parseVtt(vtt: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const lines = vtt.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const arrow = line.indexOf('-->');
    if (arrow === -1) continue;
    const startSec = parseVttTimestamp(line.slice(0, arrow));
    const endSec = parseVttTimestamp(line.slice(arrow + 3));
    if (Number.isNaN(startSec) || Number.isNaN(endSec) || endSec < startSec) continue;
    // The cue text is on the following non-empty line(s).
    const text = (lines[i + 1] ?? '').trim();
    const colon = text.indexOf(':');
    if (colon === -1) continue;
    const speaker = text.slice(0, colon).trim();
    if (speaker) segments.push({ speaker, startSec, endSec });
  }
  return segments;
}

/**
 * Fraction of total speaking time attributable to the rep. `isRep` decides
 * whether a given speaker label is the rep (name or email match). Returns 0
 * when there is no speech.
 */
export function talkRatio(segments: TranscriptSegment[], isRep: (speaker: string) => boolean): number {
  let repSec = 0;
  let totalSec = 0;
  for (const s of segments) {
    const dur = Math.max(0, s.endSec - s.startSec);
    totalSec += dur;
    if (isRep(s.speaker)) repSec += dur;
  }
  return totalSec > 0 ? repSec / totalSec : 0;
}

/** Longest contiguous run of rep speech, in seconds (a monologue proxy). */
export function longestMonologueSec(
  segments: TranscriptSegment[],
  isRep: (speaker: string) => boolean,
): number {
  let longest = 0;
  let run = 0;
  let runStart = 0;
  let inRun = false;
  for (const s of segments) {
    if (isRep(s.speaker)) {
      if (!inRun) {
        inRun = true;
        runStart = s.startSec;
      }
      run = s.endSec - runStart;
      if (run > longest) longest = run;
    } else {
      inRun = false;
    }
  }
  return Math.round(longest);
}

/**
 * Build a speaker matcher for a rep from their known identifiers (name,
 * email). Case-insensitive; matches when a transcript speaker label contains
 * any identifier (or vice versa).
 */
export function repSpeakerMatcher(identifiers: Array<string | undefined>): (speaker: string) => boolean {
  const ids = identifiers
    .filter((x): x is string => !!x && x.trim().length > 0)
    .map((x) => x.toLowerCase());
  return (speaker: string): boolean => {
    const s = speaker.toLowerCase();
    return ids.some((id) => s.includes(id) || id.includes(s));
  };
}
