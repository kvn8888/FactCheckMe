import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import History from '@/pages/History';
import { localClear, localCreateSession, localSaveTranscript, localSaveFact, localEndSession } from '@/services/storage';

beforeEach(() => {
  const entries = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key) });
  localClear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('session history', () => {
  it('shows nonclaims and opens mapped evidence with original chunks', () => {
    const { id } = localCreateSession();
    const transcript = 'Hello there. Earth is round.';
    localSaveTranscript(id, { transcript, chunks: [{ id: 'chunk', index: 0, text: transcript, start: 0, end: transcript.length, receivedAt: new Date() }], segments: [
      { id: 'greeting', text: 'Hello there.', start: 0, end: 12, chunkIds: ['chunk'], revision: 1, status: 'no-claim', final: true },
      { id: 'earth', text: 'Earth is round.', start: 13, end: transcript.length, chunkIds: ['chunk'], revision: 1, status: 'checked', final: true, factId: 'fact' },
    ] });
    localSaveFact({ id: 'fact', claim: 'Earth is round.', verdict: 'true', confidence: 99, timestamp: new Date(), sources: [{ title: 'Evidence', url: 'https://example.com', domain: 'example.com' }], explanation: 'Supported by observations.', segmentId: 'earth', revision: 1 }, id);
    render(<History />);
    fireEvent.click(screen.getByRole('button', { name: 'Segment 14: Earth is round.' }));
    expect(screen.getByRole('button', { name: 'Segment 14: Earth is round.' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Supported by observations.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Evidence' })).toHaveAttribute('href', 'https://example.com');
    expect(screen.getByText('Original transcript chunks (1)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Segment 1: Hello there.' }));
    expect(screen.getByText('No checkable claim detected in this segment.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello there' } });
    expect(screen.getByText('Full transcript')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'missing text' } });
    expect(screen.getByText('NO RESULTS MATCH YOUR FILTERS')).toBeInTheDocument();
  });
  it('explains interrupted segments in ended sessions', () => {
    const { id } = localCreateSession();
    localSaveTranscript(id, { transcript: 'Unfinished', chunks: [], segments: [{ id: 'pending', text: 'Unfinished', start: 0, end: 10, chunkIds: [], revision: 1, status: 'pending', final: false }] });
    localEndSession(id);
    render(<History />);
    fireEvent.click(screen.getByRole('button', { name: 'Segment 1: Unfinished' }));
    expect(screen.getByText('This session ended before this segment was checked.')).toBeInTheDocument();
  });
  it('shows transcript-only sessions and unmapped legacy claims', () => {
    const { id } = localCreateSession();
    localSaveTranscript(id, { transcript: 'A friendly conversation', chunks: [], segments: [] });
    localSaveFact({ id: 'legacy', claim: 'Older claim', verdict: 'unverifiable', confidence: 0, timestamp: new Date(), sources: [] }, null);
    render(<History />);
    expect(screen.getByText('A friendly conversation')).toBeInTheDocument();
    expect(screen.getByText('Earlier claims without transcript mapping')).toBeInTheDocument();
    expect(screen.getByText('"Older claim"')).toBeInTheDocument();
  });
});
