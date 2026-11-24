import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readPcm } from './synthetic-audio.mjs';

const run = promisify(execFile);
export const INPUT_RATE = 48000;
export const OUTPUT_RATE = 16000;
export const CHUNK_SECONDS = 6;
export const REPEATED_CLAIM = 'Earth orbits the Sun.';
const GAP_SAMPLES = INPUT_RATE * 0.32;
const SCRIPT = [
  ['nonclaim', [], 'Good morning, everyone.'],
  ['claim', ['Dr.', 'nasa.gov'], 'Dr. Elena Vance says the Webb telescope observes infrared light, and you can read about its instruments at nasa.gov.'],
  ['claim', [], REPEATED_CLAIM],
  ['claim', ['sentence-final U.S.'], 'The first successful powered flight took place in the U.S.'],
  ['claim', [], 'The capital of Canada is Ottawa, and the city sits on the south bank of the Ottawa River.'],
  ['claim', ['Prof.', 'Jan.'], 'Prof. Rivera mentioned that Alaska became a state in Jan. 1959.'],
  ['claim', ['3.14', 'e.g.'], 'Pi rounds to 3.14 at two decimal places, e.g. when estimating the circumference of a dinner plate.'],
  ['nonclaim', ['quoted speech'], 'She asked, "Wait a minute. Is that really true?"'],
  ['claim', ['version 2.4', 'example.com', 'long utterance'], 'When the library moved its catalog to version 2.4, the staff kept an archive of the old records at example.com so that readers who had bookmarked a specific edition could still find it, and they added redirects for all of the old links to keep the catalog usable during the transition.'],
  ['claim', ['$2.5 million', 'Inc.', 'i.e.'], 'Cedar Tools Inc. reported $2.5 million in revenue, i.e. before subtracting operating expenses.'],
  ['claim', ['Ph.D.', '98.6'], 'A nurse with a Ph.D. told us that 98.6 degrees Fahrenheit is a familiar reference for body temperature.'],
  ['nonclaim', ['ellipsis', '?!'], 'I was about to make a joke... should I still tell it?!'],
  ['claim', ['St.', 'parenthetical'], 'The St. Louis marathon route goes through Forest Park (surprisingly!) before it passes the art museum.'],
  ['claim', [], 'A regulation soccer match has two halves of forty-five minutes each, plus added time.'],
  ['nonclaim', [], 'I would rather listen to a live orchestra than watch a replay.'],
  ['claim', ['repeated claim'], REPEATED_CLAIM],
  ['nonclaim', [], 'Could you play the recording again when we get back from lunch?'],
];

function encodeInputWav(blocks, sampleCount) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + sampleCount * 2, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(INPUT_RATE, 24);
  header.writeUInt32LE(INPUT_RATE * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(sampleCount * 2, 40);
  return Buffer.concat([header, ...blocks]);
}

function readInputPcm(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE' ||
      wav.readUInt32LE(4) !== wav.length - 8) throw new Error('Expected complete 48 kHz RIFF/WAVE audio');
  let format;
  let pcm;
  // afconvert can insert metadata chunks before data.
  for (let offset = 12; offset + 8 <= wav.length;) {
    const tag = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new Error('Truncated input WAV chunk');
    if (tag === 'fmt ' && size >= 16) {
      format = [wav.readUInt16LE(start), wav.readUInt16LE(start + 2), wav.readUInt32LE(start + 4), wav.readUInt16LE(start + 14)];
    }
    if (tag === 'data') pcm = wav.subarray(start, start + size);
    offset = start + size + size % 2;
  }
  if (JSON.stringify(format) !== '[1,1,48000,16]' || !pcm?.length || pcm.length % 2) throw new Error('Expected 48 kHz mono signed 16-bit PCM');
  return pcm;
}

function fallbackPcm(words) {
  const samples = Math.round(INPUT_RATE * words.length * 0.39);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const time = i / INPUT_RATE;
    const envelope = Math.sin(Math.PI * (time / 0.39 % 1));
    pcm.writeInt16LE(Math.round(3200 * envelope * Math.sin(2 * Math.PI * 180 * time)), i * 2);
  }
  return pcm;
}

function wordSpans(text, startSample, endSample) {
  const tokens = [...text.matchAll(/\S+/g)];
  const weights = tokens.map(([word]) => Math.max(2, word.replace(/[^\w]/g, '').length));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  let consumed = 0;
  const at = weight => startSample + Math.round((endSample - startSample) * weight / weightSum);
  return tokens.map(([word], index) => {
    const start = at(consumed);
    consumed += weights[index];
    return { text: word, startSample: start, endSample: at(consumed) };
  });
}

