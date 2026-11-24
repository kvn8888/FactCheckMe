// Explicitly opt-in. No network calls on ordinary npm test or without --live.
// Uses macOS local speech synthesis, never a user's microphone or transcript.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcribeAudio, getMaiConfig } from '../server/mai.mjs';
import { makeFactCheck, getOpenAIConfig } from '../server/openai.mjs';
import { splitWav } from './synthetic-audio.mjs';

const TEXT = 'Earth orbits the Sun. The Moon orbits Earth. Thank you for listening.';
const live = process.argv.includes('--live');
const chain = process.argv.includes('--fact-check');
if (!live) {
  console.log('No providers called. Opt in: node scripts/live-provider-smoke.mjs --live [--fact-check]');
  console.log('Requires macOS say/afconvert and existing provider environment variables. At most 5 sequential MAI file requests (30 seconds total); optional 1 fact-check pipeline (up to 3 OpenAI + 1 Exa request). No retries. Provider billing applies; monetary cost depends on your plans.');
  process.exit(0);
}
if (process.platform !== 'darwin') throw new Error('Synthetic speech generation requires macOS say and afconvert');
// Validate all requested providers before generating or sending anything.
getMaiConfig();
if (chain) { getOpenAIConfig(); if (!process.env.EXA_API_KEY) throw new Error('Exa is not configured'); }
const directory = await mkdtemp(join(tmpdir(), 'factcheck-synthetic-'));
let calls = 0;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error('Smoke run time budget exceeded')), 180000);
// Hard aggregate network cap, no retry or arbitrary outbound endpoint.
const boundedFetch = (url, init) => {
  if (++calls > (chain ? 9 : 5)) throw new Error('Smoke run request budget exceeded');
  return fetch(url, { ...init, signal: AbortSignal.any([init.signal, controller.signal]) });
};
try {
  const aiff = join(directory, 'speech.aiff'); const wav = join(directory, 'speech.wav');
  execFileSync('/usr/bin/say', ['-r', '135', '-o', aiff, TEXT], { timeout: 30000, stdio: 'ignore' });
  execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav], { timeout: 30000, stdio: 'ignore' });
  const chunks = splitWav(await readFile(wav));
  if (chunks.length > 5) throw new Error('Synthetic audio exceeds 30-second budget');
  console.log(`Synthetic file-chunked near-live test: ${chunks.length} sequential uploads. This does not test MAI Streaming preview or browser capture.`);
  const texts = [];
  for (let index = 0; index < chunks.length; index++) {
    const start = Date.now();
    const { text } = await transcribeAudio(chunks[index], { fetchImpl: boundedFetch, signal: controller.signal });
    texts.push(text);
    console.log(JSON.stringify({ chunk: index + 1, bytes: chunks[index].length, latencyMs: Date.now() - start, characters: text.length }));
  }
  const transcript = texts.filter(Boolean).join(' ');
  // Loose keyword checks allow punctuation/capitalization variation and expose word-boundary loss.
  if (!/earth/i.test(transcript) || !/sun/i.test(transcript) || !/moon/i.test(transcript)) throw new Error('Synthetic transcription failed expected astronomy keyword checks');
  console.log('Synthetic transcription keyword checks passed.');
  if (chain) {
    const { result, metadata } = await makeFactCheck(transcript, { context: transcript, fetchImpl: boundedFetch, signal: controller.signal });
    if (result.hasClaim !== true || !['true', 'false', 'misleading', 'unverifiable'].includes(result.verdict)) throw new Error('Invalid live fact-check result');
    if (result.verdict !== 'true' || !result.sources.length) throw new Error(`Synthetic positive-control assertion was not supported (${result.verdict}; ${metadata.reason || 'no reason'})`);
    console.log(JSON.stringify({ verdict: result.verdict, sources: result.sources.length, confidence: result.confidence }));
  }
  console.log(`Completed ${calls} provider requests. No credentials or full transcript printed.`);
} catch (error) {
  // Adapter errors are sanitized; do not print raw child-process or upstream errors.
  console.error(error?.code === 'provider_error' || error?.code === 'provider_timeout' ? `Live provider check failed (${error.code}).` : 'Live smoke failed; check provisioning, local speech tools, timeout, and synthetic positive-control results.');
  process.exitCode = 1;
} finally { clearTimeout(timer); await rm(directory, { recursive: true, force: true }); }
