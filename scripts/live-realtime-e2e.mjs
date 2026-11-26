// Explicitly opt-in live integration test for BOTH real browser WebRTC (OpenAI)
// and real browser WebSocket (MAI Streaming) using synthetic speech audio.
// Usage:
//   doppler --no-check-version run --project personal --config dev_personal -- \
//     node scripts/live-realtime-e2e.mjs --live [--fact-check]
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createAuth, hashPassword } from '../server/auth.mjs';
import { toPublicError } from '../server/errors.mjs';
import { json } from '../server/http-utils.mjs';
import { attachMaiStreamingUpgrade, getMaiStreamingConfig } from '../server/mai-streaming.mjs';
import { getOpenAIConfig } from '../server/openai.mjs';
import { createRouteHandler } from '../server/routes.mjs';

const LIVE = process.argv.includes('--live');
const REAL_FACT_CHECK = process.argv.includes('--fact-check');
const SPOKEN_TEXT = 'The moon is fake. Earth orbits the Sun.';
const EXPECTED_WORDS = ['moon', 'fake', 'earth', 'sun'];
const DIST_DIR = resolve('dist');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

if (!LIVE) {
  console.log('No providers called. Opt in:');
  console.log('  doppler --no-check-version run --project personal --config dev_personal -- node scripts/live-realtime-e2e.mjs --live [--fact-check]');
  console.log('Requires npm run build, macOS say/afconvert/ffmpeg, and Google Chrome.');
  process.exit(0);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Google Chrome binary not found. Set CHROME_PATH to run browser WebRTC/WS integration test.');
}

function generateSyntheticWav(directory) {
  if (process.platform !== 'darwin') {
    throw new Error('Synthetic speech generation requires macOS say and afconvert');
  }
  const aiff = join(directory, 'speech.aiff');
  const rawWav = join(directory, 'speech-raw.wav');
  const paddedWav = join(directory, 'speech-padded.wav');
  execFileSync('/usr/bin/say', ['-r', '140', '-o', aiff, SPOKEN_TEXT], { timeout: 30_000, stdio: 'ignore' });
  execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', aiff, rawWav], { timeout: 30_000, stdio: 'ignore' });
  // Pad with 1.5s leading silence (gives WebRTC/WS time to finish handshake) and 2.5s trailing silence (triggers 600ms pause VAD).
  execFileSync('ffmpeg', [
    '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-t', '1.5', '-i', 'anullsrc=r=48000:cl=mono',
    '-i', rawWav,
    '-f', 'lavfi', '-t', '2.5', '-i', 'anullsrc=r=48000:cl=mono',
    '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]',
    '-map', '[out]', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', paddedWav,
  ], { timeout: 30_000 });
  return paddedWav;
}

async function startAppServer(env, wavBytes) {
  await stat(join(DIST_DIR, 'index.html')).catch(() => {
    throw new Error('dist/index.html not found. Run `npm run build` before running live-realtime-e2e.');
  });
  const auth = createAuth({ env });
  const route = createRouteHandler({
    env,
    auth,
    ...(REAL_FACT_CHECK ? {} : {
      factCheck: async () => ({ result: { hasClaim: false }, metadata: { mode: 'e2e-stub' } }),
    }),
  });

  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname === '/__test_audio.wav') {
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
      res.end(wavBytes);
      return;
    }
    if (pathname.startsWith('/api/')) {
      try {
        await route(req, res);
      } catch (error) {
        const { statusCode, payload } = toPublicError(error);
        if (!res.headersSent) json(res, statusCode, payload);
        else res.end();
      }
      return;
    }
    const target = resolve(DIST_DIR, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
    const filePath = target.startsWith(DIST_DIR) && existsSync(target) ? target : join(DIST_DIR, 'index.html');
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  });

  attachMaiStreamingUpgrade(server, { env, auth });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  return { server, url: `http://localhost:${port}` };
}

