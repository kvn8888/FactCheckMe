import { describe, expect, it } from 'vitest';
import { consumeCompleteSentences, normalizeSentence } from '@/lib/sentences';

describe('consumeCompleteSentences', () => {
  it('holds partial speech until punctuation completes a sentence', () => {
    expect(consumeCompleteSentences('The Eiffel Tower is in')).toEqual({
      sentences: [],
      remainder: 'The Eiffel Tower is in',
    });

    expect(consumeCompleteSentences('The Eiffel Tower is in Berlin. The moon is')).toEqual({
      sentences: ['The Eiffel Tower is in Berlin.'],
      remainder: 'The moon is',
    });
  });

  it('returns multiple completed sentences and keeps trailing speech', () => {
    expect(consumeCompleteSentences('One sentence! Is this another? unfinished')).toEqual({
      sentences: ['One sentence!', 'Is this another?'],
      remainder: 'unfinished',
    });
  });
});

describe('normalizeSentence', () => {
  it('creates stable hashmap keys for repeated sentences', () => {
    expect(normalizeSentence('  There   are 50 states. ')).toBe('there are 50 states.');
  });
});
