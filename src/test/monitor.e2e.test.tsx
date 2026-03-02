import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Monitor from '@/pages/Monitor';

vi.mock('@/hooks/useFactChecker', () => ({
  useFactChecker: () => ({
    isProcessing: false,
    results: [
      {
        id: '1',
        claim: 'The moon is made of cheese',
        verdict: 'false',
        confidence: 95,
        timestamp: new Date(),
        sources: [],
      },
      {
        id: '2',
        claim: 'Inflation is down this month',
        verdict: 'partial',
        confidence: 60,
        timestamp: new Date(),
        sources: [],
      },
    ],
    status: {
      isActive: true,
      startedAt: new Date(),
      sentencesProcessed: 2,
      claimsDetected: 2,
      factsChecked: 2,
    },
    processText: vi.fn(),
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
  }),
}));

vi.mock('@/hooks/useElevenLabsSTT', () => ({
  useElevenLabsSTT: () => ({
    isListening: true,
    isConnecting: false,
    startListening: vi.fn(),
    stopListening: vi.fn(),
    partialTranscript: 'Listening...',
  }),
}));

describe('Monitor e2e transcript view', () => {
  it('renders transcript area and result feed together', () => {
    render(<Monitor />);

    expect(screen.getByText('📝 LIVE TRANSCRIPT')).toBeInTheDocument();
    expect(screen.getByText('📋 Recent Results')).toBeInTheDocument();
  });
});
