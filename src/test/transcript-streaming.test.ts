import { describe, expect, it } from 'vitest';
import { transcriptSpans, contextForSpan } from '@/lib/transcript';
import type { TranscriptChunk } from '@/types/factCheck';
const transcript = (...texts: string[]) => {
  let text = '';
  const chunks: TranscriptChunk[] = texts.map((value, index) => {
    const start = text.length + (text ? 1 : 0);
    text += (text ? ' ' : '') + value;
    return { id: `chunk-${index}`, index, text: value, start, end: text.length, receivedAt: new Date() };
  });
  return { text, chunks };
};
describe('streaming transcript spans', () => {
  it('revises a partial claim instead of marking its text as permanently checked', () => {
    const first = transcript('The moon is made');
    const next = transcript('The moon is made', 'of cheese. This is a fake claim.');
    const initial = transcriptSpans(first.text, first.chunks);
    const completed = transcriptSpans(next.text, next.chunks);
    expect(initial[0]).toMatchObject({ id: 'span-0', text: 'The moon is made', final: false });
    expect(completed[0]).toMatchObject({ id: 'span-0', text: 'The moon is made of cheese.', final: true, chunkIds: ['chunk-0', 'chunk-1'] });
  });
  it('does not mistake provider punctuation at an audio cut for a full claim', () => {
    const { text, chunks } = transcript('The moon is made.', 'Of cheese. That is the assertion.');
    expect(transcriptSpans(text, chunks)[0].text).toBe('The moon is made. Of cheese.');
  });

  it('settles bounded chunk groups once following context arrives', () => {
    const { text, chunks } = transcript('First claim.', 'Second claim.', 'Third claim.');
    expect(transcriptSpans(text, chunks).map(span => [span.text, span.final])).toEqual([
      ['First claim. Second claim.', true], ['Third claim.', false],
    ]);
  });
  it('keeps repeated occurrences separate and maps them to exact offsets', () => {
    const { text, chunks } = transcript('It is false. It is false.');
    const spans = transcriptSpans(text, chunks, true);
    expect(spans).toHaveLength(2); expect(spans[0].id).not.toBe(spans[1].id);
    for (const span of spans) expect(text.slice(span.start, span.end)).toBe(span.text);
  });
  it('keeps abbreviations and decimals together', () => {
    const { text, chunks } = transcript('Dr. Smith measured 3.14 meters. The U.S. is large.');
    expect(transcriptSpans(text, chunks, true).map(span => span.text)).toEqual(['Dr. Smith measured 3.14 meters.', 'The U.S. is large.']);
  });
  it('never drops long unpunctuated speech and keeps API inputs within bounds', () => {
    const { text, chunks } = transcript('word '.repeat(2000).trim());
    const spans = transcriptSpans(text, chunks, true);
    expect(spans.map(span => span.text).join(' ')).toBe(text);
    for (const span of spans) {
      expect(span.text.length).toBeLessThanOrEqual(1900);
      const context = contextForSpan(text, span);
      expect(context.length).toBeLessThanOrEqual(6000); expect(context).toContain(span.text);
      expect(text.slice(span.start, span.end)).toBe(span.text);
    }
  });
});
