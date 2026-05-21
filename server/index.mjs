import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
const DB_PATH = process.env.SQLITE_PATH || path.join(DATA_DIR, 'factcheckme.sqlite');
const DEFAULT_CONFIDENCE = 75;
const MISTRAL_API_URL = 'https://api.mistral.ai/v1';
const DEFAULT_MISTRAL_TTS_MODEL = 'voxtral-mini-tts-2603';
const DEFAULT_MISTRAL_TRANSCRIPTION_MODEL = 'voxtral-mini-latest';
const DEFAULT_TTS_RESPONSE_FORMAT = 'mp3';

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS fact_check_sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    claims_checked INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS fact_check_results (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES fact_check_sessions(id) ON DELETE CASCADE,
    claim TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('true', 'false', 'partial', 'unverifiable')),
    confidence INTEGER NOT NULL DEFAULT 75,
    explanation TEXT,
    sources TEXT NOT NULL DEFAULT '[]',
    from_cache INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_fact_check_results_created_at
    ON fact_check_results(created_at DESC);
`);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
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

const parseSources = (value) => {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const toResult = (row) => ({
  id: row.id,
  claim: row.claim,
  verdict: row.verdict,
  confidence: row.confidence,
  explanation: row.explanation || undefined,
  sources: parseSources(row.sources),
  timestamp: row.created_at,
  fromCache: Boolean(row.from_cache),
});

const sanitizeClaimForPrompt = (claim) =>
  claim
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>`]/g, '')
    .trim();

const getTrueFoundryConfig = () => {
  const apiKey = process.env.TRUEFOUNDRY_API_KEY;
  const gatewayBaseUrl = process.env.TRUEFOUNDRY_GATEWAY_BASE_URL?.replace(/\/+$/, '');
  const model = process.env.TRUEFOUNDRY_MODEL_ID;

  if (!apiKey) throw new Error('TRUEFOUNDRY_API_KEY is not configured');
  if (!gatewayBaseUrl) throw new Error('TRUEFOUNDRY_GATEWAY_BASE_URL is not configured');
  if (!model) throw new Error('TRUEFOUNDRY_MODEL_ID is not configured');

  return {
    apiKey,
    gatewayBaseUrl,
    model,
    agentAppId: process.env.TRUEFOUNDRY_AGENT_APP_ID || null,
    mcpServerFqn: process.env.TRUEFOUNDRY_MCP_SERVER_FQN || null,
    mcpServerUrl: process.env.TRUEFOUNDRY_MCP_SERVER_URL || null,
    mcpAuthToken: process.env.TRUEFOUNDRY_MCP_AUTH_TOKEN || apiKey,
    tavilyApiKey: process.env.TAVILY_API_KEY || null,
    mcpToolNames: (process.env.TRUEFOUNDRY_MCP_TOOL_NAMES || '')
      .split(',')
      .map((tool) => tool.trim())
      .filter(Boolean),
    agentIterationLimit: Math.min(
      20,
      Math.max(1, Number(process.env.TRUEFOUNDRY_AGENT_ITERATION_LIMIT) || 5),
    ),
  };
};

const extractJsonObject = (content) => {
  const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('TrueFoundry model returned unparseable JSON');
    }
    return JSON.parse(cleaned.slice(start, end + 1));
  }
};

const hasGatewayCacheHit = (usage = {}) => {
  const promptDetails = usage.prompt_tokens_details || {};
  return Boolean(
    promptDetails.cached_tokens > 0 ||
    usage.cache_read_input_tokens > 0 ||
    usage.cache_creation_input_tokens > 0,
  );
};

const shouldUseTrueFoundryAgent = ({ agentAppId, mcpServerFqn, mcpServerUrl }) =>
  Boolean(process.env.TRUEFOUNDRY_AGENT_USE_TOOL_CALLS === 'true' && (agentAppId || mcpServerFqn || mcpServerUrl));

