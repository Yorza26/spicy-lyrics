// deno-lint-ignore-file no-explicit-any
import { SpotifyFetch } from "../../components/Global/SpotifyFetch.ts";
import Logger from "../Logger.ts";

const transcriptLogger = new Logger("Transcript Pipeline");

/**
 * A single spoken line, in the same shape the "Line" lyrics applyer consumes.
 * `Type: "Vocal"` lets ProcessLyrics romanize non-Latin transcripts, exactly as
 * it does for line-synced lyrics. StartTime/EndTime are in **seconds** (the
 * applyer runs them through ConvertTime, which multiplies by 1000).
 */
type TranscriptLine = {
  Type: "Vocal";
  Text: string;
  StartTime: number;
  EndTime: number;
  OppositeAligned: false;
};

/** Line-typed lyrics payload built from a podcast transcript. */
export type TranscriptData = {
  Type: "Line";
  Content: TranscriptLine[];
  StartTime: number;
  source: "spt";
  id: string;
};

/** Trailing time (seconds) given to the final line, which has no "next start". */
const LAST_LINE_TAIL_SECONDS = 5;

/**
 * Spotify only ships a per-episode transcript endpoint. Different builds spell
 * the sections array and the timestamp/​text fields slightly differently, so we
 * read each defensively rather than assuming one shape.
 */
function extractSections(payload: any): any[] {
  if (Array.isArray(payload?.section)) return payload.section;
  if (Array.isArray(payload?.sections)) return payload.sections;
  return [];
}

/** startMs may arrive as a plain number or as `{ value: number }`. */
function readStartMs(section: any): number | null {
  const raw = section?.startMs ?? section?.startMillis ?? section?.startTime;
  const value = typeof raw === "object" && raw !== null ? raw.value : raw;
  const ms = Number(value);
  return Number.isFinite(ms) ? ms : null;
}

/** The spoken text lives under `text.sentence.text`; fall back to plainer shapes. */
function readText(section: any): string {
  const candidate =
    section?.text?.sentence?.text ??
    section?.text?.text ??
    (typeof section?.text === "string" ? section.text : undefined) ??
    section?.sentence?.text;
  return typeof candidate === "string" ? candidate.trim() : "";
}

/**
 * Fetch and normalise a podcast episode's transcript into "Line" lyrics data.
 *
 * @param episodeId The bare episode id (`uri.split(":")[2]`).
 * @returns The transcript as Line lyrics, or `null` when none is available.
 */
export async function fetchTranscript(episodeId: string): Promise<TranscriptData | null> {
  transcriptLogger.debug("Transcript requested", episodeId);

  let response: Response;
  try {
    response = await SpotifyFetch(
      `https://spclient.wg.spotify.com/transcript-read-along/v2/episode/${episodeId}?format=json`
    );
  } catch (error) {
    transcriptLogger.error("Transcript request failed", error);
    return null;
  }

  // 404 (no transcript) is the common, expected miss — anything non-OK yields no
  // transcript. The caller turns `null` into the user-facing "not found" notice.
  if (!response.ok) {
    transcriptLogger.debug("Transcript not available", { status: response.status });
    return null;
  }

  let payload: any;
  try {
    payload = await response.json();
  } catch (error) {
    transcriptLogger.error("Failed to parse transcript response", error);
    return null;
  }

  const sections = extractSections(payload);
  if (sections.length === 0) {
    transcriptLogger.debug("Transcript contained no sections");
    return null;
  }

  // Keep only timestamped, non-empty spoken lines, in chronological order.
  const timedLines = sections
    .map((section) => ({ startMs: readStartMs(section), text: readText(section) }))
    .filter((line): line is { startMs: number; text: string } =>
      line.startMs !== null && line.text.length > 0
    )
    .sort((a, b) => a.startMs - b.startMs);

  if (timedLines.length === 0) {
    transcriptLogger.debug("Transcript had no usable timed lines");
    return null;
  }

  const Content: TranscriptLine[] = timedLines.map((line, index, arr) => {
    const startSeconds = line.startMs / 1000;
    // Each line runs until the next one starts; the last one gets a short tail.
    const endSeconds =
      index + 1 < arr.length ? arr[index + 1].startMs / 1000 : startSeconds + LAST_LINE_TAIL_SECONDS;
    return {
      Type: "Vocal",
      Text: line.text,
      StartTime: startSeconds,
      EndTime: endSeconds,
      OppositeAligned: false,
    };
  });

  return {
    Type: "Line",
    Content,
    StartTime: Content[0].StartTime,
    source: "spt",
    id: episodeId,
  };
}
