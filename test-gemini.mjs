import { readFileSync } from 'node:fs';

const env = {};
try {
  const content = readFileSync('.env', 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...valueParts] = trimmed.split('=');
    env[key] = valueParts.join('=').replace(/^["']|["']$/g, '');
  }
} catch {
  // .env is optional for this script.
}

const API_BASE_URL = process.env.VITE_API_URL || env.VITE_API_URL || 'http://localhost:8787';
const claims = [
  { text: 'The Earth is round.', label: 'true claim' },
  { text: 'The Eiffel Tower is in Berlin.', label: 'false claim' },
  { text: 'Vitamin C always prevents colds.', label: 'misleading claim' },
  { text: 'Hello everyone, welcome back.', label: 'non-claim', expectNoClaim: true },
  { text: 'The Earth is round.', label: 'repeated completed sentence' },
];
const validVerdicts = new Set(['true', 'false', 'partial', 'unverifiable']);

const log = (message, color = 'reset') => {
  const colors = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    reset: '\x1b[0m',
  };
  console.log(`${colors[color]}${message}${colors.reset}`);
};

async function postJson(path, body) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Request failed with ${response.status}`);
  }
  return data;
}

async function getJson(path) {
  const response = await fetch(`${API_BASE_URL}${path}`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Request failed with ${response.status}`);
  }
  return data;
}

async function main() {
  log(`Testing local API: ${API_BASE_URL}`, 'cyan');
  log('Start the backend first with: npm run dev:api\n', 'yellow');

  const health = await getJson('/api/health');
  log(
    `Health: ok=${health.ok}, geminiConfigured=${health.geminiConfigured}, geminiGoogleSearchConfigured=${health.geminiGoogleSearchConfigured}`,
    'cyan',
  );
  if (!health.geminiConfigured) {
    throw new Error('GEMINI_API_KEY is not configured. Add a Gemini API key to .env before running sourced fact-check smoke tests.');
  }

  const session = await postJson('/api/sessions', {});

  for (const { text: claim, label, expectNoClaim = false } of claims) {
    const started = Date.now();
    const result = await postJson('/api/fact-check', { claim, sessionId: session.id });
    const elapsed = Date.now() - started;

    if (result.noClaim) {
      if (!expectNoClaim) throw new Error(`Unexpected no-claim result for ${label}: ${claim}`);
      log(`No claim detected (${label}, ${elapsed}ms): ${claim}`, 'yellow');
      continue;
    }

    if (expectNoClaim) throw new Error(`Expected no-claim result for ${label}: ${claim}`);
    if (!validVerdicts.has(result.verdict)) throw new Error(`Invalid verdict for ${label}: ${result.verdict}`);
    if (result.confidence < 0 || result.confidence > 100) {
      throw new Error(`Invalid confidence for ${label}: ${result.confidence}`);
    }

    const model = result.gemini?.model || 'unknown-model';
    const provider = result.gemini?.provider || 'unknown-provider';
    const mode = result.gemini?.mode || 'unknown-mode';
    const searchQueries = result.gemini?.grounding?.webSearchQueries?.length || 0;
    const sourceCount = Array.isArray(result.sources) ? result.sources.length : 0;
    const sourceLabel = sourceCount === 1 ? 'source' : 'sources';
    if (sourceCount === 0) throw new Error(`No sources returned for ${label}: ${claim}`);

    log(
      `${result.verdict.toUpperCase()} (${label}, ${result.confidence}%, ${sourceCount} ${sourceLabel}, ${searchQueries} search queries, ${elapsed}ms)`,
      sourceCount > 0 ? 'green' : 'yellow',
    );
    console.log(`  claim: ${result.claim}`);
    console.log(`  gemini: ${provider} / ${model} / ${mode}`);
  }

  await postJson(`/api/sessions/${session.id}/end`, {});

  const facts = await getJson('/api/facts?limit=3');
  const stats = await getJson('/api/stats');
  log(`\nPersisted facts: ${facts.length}; total checked: ${stats.totalChecked}`, 'cyan');
}

main().catch((error) => {
  log(error.message, 'red');
  process.exit(1);
});