const buildFactCheckMessages = (safeClaim) => [
  {
    role: 'system',
    content: `You are a real-time fact-checker. Use Tavily MCP/web search tools before deciding factual claims. Respond with ONLY a JSON object and no markdown.
If the text has no verifiable factual claim, respond exactly: {"hasClaim": false}
If there IS a factual claim, use Tavily search results and respond with this exact JSON format:
{"hasClaim": true, "claim": "extracted claim", "verdict": "true", "confidence": 85, "explanation": "brief explanation", "sources": [{"title": "Source", "url": "https://...", "domain": "example.com"}]}
verdict must be one of: "true", "false", "partial", "unverifiable"
confidence must be 0-100
Include real URLs from Tavily-backed search results in sources. If source URLs are unavailable, return an empty sources array rather than inventing URLs.`,
  },
  {
    role: 'user',
    content: `Claim to verify: "${safeClaim}"`,
  },
];

const buildSourcedFactCheckMessages = (safeClaim, sources) => [
  {
    role: 'system',
    content: `You are a real-time fact-checker. Use only the provided Tavily MCP search context for sourced claims. Respond with ONLY a JSON object and no markdown.
If the text has no verifiable factual claim, respond exactly: {"hasClaim": false}
If there IS a factual claim, respond with this exact JSON format:
{"hasClaim": true, "claim": "extracted claim", "verdict": "true", "confidence": 85, "explanation": "brief explanation", "sources": [{"title": "Source", "url": "https://...", "domain": "example.com"}]}
verdict must be one of: "true", "false", "partial", "unverifiable"
confidence must be 0-100
Only include source URLs present in the Tavily MCP context. If the context is insufficient, use verdict "unverifiable".`,
  },
  {
    role: 'user',
    content: `Claim to verify: "${safeClaim}"

Tavily MCP search context:
${JSON.stringify(sources, null, 2)}`,
  },
];

const parseGatewayContent = async (response) => {
  const body = await response.text();
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('text/event-stream') || body.trimStart().startsWith('data:')) {
    let content = '';
    let lastChunk = null;

    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;

      try {
        const chunk = JSON.parse(data);
        lastChunk = chunk;
        content += chunk.choices?.[0]?.delta?.content || '';
        content += chunk.choices?.[0]?.message?.content || '';
      } catch {
        // Ignore keepalive or non-JSON SSE lines.
      }
    }

    return {
      raw: lastChunk || {},
      content,
    };
  }

  const raw = body ? JSON.parse(body) : {};
  return {
    raw,
    content: raw.choices?.[0]?.message?.content || raw.choices?.[0]?.delta?.content || raw.output_text || '',
  };
};

const buildMcpServers = ({ mcpServerFqn, mcpServerUrl, mcpAuthToken, mcpToolNames }) => {
  if (!mcpServerFqn && !mcpServerUrl) return [];

  const server = {
    enable_all_tools: mcpToolNames.length === 0,
    headers: {
      Authorization: `Bearer ${mcpAuthToken}`,
    },
  };

  if (mcpServerFqn) server.integration_fqn = mcpServerFqn;
  if (mcpServerUrl) server.url = mcpServerUrl;
  if (mcpToolNames.length > 0) {
    server.tools = mcpToolNames.map((name) => ({ name }));
  }

  return [server];
};

const parseEventStreamJson = (body) => {
  let parsed = null;

  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    parsed = JSON.parse(data);
  }

  return parsed;
};

const postMcpJsonRpc = async ({ url, headers, payload }) => {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  const parsed = response.headers.get('content-type')?.includes('text/event-stream')
    ? parseEventStreamJson(body)
    : body
      ? JSON.parse(body)
      : null;

  if (!response.ok || parsed?.error) {
    const message = parsed?.error?.message || body || `MCP request failed with ${response.status}`;
    throw new Error(`TrueFoundry MCP error (${response.status}): ${message}`);
  }

  return { response, parsed };
};

