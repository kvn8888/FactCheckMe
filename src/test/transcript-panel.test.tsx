import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TranscriptPanel } from '@/components/TranscriptPanel';
import { normalizeSentence } from '@/lib/sentences';
import type { FactCheckResult } from '@/types/factCheck';

const result = (claim: string, verdict: FactCheckResult['verdict']): FactCheckResult => ({
  id: verdict,
  claim,
  verdict,
  confidence: 92,
  timestamp: new Date('2026-06-02T12:00:00Z'),
  sources: [],
});

describe('TranscriptPanel', () => {
  it('highlights checked claims inline and leaves non-claims unmarked', () => {
    const trueClaim = 'The Earth orbits the Sun.';
    const falseClaim = 'The Eiffel Tower is in Berlin.';
    const misleadingClaim = 'Vitamin C always prevents colds.';
    const nonClaim = 'Thanks everyone for coming.';

    render(
      <TranscriptPanel
        sentences={[trueClaim, falseClaim, misleadingClaim, nonClaim]}
        partialTranscript="The moon is"
        sentenceFactChecks={{
          [normalizeSentence(trueClaim)]: result(trueClaim, 'true'),
          [normalizeSentence(falseClaim)]: result(falseClaim, 'false'),
          [normalizeSentence(misleadingClaim)]: result(misleadingClaim, 'partial'),
          [normalizeSentence(nonClaim)]: null,
        }}
        isListening
        onSelectFact={vi.fn()}
      />,
    );

    expect(screen.getByText('[TRUE]')).toBeInTheDocument();
    expect(screen.getByText('[FALSE]')).toBeInTheDocument();
    expect(screen.getByText('[MISLEADING]')).toBeInTheDocument();
    expect(screen.getByText(nonClaim).tagName).toBe('SPAN');
    expect(screen.getByText(/The moon is/)).toBeInTheDocument();
  });
});