export async function buildTtsFixture() {
  const started = performance.now();
  const isMac = process.platform === 'darwin';
  const directory = isMac ? await mkdtemp(join(tmpdir(), 'factcheck-tts-')) : undefined;
  const utterances = [];
  const blocks = [];
  let sampleCount = 0;
  try {
    const pcms = new Array(SCRIPT.length);
    let next = 0;
    const worker = async () => {
      while (next < SCRIPT.length) {
        const index = next++;
        const [, , text] = SCRIPT[index];
        if (isMac) {
          const aiff = join(directory, `utterance-${index}.aiff`);
          const wav = join(directory, `utterance-${index}.wav`);
          const options = { timeout: 15000 };
          await run('/usr/bin/say', ['-v', 'Samantha', '-r', '120', '-o', aiff, text], options);
          await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', aiff, wav], options);
          pcms[index] = readInputPcm(await readFile(wav));
        } else {
          pcms[index] = fallbackPcm(text.split(/\s+/));
        }
      }
    };
    await Promise.all(Array.from({ length: isMac ? 6 : 1 }, worker));
    for (const [index, [kind, edgeCases, text]] of SCRIPT.entries()) {
      const pcm = pcms[index];
      if (index) {
        blocks.push(Buffer.alloc(GAP_SAMPLES * 2));
        sampleCount += GAP_SAMPLES;
      }
      const startSample = sampleCount;
      sampleCount += pcm.length / 2;
      blocks.push(pcm);
      utterances.push({
        index, text, kind, edgeCases, startSample, endSample: sampleCount,
        startSec: startSample / INPUT_RATE, endSec: sampleCount / INPUT_RATE,
        words: wordSpans(text, startSample, sampleCount),
      });
    }
    const wav = encodeInputWav(blocks, sampleCount);
    const durationSec = readInputPcm(wav).length / 2 / INPUT_RATE;
    if (durationSec < 90 || durationSec > 120) throw new Error(`Fixture duration ${durationSec.toFixed(3)} s is outside 90–120 s`);
    return { wav, durationSec, sampleCount, utterances, generationMs: performance.now() - started, source: isMac ? 'macOS Samantha' : 'fallback PCM' };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

// Decode once. The capture driver streams subarrays through the actual 4096-sample processor.
export function decodeTtsWav(wav) {
  const pcm = readInputPcm(wav);
  const samples = new Float32Array(pcm.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  return samples;
}

// Midpoint ownership assigns every word exactly once, including words whose
// estimated interval straddles a cut. The timeline is proportional, not forced alignment.
export function transcribeFixtureChunk(wav, fixture, index, { chunkBoundaryPunctuation = false } = {}) {
  const first = index * CHUNK_SECONDS * OUTPUT_RATE;
  const last = Math.min(first + CHUNK_SECONDS * OUTPUT_RATE, Math.floor(fixture.sampleCount / 3));
  if (!Number.isInteger(index) || index < 0 || last <= first) throw new Error(`Unexpected chunk index ${index}`);
  const pcm = readPcm(wav);
  if (wav.length !== 44 + (last - first) * 2 || pcm.length !== (last - first) * 2 ||
      wav.readUInt32LE(4) !== wav.length - 8 || wav.readUInt32LE(28) !== OUTPUT_RATE * 2 ||
      wav.readUInt16LE(32) !== 2 || wav.toString('ascii', 36, 40) !== 'data' || wav.readUInt32LE(40) !== pcm.length) {
    throw new Error(`Incorrect PCM WAV size or layout for chunk ${index}`);
  }
  let energy = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) energy += (pcm.readInt16LE(offset) / 32768) ** 2;
  const rms = Math.sqrt(energy / (last - first));
  const startSample = first * 3;
  const endSample = last * 3;
  const words = fixture.utterances.flatMap(utterance => utterance.words.flatMap(word => {
    const middle = (word.startSample + word.endSample) / 2;
    return middle >= startSample && (middle < endSample || last === Math.floor(fixture.sampleCount / 3))
      ? [{ ...word, utteranceIndex: utterance.index }] : [];
  }));
  if (words.length && rms === 0) throw new Error(`Speech chunk ${index} contains silent PCM`);
  const rawText = words.map(word => word.text).join(' ');
  const text = chunkBoundaryPunctuation && rawText && !/[.!?]["')]*$/.test(rawText) ? `${rawText}.` : rawText;
  return {
    index, bytes: wav.length, sampleCount: last - first, rms, words, rawText, text,
    insertedPeriod: text !== rawText, startSec: first / OUTPUT_RATE, endSec: last / OUTPUT_RATE,
  };
}

export function analyzeSegments(fixture, chunks, transcript, segments, sentenceBoundaries, snapshots = []) {
  const offsets = new Map();
  const chunkEnds = new Map();
  let cursor = 0;
  for (const chunk of chunks) {
    if (!chunk.text) continue;
    for (const [index, word] of chunk.words.entries()) {
      const previous = offsets.get(word.utteranceIndex);
      const inserted = chunk.insertedPeriod && index === chunk.words.length - 1;
      offsets.set(word.utteranceIndex, { start: previous?.start ?? cursor, end: cursor + word.text.length + Number(inserted) });
      cursor += word.text.length + Number(inserted) + 1;
    }
    chunkEnds.set(cursor - 1, chunk);
  }
  const candidates = new Set(sentenceBoundaries(transcript));
  const causeAt = (offset, utterance) => {
    const chunk = chunkEnds.get(offset);
    const token = transcript.slice(0, offset).match(/\S+$/)?.[0];
    if (!candidates.has(offset)) return `sentence parser suppressed ${token}`;
    if (chunk && chunk.index % 2 === 0) return `even chunk ${chunk.index} boundary suppressed`;
    if (chunk?.insertedPeriod) return `file-STT period at odd chunk ${chunk.index}`;
    if (token?.endsWith('...')) return 'ellipsis';
    if (token?.endsWith('!)')) return 'parenthetical punctuation';
    if (utterance.edgeCases.includes('quoted speech')) return 'punctuation inside quote';
    return `sentence boundary after ${token}`;
  };
  const boundaryOutcomes = [...chunkEnds].flatMap(([offset, chunk]) => {
    if (!chunk.insertedPeriod) return [];
    const token = transcript.slice(0, offset).match(/\S+$/)?.[0];
    const outcome = offset === transcript.length ? 'session end'
      : !candidates.has(offset) ? 'ignored by sentence parser'
        : segments.some(span => span.end === offset) ? 'settled'
          : 'continued across cut';
    return [{ chunkIndex: chunk.index, offset, token, outcome }];
  });
  const merged = [];
  const split = [];
  const exact = [];
  for (const utterance of fixture.utterances) {
    const mapped = offsets.get(utterance.index);
    if (!mapped) continue;
    const related = segments.filter(span => span.start < mapped.end && span.end > mapped.start);
    if (related.length === 1 && related[0].text === utterance.text) exact.push(utterance.index);
    const crossing = related.find(span => span.end > mapped.end);
    if (crossing && offsets.has(utterance.index + 1)) {
      merged.push({ after: utterance.index, before: utterance.index + 1, offset: mapped.end, cause: causeAt(mapped.end, utterance), segmentId: crossing.id });
    }
    for (const span of related.filter(span => span.end < mapped.end)) {
      split.push({ utterance: utterance.index, offset: span.end, cause: causeAt(span.end, utterance), segmentId: span.id });
    }
  }
  const counts = new Uint8Array(transcript.length);
  for (const span of segments) for (let offset = span.start; offset < span.end; offset++) counts[offset]++;
  let lostCharacters = 0;
  let overlappingCharacters = 0;
  for (let offset = 0; offset < transcript.length; offset++) {
    if (!/\s/.test(transcript[offset]) && counts[offset] === 0) lostCharacters++;
    if (counts[offset] > 1) overlappingCharacters++;
  }
  const provisional = new Map();
  for (const spans of snapshots) for (const span of spans) {
    if (!span.final) {
      const revisions = provisional.get(span.id) ?? new Set();
      revisions.add(span.revision);
      provisional.set(span.id, revisions);
    }
  }
  return {
    exactMatches: exact.length, exact, merged, split, boundaryOutcomes, lostCharacters, overlappingCharacters,
    exactOffsets: segments.every(span => transcript.slice(span.start, span.end) === span.text),
    provisionalSegments: provisional.size,
    provisionalRevisions: [...provisional.values()].reduce((count, revisions) => count + revisions.size - 1, 0),
  };
}
