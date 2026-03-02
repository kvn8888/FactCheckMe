import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const PORT = Number(process.env.PORT || 8787);
const HYPERSPELL_API_URL = 'https://api.hyperspell.com/v1';
const CACHE_SIMILARITY_THRESHOLD = 0.85;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey, x-supabase-client-platform',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const json = (res, statusCode, payload) => {
  res.writeHead(statusCode, corsHeaders);
  res.end(JSON.stringify(payload));
};

const readJson = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
};

async function searchHyperspellCache(claim, apiKey) {
  try {
    const response = await fetch(`${HYPERSPELL_API_URL}/memories/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query: claim, limit: 1 }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    const topResult = data.memories?.[0];
    if (topResult && topResult.score >= CACHE_SIMILARITY_THRESHOLD) {
      return JSON.parse(topResult.text);
    }
    return null;
  } catch {
    return null;
  }
}

async function addToHyperspellCache(result, apiKey) {
  try {
    await fetch(`${HYPERSPELL_API_URL}/memories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        text: JSON.stringify({
          claim: result.claim,
          verdict: result.verdict,
          confidence: result.confidence,
          explanation: result.explanation,
          sources: result.sources,
          checkedAt: new Date().toISOString(),
        }),
        metadata: { type: 'fact-check', verdict: result.verdict },
      }),
    });
  } catch {
    // non-blocking cache write
  }
}

const makeGeminiFactCheck = async (claim, apiKey) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: `You are a real-time fact-checker. Use Google Search to verify the following claim and respond with ONLY a JSON object (no markdown, no explanation outside JSON).
If the text has no verifiable factual claim, respond exactly: {"hasClaim": false}
If there IS a factual claim, search for it and respond with this exact JSON format:
{"hasClaim": true, "claim": "extracted claim", "verdict": "true", "confidence": 85, "explanation": "brief explanation", "sources": [{"title": "Source", "url": "https://...", "domain": "example.com"}]}
verdict must be one of: "true", "false", "partial", "unverifiable"
confidence must be 0-100
Include real URLs from your search results in sources.
Claim to verify: "${claim}"`,
        }],
      }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.3 },
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${message}`);
  }

  const aiResponse = await response.json();
  const content = aiResponse.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('No response from AI');

  const cleanContent = content.replace(/```json\n?|\n?```/g, '').trim();
  const parsed = JSON.parse(cleanContent);
  return parsed;
};

const getServerSupabase = () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return null;
  return createClient(supabaseUrl, serviceKey);
};

const handler = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/api/health') {
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && req.url === '/api/elevenlabs-scribe-token') {
    try {
      const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
      if (!elevenLabsKey) return json(res, 500, { error: 'ELEVENLABS_API_KEY is not configured' });

      const response = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
        method: 'POST',
        headers: { 'xi-api-key': elevenLabsKey },
      });

      if (!response.ok) {
        const message = await response.text();
        return json(res, 502, { error: `Failed to get scribe token: ${message}` });
      }

      const data = await response.json();
      return json(res, 200, { token: data.token });
    } catch (error) {
      return json(res, 500, { error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  if (req.method === 'POST' && req.url === '/api/fact-check') {
    try {
      const { claim, sessionId } = await readJson(req);
      if (!claim || typeof claim !== 'string' || !claim.trim()) {
        return json(res, 400, { error: 'Claim text is required' });
      }

      const geminiKey = process.env.GEMINI_API_KEY;
      if (!geminiKey) return json(res, 500, { error: 'GEMINI_API_KEY is not configured' });

      const hyperspellKey = process.env.HYPERSPELL_API_KEY;
      if (hyperspellKey) {
        const cached = await searchHyperspellCache(claim, hyperspellKey);
        if (cached) {
          return json(res, 200, {
            id: randomUUID(),
            claim: cached.claim,
            verdict: cached.verdict,
            confidence: cached.confidence,
            explanation: cached.explanation,
            sources: cached.sources || [],
            timestamp: new Date().toISOString(),
            fromCache: true,
          });
        }
      }

      const factCheckResult = await makeGeminiFactCheck(claim, geminiKey);
      if (factCheckResult.hasClaim === false) return json(res, 200, { noClaim: true });

      const validVerdicts = ['true', 'false', 'partial', 'unverifiable'];
      if (!validVerdicts.includes(factCheckResult.verdict)) {
        factCheckResult.verdict = 'unverifiable';
      }

      if (hyperspellKey) {
        await addToHyperspellCache(factCheckResult, hyperspellKey);
      }

      const claimText = factCheckResult.claim || claim.trim();
      const confidence = Math.min(100, Math.max(0, factCheckResult.confidence || 75));
      let savedResult = null;
      const supabase = getServerSupabase();

      if (supabase) {
        const insert = await supabase
          .from('fact_check_results')
          .insert({
            session_id: sessionId || null,
            claim: claimText,
            verdict: factCheckResult.verdict,
            confidence,
            explanation: factCheckResult.explanation || '',
            sources: factCheckResult.sources || [],
          })
          .select()
          .single();

        savedResult = insert.data ?? null;

        if (sessionId) {
          const session = await supabase
            .from('fact_check_sessions')
            .select('claims_checked')
            .eq('id', sessionId)
            .single();

          if (session.data) {
            await supabase
              .from('fact_check_sessions')
              .update({ claims_checked: (session.data.claims_checked || 0) + 1 })
              .eq('id', sessionId);
          }
        }
      }

      return json(res, 200, {
        id: savedResult?.id || randomUUID(),
        claim: claimText,
        verdict: factCheckResult.verdict,
        confidence,
        explanation: factCheckResult.explanation || '',
        sources: factCheckResult.sources || [],
        timestamp: savedResult?.created_at || new Date().toISOString(),
        fromCache: false,
      });
    } catch (error) {
      return json(res, 500, { error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  return json(res, 404, { error: 'Not found' });
};

createServer(handler).listen(PORT, () => {
  console.log(`FactCheckMe backend listening on :${PORT}`);
});
