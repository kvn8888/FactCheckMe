// Sentence boundaries are syntactic candidates, not a decision that a claim is
// factual. Keep common titles/initialisms intact and include closing quotation
// marks. Western punctuation needs whitespace/end; CJK terminators do not.
export function sentenceBoundaries(text: string): number[] {
  const boundaries: number[] = [];
  for (const match of text.matchAll(/(?:[.!?]+["'’”»）)\]]*(?=\s|$)|[。！？]+["'’”»）)\]]*)/g)) {
    const end = match.index! + match[0].length;
    const word = text.slice(0, end).match(/\S+$/)?.[0].replace(/["'’”»）)\]]+$/, '') || '';
    if (/^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|Inc|Ltd|Corp|Co|Ph\.D|Jan|Feb|Mar|Apr|Aug|Sept|Oct|Nov|Dec|e\.g|i\.e|[A-Z]|(?:[A-Za-z]\.)+[A-Za-z])\.$/i.test(word)) continue;
    boundaries.push(end);
  }
  return boundaries;
}

export const normalizeSentence = (sentence: string) =>
  sentence.trim().replace(/\s+/g, ' ').toLowerCase();

export const consumeCompleteSentences = (buffer: string) => {
  const sentences: string[] = [];
  let consumedThrough = 0;
  for (const end of sentenceBoundaries(buffer)) {
    const sentence = buffer.slice(consumedThrough, end).trim();
    if (sentence) sentences.push(sentence);
    consumedThrough = end;
  }
  return { sentences, remainder: buffer.slice(consumedThrough).trimStart() };
};
