import { DEFAULT_GEMINI_MODEL } from './config.mjs';
import { ApiError } from './errors.mjs';
import { corsHeaders, json, readJson } from './http-utils.mjs';
import { makeGeminiFactCheck } from './gemini.mjs';
import { synthesizeSpeech } from './mistral.mjs';

const isGeminiConfigured = () => Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
const isMistralConfigured = () => Boolean(process.env.MISTRAL_API_KEY);

export function createRouteHandler({ database, factCheck = makeGeminiFactCheck, speech = synthesizeSpeech }) {
  return async function route(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        database: database.path,
        geminiConfigured: isGeminiConfigured(),
        geminiModel: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
        geminiGoogleSearchConfigured: isGeminiConfigured(),
        mistralTtsConfigured: isMistralConfigured(),
        mistralRealtimeTranscriptionConfigured: isMistralConfigured(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/facts') {
      return json(res, 200, database.getFacts(url.searchParams.get('limit')));
    }

    if (req.method === 'GET' && url.pathname === '/api/stats') {
      return json(res, 200, database.getStats());
    }

    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      return json(res, 201, database.createSession());
    }

    if (req.method === 'POST' && url.pathname.match(/^\/api\/sessions\/[^/]+\/end$/)) {
      const sessionId = url.pathname.split('/')[3];
      return json(res, 200, database.endSession(sessionId));
    }

    if (req.method === 'POST' && url.pathname === '/api/clear') {
      return json(res, 200, database.clear());
    }

    if (req.method === 'POST' && url.pathname === '/api/text-to-speech') {
      const { text } = await readJson(req);
      if (!text || typeof text !== 'string') {
        throw new ApiError(400, 'missing_text', 'Text is required');
      }

      return json(res, 200, await speech(text));
    }

    if (req.method === 'POST' && url.pathname === '/api/fact-check') {
      const { claim, sessionId } = await readJson(req);
      if (!claim || typeof claim !== 'string' || !claim.trim()) {
        throw new ApiError(400, 'missing_claim', 'Claim text is required');
      }

      const { result: factCheckResult, metadata } = await factCheck(claim);
      if (factCheckResult.hasClaim === false) return json(res, 200, { noClaim: true });

      const normalized = {
        claim: factCheckResult.claim || claim.trim(),
        verdict: factCheckResult.verdict,
        confidence: factCheckResult.confidence,
        explanation: factCheckResult.explanation || '',
        sources: factCheckResult.sources || [],
      };

      return json(res, 200, {
        ...database.saveFactCheck(normalized, sessionId, metadata.fromCache),
        gemini: metadata,
      });
    }

    throw new ApiError(404, 'not_found', 'Not found');
  };
}
