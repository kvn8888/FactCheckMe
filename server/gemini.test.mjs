// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  extractGroundingSources,
  extractJsonObject,
  normalizeModelSources,
} from './gemini.mjs';

describe('Gemini response parsing', () => {
  it('extracts JSON from fenced model output', () => {
    expect(extractJsonObject('```json\n{"hasClaim":true,"claim":"The Earth is round."}\n```')).toEqual({
      hasClaim: true,
      claim: 'The Earth is round.',
    });
  });

  it('rejects malformed model output', () => {
    expect(() => extractJsonObject('not json')).toThrow('Gemini model returned unparseable JSON');
  });
});

describe('Gemini grounding source handling', () => {
  it('uses grounding chunks as canonical sources and removes duplicates', () => {
    const candidate = {
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: 'https://example.com/a', title: 'Example A' } },
          { web: { uri: 'https://example.com/a', title: 'Duplicate A' } },
          { web: { uri: 'https://news.example.org/story', title: 'News Source' } },
          { web: { title: 'Missing URL' } },
        ],
      },
    };

    expect(extractGroundingSources(candidate)).toEqual([
      {
        title: 'Example A',
        url: 'https://example.com/a',
        domain: 'example.com',
      },
      {
        title: 'News Source',
        url: 'https://news.example.org/story',
        domain: 'news.example.org',
      },
    ]);
  });

  it('falls back to valid model-provided URLs when grounding chunks are absent', () => {
    expect(normalizeModelSources([
      { title: 'Valid', url: 'https://valid.example/path' },
      { title: 'No URL' },
      { title: 'URI field', uri: 'https://uri.example/item', domain: 'custom.example' },
    ])).toEqual([
      {
        title: 'Valid',
        url: 'https://valid.example/path',
        domain: 'valid.example',
      },
      {
        title: 'URI field',
        url: 'https://uri.example/item',
        domain: 'custom.example',
      },
    ]);
  });
});