async function callTavilySearchViaMcp(claim, config) {
  if (!config.mcpServerUrl) return [];

  const headers = {
    Authorization: `Bearer ${config.mcpAuthToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  if (config.tavilyApiKey) {
    headers['x-tfy-mcp-headers'] = JSON.stringify({
      Authorization: `Bearer ${config.tavilyApiKey}`,
    });
  }

  const { response: initResponse } = await postMcpJsonRpc({
    url: config.mcpServerUrl,
    headers,
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'FactCheckMe', version: '1.0.0' },
      },
    },
  });

  const sessionId = initResponse.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('TrueFoundry MCP did not return a session id');

  const sessionHeaders = { ...headers, 'mcp-session-id': sessionId };
  await fetch(config.mcpServerUrl, {
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  const { parsed } = await postMcpJsonRpc({
    url: config.mcpServerUrl,
    headers: sessionHeaders,
    payload: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'tavily_search',
        arguments: {
          query: `${claim} fact check`,
          max_results: 5,
          search_depth: 'advanced',
        },
      },
    },
  });

  const text = parsed?.result?.content?.find((item) => item.type === 'text')?.text || '{}';
  const result = JSON.parse(text);
  if (result.error) throw new Error(`Tavily MCP search failed: ${result.detail || result.error}`);

  return (result.results || []).map((source) => ({
    title: source.title || source.url || 'Source',
    url: source.url,
    domain: source.url ? new URL(source.url).hostname.replace(/^www\./, '') : '',
    content: source.content || source.snippet || '',
    score: source.score,
  })).filter((source) => source.url);
}

const getMistralConfig = () => {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY is not configured');

  return {
    apiKey,
    model: process.env.MISTRAL_TTS_MODEL || DEFAULT_MISTRAL_TTS_MODEL,
    voiceId: process.env.MISTRAL_TTS_VOICE_ID || null,
    refAudioPath: process.env.MISTRAL_TTS_REF_AUDIO_PATH || null,
    responseFormat: process.env.MISTRAL_TTS_RESPONSE_FORMAT || DEFAULT_TTS_RESPONSE_FORMAT,
  };
};

const getAudioMimeType = (format) => {
  const mimeTypes = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    pcm: 'audio/L16',
    flac: 'audio/flac',
    opus: 'audio/opus',
  };
  return mimeTypes[format] || 'audio/mpeg';
};

async function synthesizeSpeech(input) {
  const { apiKey, model, voiceId, refAudioPath, responseFormat } = getMistralConfig();
  const trimmedInput = input.trim();
  if (!trimmedInput) throw new Error('Text is required');
  if (trimmedInput.length > 4000) throw new Error('Text is too long for speech generation');

  const body = {
    model,
    input: trimmedInput,
    response_format: responseFormat,
  };

  if (voiceId) {
    body.voice_id = voiceId;
  } else if (refAudioPath) {
    if (!existsSync(refAudioPath)) {
      throw new Error(`MISTRAL_TTS_REF_AUDIO_PATH does not exist: ${refAudioPath}`);
    }
    body.ref_audio = readFileSync(refAudioPath).toString('base64');
  } else {
    throw new Error('MISTRAL_TTS_VOICE_ID or MISTRAL_TTS_REF_AUDIO_PATH is required');
  }

  const response = await fetch(`${MISTRAL_API_URL}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Mistral TTS error (${response.status}): ${message}`);
  }

  const data = await response.json();
  if (!data.audio_data) throw new Error('Mistral TTS response did not include audio data');

  return {
    audioData: data.audio_data,
    mimeType: getAudioMimeType(responseFormat),
    model,
  };
}

async function transcribeAudio(audioData, mimeType) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY is not configured');
  if (!audioData || typeof audioData !== 'string') throw new Error('Audio data is required');

  const audioBuffer = Buffer.from(audioData, 'base64');
  if (audioBuffer.length === 0) throw new Error('Audio data is empty');

  const extension = mimeType.includes('mp4')
    ? 'mp4'
    : mimeType.includes('ogg')
      ? 'ogg'
      : mimeType.includes('wav')
        ? 'wav'
        : 'webm';
  const blob = new Blob([audioBuffer], { type: mimeType || 'audio/webm' });
  const formData = new FormData();
  formData.append('model', process.env.MISTRAL_TRANSCRIPTION_MODEL || DEFAULT_MISTRAL_TRANSCRIPTION_MODEL);
  formData.append('file', blob, `speech.${extension}`);
  formData.append('language', process.env.MISTRAL_TRANSCRIPTION_LANGUAGE || 'en');

  const response = await fetch(`${MISTRAL_API_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Mistral transcription error (${response.status}): ${message}`);
  }

  const data = await response.json();
  return {
    text: data.text || '',
    language: data.language || null,
    model: data.model || process.env.MISTRAL_TRANSCRIPTION_MODEL || DEFAULT_MISTRAL_TRANSCRIPTION_MODEL,
  };
}

async function makeGatewayFactCheck(claim) {
  const config = getTrueFoundryConfig();
  const { apiKey, gatewayBaseUrl, model } = config;
  const safeClaim = sanitizeClaimForPrompt(claim);
  const mcpSearchSources = await callTavilySearchViaMcp(safeClaim, config);
  const messages = mcpSearchSources.length > 0
    ? buildSourcedFactCheckMessages(safeClaim, mcpSearchSources)
    : buildFactCheckMessages(safeClaim);
  const useAgent = shouldUseTrueFoundryAgent(config);
  const endpoint = config.agentAppId
    ? `${gatewayBaseUrl}/agent/${config.agentAppId}/responses`
    : useAgent
      ? `${gatewayBaseUrl}/agent/responses`
      : `${gatewayBaseUrl}/chat/completions`;
  const body = config.agentAppId
    ? {
        iteration_limit: config.agentIterationLimit,
        response_format: { type: 'json_object' },
        messages,
        stream: false,
      }
    : useAgent
      ? {
          model,
          iteration_limit: config.agentIterationLimit,
          response_format: { type: 'json_object' },
          messages,
          mcp_servers: buildMcpServers(config),
          temperature: 0.3,
          stream: false,
        }
      : {
          model,
          temperature: 0.3,
          response_format: { type: 'json_object' },
          messages,
        };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-TFY-METADATA': JSON.stringify({
        app: 'FactCheckMe',
        feature: 'fact-check',
        mode: useAgent ? 'agent-mcp' : 'chat',
      }),
      'X-TFY-LOGGING-CONFIG': JSON.stringify({ enabled: true }),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`TrueFoundry Gateway error (${response.status}): ${message}`);
  }

  const { raw: gatewayResponse, content } = await parseGatewayContent(response);
  if (!content) throw new Error('No response from TrueFoundry Gateway');

  return {
    result: extractJsonObject(content),
    metadata: {
      model: gatewayResponse.model || model,
      provider: gatewayResponse.provider,
      usage: gatewayResponse.usage,
      fromCache: hasGatewayCacheHit(gatewayResponse.usage),
      mode: mcpSearchSources.length > 0 ? 'mcp-search-chat' : useAgent ? 'agent-mcp' : 'chat',
      mcp: mcpSearchSources.length > 0
        ? {
            server: config.mcpServerUrl,
            tools: ['tavily_search'],
            sourceCount: mcpSearchSources.length,
          }
        : useAgent
        ? {
            agentAppId: config.agentAppId || undefined,
            server: config.mcpServerFqn || config.mcpServerUrl || undefined,
            tools: config.mcpToolNames,
          }
        : undefined,
    },
  };
}

function saveFactCheck(result, sessionId, fromCache = false) {
  const id = randomUUID();
  const claim = result.claim;
  const verdict = ['true', 'false', 'partial', 'unverifiable'].includes(result.verdict)
    ? result.verdict
    : 'unverifiable';
  const confidence = Math.min(100, Math.max(0, Number(result.confidence) || DEFAULT_CONFIDENCE));
  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO fact_check_results (
      id, session_id, claim, verdict, confidence, explanation, sources, from_cache, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    sessionId || null,
    claim,
    verdict,
    confidence,
    result.explanation || '',
    JSON.stringify(result.sources || []),
    fromCache ? 1 : 0,
    createdAt,
  );

  if (sessionId) {
    db.prepare(`
      UPDATE fact_check_sessions
      SET claims_checked = claims_checked + 1
      WHERE id = ?
    `).run(sessionId);
  }

  return {
    id,
    claim,
    verdict,
    confidence,
    explanation: result.explanation || '',
    sources: result.sources || [],
    timestamp: createdAt,
    fromCache,
  };
}

async function route(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      database: DB_PATH,
      trueFoundryConfigured: Boolean(
        process.env.TRUEFOUNDRY_API_KEY &&
        process.env.TRUEFOUNDRY_GATEWAY_BASE_URL &&
        process.env.TRUEFOUNDRY_MODEL_ID,
      ),
      trueFoundryAgentConfigured: Boolean(
        process.env.TRUEFOUNDRY_AGENT_APP_ID ||
        process.env.TRUEFOUNDRY_MCP_SERVER_FQN ||
        process.env.TRUEFOUNDRY_MCP_SERVER_URL,
      ),
      mistralTtsConfigured: Boolean(process.env.MISTRAL_API_KEY),
      mistralTranscriptionConfigured: Boolean(process.env.MISTRAL_API_KEY),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/facts') {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const rows = db.prepare(`
      SELECT * FROM fact_check_results
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
    return json(res, 200, rows.map(toResult));
  }

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    const verdictRows = db.prepare(`
      SELECT verdict, COUNT(*) AS count
      FROM fact_check_results
      GROUP BY verdict
    `).all();
    const counts = Object.fromEntries(verdictRows.map((row) => [row.verdict, row.count]));
    const sessions = db.prepare(`
      SELECT id, started_at, ended_at, claims_checked
      FROM fact_check_sessions
      ORDER BY started_at DESC
      LIMIT 10
    `).all();

    return json(res, 200, {
      totalChecked: Object.values(counts).reduce((sum, count) => sum + count, 0),
      trueCount: counts.true || 0,
      falseCount: counts.false || 0,
      partialCount: counts.partial || 0,
      unverifiableCount: counts.unverifiable || 0,
      sessions: sessions.map((session) => ({
        id: session.id,
        startedAt: session.started_at,
        endedAt: session.ended_at,
        claimsChecked: session.claims_checked,
      })),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions') {
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO fact_check_sessions (id, started_at)
      VALUES (?, ?)
    `).run(id, startedAt);
    return json(res, 201, { id, startedAt });
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/sessions\/[^/]+\/end$/)) {
    const sessionId = url.pathname.split('/')[3];
    db.prepare(`
      UPDATE fact_check_sessions
      SET ended_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), sessionId);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/clear') {
    db.exec('DELETE FROM fact_check_results; DELETE FROM fact_check_sessions;');
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/text-to-speech') {
    const { text } = await readJson(req);
    if (!text || typeof text !== 'string') {
      return json(res, 400, { error: 'Text is required' });
    }

    const speech = await synthesizeSpeech(text);
    return json(res, 200, speech);
  }

  if (req.method === 'POST' && url.pathname === '/api/transcribe') {
    const { audioData, mimeType } = await readJson(req);
    const transcription = await transcribeAudio(audioData, mimeType || 'audio/webm');
    return json(res, 200, transcription);
  }

  if (req.method === 'POST' && url.pathname === '/api/fact-check') {
    const { claim, sessionId } = await readJson(req);
    if (!claim || typeof claim !== 'string' || !claim.trim()) {
      return json(res, 400, { error: 'Claim text is required' });
    }

    const { result: factCheckResult, metadata } = await makeGatewayFactCheck(claim);
    if (factCheckResult.hasClaim === false) return json(res, 200, { noClaim: true });

    const normalized = {
      claim: factCheckResult.claim || claim.trim(),
      verdict: factCheckResult.verdict,
      confidence: factCheckResult.confidence,
      explanation: factCheckResult.explanation || '',
      sources: factCheckResult.sources || [],
    };

    return json(res, 200, {
      ...saveFactCheck(normalized, sessionId, metadata.fromCache),
      gateway: metadata,
    });
  }

  return json(res, 404, { error: 'Not found' });
}

createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error(error);
    json(res, 500, { error: error instanceof Error ? error.message : 'Unknown error' });
  });
}).listen(PORT, HOST, () => {
  console.log(`FactCheckMe API listening on http://${HOST}:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
});
