const SENTENCE_PATTERN = /(.+?[.!?]+(?:["')\]]+)?)(?=\s|$)/gs;

export const normalizeSentence = (sentence: string) =>
  sentence
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

export const consumeCompleteSentences = (buffer: string) => {
  const sentences: string[] = [];
  let consumedThrough = 0;

  for (const match of buffer.matchAll(SENTENCE_PATTERN)) {
    const sentence = match[1].trim();
    if (sentence) sentences.push(sentence);
    consumedThrough = (match.index || 0) + match[0].length;
  }

  return {
    sentences,
    remainder: buffer.slice(consumedThrough).trimStart(),
  };
};