// Streams /__test_audio.wav as a real Web Audio MediaStream track whenever the app calls getUserMedia().
const SYNTHETIC_MIC_INIT_SCRIPT = `(() => {
  const mediaDevices = navigator.mediaDevices || {};
  mediaDevices.getUserMedia = async () => {
    const response = await fetch('/__test_audio.wav');
    const arrayBuffer = await response.arrayBuffer();
    const ctx = new AudioContext();
    await ctx.resume();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const dest = ctx.createMediaStreamDestination();
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(dest);
    // Keep a silent keepalive oscillator so the track never goes completely dead after EOF.
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const osc = ctx.createOscillator();
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    source.start();
    const stream = dest.stream;
    for (const track of stream.getTracks()) {
      const origStop = track.stop.bind(track);
      track.stop = () => {
        try { source.stop(); } catch {}
        try { osc.stop(); } catch {}
        void ctx.close().catch(() => {});
        origStop();
      };
    }
    return stream;
  };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
})();`;

async function connectCdp(chromePath, userDataDir) {
  const child = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await new Promise((resolveUrl, rejectUrl) => {
    let stderr = '';
    const timer = setTimeout(() => rejectUrl(new Error('Chrome DevTools failed to start')), 15_000);
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[1]);
      }
    });
    child.once('exit', code => {
      clearTimeout(timer);
      rejectUrl(new Error(`Chrome exited early with code ${code}`));
    });
  });

  const browserWs = new WebSocket(wsUrl);
  await new Promise((res, rej) => { browserWs.once('open', res); browserWs.once('error', rej); });

  let nextId = 1;
  const pending = new Map();
  const logs = [];
  browserWs.on('message', raw => {
    const msg = JSON.parse(raw.toString('utf8'));
    if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(`[console.${msg.params?.type}] ${(msg.params?.args || []).map(a => a.value ?? a.description ?? '').join(' ')}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(`[exception] ${msg.params?.exceptionDetails?.text || ''}`);
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message || 'CDP error'));
      else res(msg.result);
    }
  });

  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { resolve: res, reject: rej });
    browserWs.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: SYNTHETIC_MIC_INIT_SCRIPT }, sessionId);

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.text || 'Page evaluation failed');
    return result?.value;
  };

  const close = async () => {
    try { browserWs.close(); } catch { /* ignore */ }
    if (!child.killed) child.kill('SIGKILL');
    await new Promise(r => child.once('exit', r)).catch(() => {});
  };

  return { send, sessionId, evaluate, logs, close };
}

async function runProviderTest({ chromePath, appUrl, password, providerLabel, expectedButtonText, userDataDir }) {
  const cdp = await connectCdp(chromePath, userDataDir);
  const started = Date.now();
  try {
    await cdp.send('Page.navigate', { url: appUrl }, cdp.sessionId);

    for (let i = 0; i < 40; i++) {
      const ready = await cdp.evaluate(`Boolean(document.querySelector('#service-password') || document.querySelector('[role="radiogroup"]'))`);
      if (ready) break;
      await delay(150);
    }

    const needsLogin = await cdp.evaluate(`Boolean(document.querySelector('#service-password'))`);
    if (needsLogin) {
      await cdp.evaluate(`(() => {
        const input = document.querySelector('#service-password');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(password)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('form button[type="submit"]').click();
      })()`);
    }

    for (let i = 0; i < 40; i++) {
      const hasSwitcher = await cdp.evaluate(`document.querySelectorAll('[role="radiogroup"] [role="radio"]').length === 2`);
      if (hasSwitcher) break;
      await delay(150);
    }

    const clicked = await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('[role="radiogroup"] [role="radio"]')]
        .find(el => el.textContent?.trim().toUpperCase() === ${JSON.stringify(expectedButtonText.toUpperCase())});
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`Could not find transcription engine button "${expectedButtonText}"`);
    await delay(150);

    const tapped = await cdp.evaluate(`(() => {
      const btn = document.querySelector('button[aria-label="Start listening"]');
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    })()`);
    if (!tapped) throw new Error('Could not click Start listening button');

    let liveStarted = false;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const state = await cdp.evaluate(`(() => {
        const body = document.body.innerText || '';
        const listening = /live verification/i.test(body);
        return { listening, body };
      })()`);
      if (state.listening) liveStarted = true;
      const lower = state.body.toLowerCase();
      if (EXPECTED_WORDS.every(w => lower.includes(w))) {
        // Give VAD a moment to commit and finalize the turn into TranscriptPanel
        await delay(1500);
        break;
      }
      await delay(250);
    }

    await cdp.evaluate(`(() => {
      const btn = document.querySelector('button[aria-label="Stop listening"]');
      if (btn && !btn.disabled) btn.click();
    })()`);
    await delay(1500);

    const finalState = await cdp.evaluate(`(() => {
      const transcriptSection = [...document.querySelectorAll('section')].find(s => /live transcript/i.test(s.textContent || ''));
      const text = (transcriptSection ? transcriptSection.innerText : document.body.innerText)
        .replace(/^live transcript\\s*/i, '')
        .replace(/^(live|paused)\\s*/i, '')
        .replace(/^true\\s+false\\s+misleading\\s+unclear\\s*/i, '')
        .trim();
      return { text, fullText: document.body.innerText };
    })()`);

    const finalTranscript = finalState.text;
    const lower = finalTranscript.toLowerCase();
    const missing = EXPECTED_WORDS.filter(word => !lower.includes(word));
    const hasNonLatin = /[^\u0000-\u007F\u2018\u2019\u201C\u201D\u2013\u2014\u2026°•●■]/.test(finalTranscript);

    return {
      provider: providerLabel,
      liveStarted,
      durationMs: Date.now() - started,
      transcript: finalTranscript,
      missingWords: missing,
      hasNonLatin,
      passed: liveStarted && missing.length === 0 && !hasNonLatin,
      ...(liveStarted && missing.length === 0 ? {} : { fullText: finalState.fullText.slice(0, 600), logs: cdp.logs.slice(0, 10) }),
    };
  } finally {
    await cdp.close();
  }
}

getOpenAIConfig();
getMaiStreamingConfig();
const chromePath = findChrome();
const workDir = await mkdtemp(join(tmpdir(), 'factcheck-live-e2e-'));
const password = 'local-e2e-test-only-password';
const env = {
  ...process.env,
  APP_PASSWORD_HASH: hashPassword(password),
  APP_SESSION_SECRET: 'local-e2e-session-secret-0123456789abcdef',
};

let appServer;
try {
  const wavPath = generateSyntheticWav(workDir);
  const wavBytes = await readFile(wavPath);
  appServer = await startAppServer(env, wavBytes);
  console.log(`Running real browser integration test against ${appServer.url}`);
  console.log(`Synthetic speech: "${SPOKEN_TEXT}"`);

  const results = [];
  for (const target of [
    { providerLabel: 'OpenAI Realtime (WebRTC)', expectedButtonText: 'OpenAI', profile: 'chrome-openai' },
    { providerLabel: 'MAI Streaming (WebSocket)', expectedButtonText: 'MAI WS', profile: 'chrome-mai' },
  ]) {
    const res = await runProviderTest({
      chromePath,
      appUrl: appServer.url,
      password,
      providerLabel: target.providerLabel,
      expectedButtonText: target.expectedButtonText,
      userDataDir: join(workDir, target.profile),
    });
    results.push(res);
    console.log(JSON.stringify(res, null, 2));
  }

  const failed = results.filter(r => !r.passed);
  if (failed.length) {
    console.error(`Live realtime integration test FAILED (${failed.map(f => f.provider).join(', ')})`);
    process.exitCode = 1;
  } else {
    console.log('ALL LIVE REALTIME INTEGRATION TESTS PASSED (WebRTC + WebSocket).');
  }
} finally {
  if (appServer) {
    appServer.server.closeAllConnections?.();
    await new Promise(r => appServer.server.close(r));
  }
  await rm(workDir, { recursive: true, force: true });
}
