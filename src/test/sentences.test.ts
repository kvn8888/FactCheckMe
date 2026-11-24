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

describe('sentence boundary edge cases', () => {
  it.each([
    ['Dr. Smith visited the U.S. yesterday. Next', ['Dr. Smith visited the U.S. yesterday.'], 'Next'],
    ['Prof. A. Smith measured 3.14 meters. Done!', ['Prof. A. Smith measured 3.14 meters.', 'Done!'], ''],
    ['Read example.com or email a@b.com. Then continue', ['Read example.com or email a@b.com.'], 'Then continue'],
    ['She said “It is true.” Is it?! (No.) tail', ['She said “It is true.”', 'Is it?!', '(No.)'], 'tail'],
    ['  First.\n\tSecond!  tail  ', ['First.', 'Second!'], 'tail  '],
    ['地球是圆的。真的吗？是的！', ['地球是圆的。', '真的吗？', '是的！'], ''],
    ['No punctuation: still speaking; not done', [], 'No punctuation: still speaking; not done'],
    ['', [], ''],
    ['  \n ', [], ''],
  ])('segments %j without losing the unfinished tail', (input, sentences, remainder) => {
    expect(consumeCompleteSentences(input as string)).toEqual({ sentences, remainder });
  });

  it('keeps a title split over streamed text attached to its subject', () => {
    const first = consumeCompleteSentences('The researcher was Dr.');
    expect(first.sentences).toEqual([]);
    expect(consumeCompleteSentences(`${first.remainder} Smith. Next`)).toEqual({
      sentences: ['The researcher was Dr. Smith.'], remainder: 'Next',
    });
  });
});
