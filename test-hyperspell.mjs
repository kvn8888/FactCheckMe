/**
 * Hyperspell Cache Testing Script (ES Module version)
 * Run with: node test-hyperspell.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Simple .env parser
function loadEnv() {
  try {
    const envPath = join(__dirname, '.env');
    const envFile = readFileSync(envPath, 'utf-8');
    const env = {};

    envFile.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const [key, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('=').trim();
      env[key.trim()] = value;
    });

    return env;
  } catch (error) {
    console.error('Could not load .env file:', error.message);
    return {};
  }
}

const env = loadEnv();

const SUPABASE_URL = (env.VITE_SUPABASE_URL || '').replace('https://', '').replace('http://', '');
const ANON_KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY || '';

// Validate configuration
if (!SUPABASE_URL || SUPABASE_URL === 'your-project.supabase.co') {
  console.error('\x1b[31mError: SUPABASE_URL not configured\x1b[0m');
  console.error('\x1b[33mPlease set VITE_SUPABASE_URL in your .env file\x1b[0m');
  process.exit(1);
}

if (!ANON_KEY || ANON_KEY === 'your-anon-key') {
  console.error('\x1b[31mError: ANON_KEY not configured\x1b[0m');
  console.error('\x1b[33mPlease set VITE_SUPABASE_PUBLISHABLE_KEY in your .env file\x1b[0m');
  process.exit(1);
}

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function testClaim(testName, claim, expectedFromCache) {
  log(`\nTest: ${testName}`, 'blue');
  console.log(`Claim: "${claim}"`);

  const startTime = Date.now();

  try {
    const response = await fetch(
      `https://${SUPABASE_URL}/functions/v1/fact-check`,
      {
        method: 'POST',
        headers: {
          'apikey': ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ claim }),
      }
    );

    const data = await response.json();
    const endTime = Date.now();
    const elapsedMs = endTime - startTime;

    console.log(`Response time: ${elapsedMs}ms`);
    console.log(`fromCache: ${data.fromCache}`);

    // Check for errors
    if (data.error) {
      log(`❌ Error: ${data.error}`, 'red');
      console.log('Response:', JSON.stringify(data, null, 2));
      return false;
    }

    // Check for noClaim
    if (data.noClaim) {
      log('⚠️  No claim detected in text', 'yellow');
      return true; // This is expected for non-factual statements
    }

    // Validate results
    const fromCache = data.fromCache;

    if (fromCache === expectedFromCache) {
      if (expectedFromCache === true) {
        if (elapsedMs < 500) {
          log('✅ PASS - Cache hit and fast response!', 'green');
        } else {
          log(`⚠️  PARTIAL - Cache hit but slow (${elapsedMs}ms)`, 'yellow');
        }
      } else {
        if (elapsedMs > 1000) {
          log('✅ PASS - Cache miss with expected slow response', 'green');
        } else {
          log('⚠️  PARTIAL - Cache miss but unexpectedly fast', 'yellow');
        }
      }
      return true;
    } else {
      log(
        `❌ FAIL - Expected fromCache: ${expectedFromCache}, got: ${fromCache}`,
        'red'
      );
      return false;
    }
  } catch (error) {
    log(`❌ Request failed: ${error.message}`, 'red');
    return false;
  }
}

async function runTests() {
  log('========================================', 'blue');
  log('Hyperspell Cache Testing Script', 'blue');
  log('========================================', 'blue');
  log(`\nTesting with Supabase URL: ${SUPABASE_URL}\n`, 'yellow');

  const results = [];

  // Test 1: First claim (should be cache miss)
  results.push(
    await testClaim(
      'Cache Miss - First Time Claim',
      'The unemployment rate is 4.2 percent',
      false
    )
  );

  await sleep(1000);

  // Test 2: Exact same claim (should be cache hit)
  results.push(
    await testClaim(
      'Cache Hit - Exact Same Claim',
      'The unemployment rate is 4.2 percent',
      true
    )
  );

  await sleep(1000);

  // Test 3: Semantically similar (should be cache hit)
  results.push(
    await testClaim(
      'Cache Hit - Semantic Match',
      'Unemployment is at 4.2%',
      true
    )
  );

  await sleep(1000);

  // Test 4: Another variation (should be cache hit)
  results.push(
    await testClaim(
      'Cache Hit - Another Variation',
      'The current unemployment rate stands at 4.2 percent',
      true
    )
  );

  await sleep(1000);

  // Test 5: Completely different claim (should be cache miss)
  results.push(
    await testClaim(
      'Cache Miss - New Claim',
      'Inflation is at 9 percent',
      false
    )
  );

  await sleep(1000);

  // Test 6: Repeat new claim (should be cache hit)
  results.push(
    await testClaim(
      'Cache Hit - Repeat New Claim',
      'Inflation is at 9 percent',
      true
    )
  );

  // Summary
  log('\n========================================', 'blue');
  log('Testing Complete!', 'blue');
  log('========================================', 'blue');

  const passed = results.filter(Boolean).length;
  const total = results.length;

  log(`\nResults: ${passed}/${total} tests passed`, passed === total ? 'green' : 'yellow');

  log('\nCheck your Supabase logs for "Cache hit" messages:', 'yellow');
  console.log('Dashboard → Edge Functions → fact-check → Logs\n');

  log('Expected log messages:', 'green');
  console.log("- Test 2-4, 6: Should show 'Cache hit for claim: ...'");
  console.log('- Test 1, 5: No cache messages (first time seeing claim)\n');

  process.exit(passed === total ? 0 : 1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run tests
runTests().catch(error => {
  log(`Fatal error: ${error.message}`, 'red');
  console.error(error);
  process.exit(1);
});
