import type { FactCheckResult } from '@/types/factCheck';

export type TranscriptTone = 'neutral' | 'misinformation' | 'clarification';

const MIN_CLAIM_LENGTH_FOR_SUBSTRING_MATCH = 25;
const MIN_CLAIM_WORDS_FOR_OVERLAP = 5;
const MIN_WORD_OVERLAP_RATIO = 0.7;

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const getWords = (value: string) => normalize(value).split(' ').filter(Boolean);

const isClaimMatch = (line: string, claim: string) => {
  const normalizedLine = normalize(line);
  const normalizedClaim = normalize(claim);

  if (!normalizedLine || !normalizedClaim) return false;
  if (normalizedLine === normalizedClaim) return true;

  if (
    normalizedClaim.length >= MIN_CLAIM_LENGTH_FOR_SUBSTRING_MATCH &&
    normalizedLine.includes(normalizedClaim)
  ) {
    return true;
  }

  const claimWords = getWords(claim);
  if (claimWords.length < MIN_CLAIM_WORDS_FOR_OVERLAP) return false;

  const lineWords = new Set(getWords(line));
  const overlap = claimWords.filter((word) => lineWords.has(word)).length;
  return overlap / claimWords.length >= MIN_WORD_OVERLAP_RATIO;
};

export function getTranscriptTone(text: string, results: FactCheckResult[]): TranscriptTone {
  const line = text.trim();
  if (!line) return 'neutral';

  let clarification = false;

  for (const result of results) {
    const claim = result.claim.trim();
    if (!claim) continue;

    const matches = isClaimMatch(line, claim);
    if (!matches) continue;

    if (result.verdict === 'false') {
      return 'misinformation';
    }

    if (result.verdict === 'partial' || result.verdict === 'unverifiable') {
      clarification = true;
    }
  }

  return clarification ? 'clarification' : 'neutral';
}
