import type { TranscriptChunk } from '@/types/factCheck';
import { sentenceBoundaries } from '@/lib/sentences';

export interface TranscriptSpan { id: string; text: string; start: number; end: number; chunkIds: string[]; final: boolean }

// File-transcription punctuation at a six-second boundary is not proof that a
// speaker finished a claim. Keep that boundary inside one revisable span.
export function transcriptSpans(transcript: string, chunks: TranscriptChunk[], finished = false, incompleteBoundaryEnds?: ReadonlySet<number>): TranscriptSpan[] {
  const chunkEnds = new Map(chunks.map((chunk, index) => [chunk.end, index]));
  const spans: TranscriptSpan[] = [];
  let start = 0;
  const add = (end: number, final: boolean) => {
    while (start < end && /\s/.test(transcript[start])) start++;
    while (end > start && /\s/.test(transcript[end - 1])) end--;
    if (end <= start) return;
    spans.push({ id: `span-${start}`, text: transcript.slice(start, end), start, end, final,
      chunkIds: chunks.filter(chunk => chunk.start < end && chunk.end > start).map(chunk => chunk.id) });
    start = end;
  };
  const boundaries = new Set<number>();
  for (const end of sentenceBoundaries(transcript)) {
    const chunkIndex = chunkEnds.get(end);
    // Allow a bounded two-chunk group to settle only after lookahead arrives.
    // Otherwise a stream with punctuation only at cuts becomes one huge claim.
    if (chunkIndex !== undefined && chunks[chunkIndex].source !== 'turn' &&
        (chunkIndex % 2 === 0 || end === transcript.length)) continue;
    if (!incompleteBoundaryEnds?.has(end)) boundaries.add(end);
  }
  for (const chunk of chunks) {
    if (chunk.source === 'turn' && !incompleteBoundaryEnds?.has(chunk.end)) boundaries.add(chunk.end);
  }
  boundaries.add(transcript.length);
  for (const boundary of [...boundaries].sort((a, b) => a - b)) {
    // Keep every character mapped, even a very long unpunctuated utterance.
    // Bounded neighboring context carries meaning across these API-size cuts.
    while (boundary - start > 1900) {
      let cut = transcript.lastIndexOf(' ', start + 1900);
      if (cut <= start) cut = start + 1900;
      add(cut, true);
    }
    add(boundary, finished || boundary < transcript.length);
  }
  return spans;
}

export function contextForSpan(transcript: string, span: { start: number; end: number }, limit = 6000): string {
  const start = Math.max(0, Math.min(span.start - 2000, transcript.length - limit));
  return transcript.slice(start, start + limit);
}
