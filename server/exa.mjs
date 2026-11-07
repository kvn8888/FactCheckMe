import { ApiError } from './errors.mjs';

// Lite is cached-only. Current facts explicitly use auto with a fresh fetch.
// https://exa.ai/docs/search/quickstart
export function normalizeExaResults(results) {
  if (!Array.isArray(results)) throw new ApiError(502, 'provider_error', 'Exa returned an invalid search response');
  const seen = new Set();
  return results.flatMap((item) => {
    let url;
    try { url = new URL(item?.url); } catch { return []; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) return [];
    const excerpt = (Array.isArray(item.highlights)
      ? item.highlights.filter((entry) => typeof entry === 'string').join('\n')
      : typeof item.text === 'string' ? item.text : '').trim().slice(0, 6000);
    if (!excerpt) return [];
    seen.add(url.href);
    return [{
      title: typeof item.title === 'string' && item.title.trim() ? item.title.slice(0, 300) : url.hostname,
      url: url.href, domain: url.hostname.replace(/^www\./, ''), excerpt,
      publishedDate: typeof item.publishedDate === 'string' ? item.publishedDate : null,
    }];
  }).slice(0, 5).map((item, index) => ({ id: index + 1, ...item }));
}

export async function searchEvidence(query, {
  fresh = false, signal, fetchImpl = globalThis.fetch, env = process.env,
} = {}) {
  if (!env.EXA_API_KEY) throw new ApiError(503, 'configuration_error', 'Exa is not configured');
  if (typeof query !== 'string' || !query.trim() || query.length > 2000) {
    throw new ApiError(400, 'invalid_claim', 'Search query must contain 1–2000 characters');
  }
  const configuredType = env.EXA_SEARCH_TYPE || 'lite';
  if (!['lite', 'auto'].includes(configuredType)) {
    throw new ApiError(503, 'configuration_error', 'EXA_SEARCH_TYPE must be lite or auto');
  }
  const type = fresh ? 'auto' : configuredType;
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  try {
    const response = await fetchImpl('https://api.exa.ai/search', {
      method: 'POST', redirect: 'error', signal: requestSignal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.EXA_API_KEY}` },
      body: JSON.stringify({ query: query.trim(), type, numResults: 5,
        contents: { highlights: true, ...(fresh ? { maxAgeHours: 0 } : {}) } }),
    });
    if (!response.ok) throw new ApiError(502, 'provider_error', 'Exa search request failed');
    const raw = await response.json();
    return { sources: normalizeExaResults(raw.results), metadata: { provider: 'exa', searchType: type, freshRequested: fresh } };
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    if (error instanceof ApiError) throw error;
    if (requestSignal.aborted) throw new ApiError(504, 'provider_timeout', 'Exa search timed out');
    throw new ApiError(502, 'provider_error', 'Exa search request failed');
  }
}
