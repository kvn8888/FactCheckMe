import { DEFAULT_GEMINI_MODEL, GEMINI_API_URL } from './config.mjs';

export const sanitizeClaimForPrompt = (claim) =>
  claim
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>`]/g, '')
    .trim();

export const getGeminiConfig = () => {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const apiBaseUrl = (process.env.GEMINI_API_BASE_URL || GEMINI_API_URL).replace(/\/+$/, '');
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  return {
    apiKey,
    apiBaseUrl,
    model: model.replace(/^models\//, ''),
  };
};

export const extractJsonObject = (content) => {
  const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('Gemini model returned unparseable JSON');
    }
    return JSON.parse(cleaned.slice(start, end + 1));
  }
};

export const hasGeminiCacheHit = (usage = {}) => {
  return Boolean(
    usage.cachedContentTokenCount > 0 ||
    usage.cached_content_token_count > 0,
  );
};

const buildClaimEvaluationPrompt = (sentence) => ({
  systemInstruction: `Decide whether the sentence contains a verifiable factual claim. Respond with ONLY JSON and no markdown.
If there is no verifiable factual claim, respond exactly: {"hasClaim": false}
If there is a verifiable factual claim, respond exactly: {"hasClaim": true, "claim": "the concise factual claim"}
Do not fact-check the claim yet. Do not use outside knowledge. Only classify the sentence.`,
  userText: `Sentence: "${sentence}"`,
});

const buildGroundedFactCheckPrompt = (safeClaim) => ({
  systemInstruction: `You are a real-time fact-checker. Use native Google Search grounding before deciding factual claims. Respond with ONLY a JSON object and no markdown.
If the text has no verifiable factual claim, respond exactly: {"hasClaim": false}
If there IS a factual claim, respond with this exact JSON format:
{"hasClaim": true, "claim": "extracted claim", "verdict": "true", "confidence": 85, "explanation": "brief explanation", "sources": [{"title": "Source", "url": "https://...", "domain": "example.com"}]}
verdict must be one of: "true", "false", "partial", "unverifiable"
confidence must be 0-100
Use source URLs only when they are available from Google Search grounding. Do not invent URLs. If source evidence is insufficient, use verdict "unverifiable".`,
  userText: `Claim to verify: "${safeClaim}"`,
});

export const extractGeminiContent = (raw) =>
  raw.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || '')
    .join('')
    .trim() || '';

export const domainFromUrl = (url, fallback = '') => {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    if (hostname === 'vertexaisearch.cloud.google.com' && fallback) return fallback;
    return hostname;
  } catch {
    return fallback;
  }
};

export const extractGroundingSources = (candidate = {}) => {
  const chunks = candidate.groundingMetadata?.groundingChunks || [];
  const seen = new Set();

  return chunks
    .map((chunk) => {
      const web = chunk.web || {};
      const url = web.uri;
      if (!url || seen.has(url)) return null;
      seen.add(url);

      return {
        title: web.title || domainFromUrl(url, 'Source') || 'Source',
        url,
        domain: domainFromUrl(url, web.title || ''),
      };
    })
    .filter(Boolean);
};

export const normalizeModelSources = (sources = []) =>
  sources
    .map((source) => {
      const url = source?.url || source?.uri;
      if (!url || typeof url !== 'string') return null;
      return {
        title: source.title || domainFromUrl(url, 'Source') || 'Source',
        url,
        domain: source.domain || domainFromUrl(url, source.title || ''),
      };
    })
    .filter(Boolean);

export async function callGemini({
  config,
  systemInstruction,
  userText,
  useGoogleSearch = false,
  temperature = 0.3,
}) {
  const response = await fetch(`${config.apiBaseUrl}/models/${encodeURIComponent(config.model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: userText }],
        },
      ],
      ...(useGoogleSearch ? { tools: [{ google_search: {} }] } : {}),
      generationConfig: {
        temperature,
        candidateCount: 1,
      },
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${message}`);
  }

  const raw = await response.json();
  const candidate = raw.candidates?.[0] || {};
  const content = extractGeminiContent(raw);
  if (!content) throw new Error('No text response from Gemini API');

  return {
    raw,
    candidate,
    content,
    metadata: {
      model: raw.modelVersion || config.model,
      provider: 'google',
      usage: raw.usageMetadata,
      fromCache: hasGeminiCacheHit(raw.usageMetadata),
      grounding: candidate.groundingMetadata
        ? {
            webSearchQueries: candidate.groundingMetadata.webSearchQueries || [],
            sourceCount: extractGroundingSources(candidate).length,
          }
        : undefined,
    },
  };
}

export async function evaluateClaimSentence(sentence, config = getGeminiConfig()) {
  const prompt = buildClaimEvaluationPrompt(sentence);
  const response = await callGemini({
    config,
    ...prompt,
    temperature: 0,
  });

  return {
    result: extractJsonObject(response.content),
    metadata: response.metadata,
  };
}

export async function makeGeminiFactCheck(claim, config = getGeminiConfig()) {
  const safeClaim = sanitizeClaimForPrompt(claim);
  const evaluation = await evaluateClaimSentence(safeClaim, config);
  if (evaluation.result.hasClaim !== true) {
    return {
      result: { hasClaim: false },
      metadata: {
        ...evaluation.metadata,
        mode: 'gemini-claim-evaluation',
      },
    };
  }

  const extractedClaim = sanitizeClaimForPrompt(evaluation.result.claim || safeClaim);
  const prompt = buildGroundedFactCheckPrompt(extractedClaim);
  const grounded = await callGemini({
    config,
    ...prompt,
    useGoogleSearch: true,
    temperature: 0.3,
  });
  const result = extractJsonObject(grounded.content);
  const groundingSources = extractGroundingSources(grounded.candidate);
  const modelSources = normalizeModelSources(result.sources);

  return {
    result: {
      ...result,
      claim: result.claim || extractedClaim,
      sources: groundingSources.length > 0 ? groundingSources : modelSources,
    },
    metadata: {
      ...grounded.metadata,
      mode: 'gemini-google-search',
      sourceCount: groundingSources.length,
      claimEvaluation: evaluation.metadata,
    },
  };
}
