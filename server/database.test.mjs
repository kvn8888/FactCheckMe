// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDatabase, normalizeFactCheckResult } from './database.mjs';

describe('fact-check normalization', () => {
  it('clamps confidence and normalizes unsupported verdicts', () => {
    expect(normalizeFactCheckResult({
      claim: 'A claim.',
      verdict: 'mostly',
      confidence: 250,
      explanation: '',
      sources: [],
    })).toEqual({
      claim: 'A claim.',
      verdict: 'unverifiable',
      confidence: 100,
      explanation: '',
      sources: [],
    });

    expect(normalizeFactCheckResult({
      claim: 'Another claim.',
      verdict: 'true',
      confidence: -12,
    }).confidence).toBe(0);
  });
});

describe('SQLite persistence', () => {
  it('persists normalized fact-check results and updates session stats', () => {
    const database = createDatabase(':memory:');
    const session = database.createSession();

    const saved = database.saveFactCheck({
      claim: 'The Eiffel Tower is in Berlin.',
      verdict: 'unsupported',
      confidence: 999,
      explanation: 'Incorrect city.',
      sources: [{ title: 'Source', url: 'https://example.com', domain: 'example.com' }],
    }, session.id, true);

    expect(saved.verdict).toBe('unverifiable');
    expect(saved.confidence).toBe(100);
    expect(saved.fromCache).toBe(true);

    const facts = database.getFacts(1);
    expect(facts).toHaveLength(1);
    expect(facts[0].sources).toEqual([
      { title: 'Source', url: 'https://example.com', domain: 'example.com' },
    ]);

    const stats = database.getStats();
    expect(stats.totalChecked).toBe(1);
    expect(stats.unverifiableCount).toBe(1);
    expect(stats.sessions[0].claimsChecked).toBe(1);

    database.close();
  });
});
