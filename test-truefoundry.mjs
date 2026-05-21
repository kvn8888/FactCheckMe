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
  'The Earth is round.',
  'The Eiffel Tower is in Berlin.',
  'Lightning never strikes the same place twice.',
];

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
  log(`Health: ok=${health.ok}, trueFoundryConfigured=${health.trueFoundryConfigured}`, 'cyan');

  const session = await postJson('/api/sessions', {});

  for (const claim of claims) {
    const started = Date.now();
    const result = await postJson('/api/fact-check', { claim, sessionId: session.id });
    const elapsed = Date.now() - started;

    if (result.noClaim) {
      log(`No claim detected: ${claim}`, 'yellow');
      continue;
    }

    const model = result.gateway?.model || 'unknown-model';
    const provider = result.gateway?.provider || 'unknown-provider';
    const sourceCount = Array.isArray(result.sources) ? result.sources.length : 0;
    const sourceLabel = sourceCount === 1 ? 'source' : 'sources';
    const cacheLabel = result.fromCache ? 'cache metadata present' : 'fresh/no cache metadata';

    log(
      `${result.verdict.toUpperCase()} (${result.confidence}%, ${sourceCount} ${sourceLabel}, ${elapsed}ms, ${cacheLabel})`,
      sourceCount > 0 ? 'green' : 'yellow',
    );
    console.log(`  claim: ${result.claim}`);
    console.log(`  gateway: ${provider} / ${model}`);
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
