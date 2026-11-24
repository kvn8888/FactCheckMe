// Dependency-free PCM WAV helpers shared by synthetic tests and the live smoke run.
export function encodeWav(pcm) {
  if (pcm.length % 2) throw new Error('PCM must contain complete 16-bit samples');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function readPcm(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected RIFF WAV');
  let format;
  let pcm;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const tag = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new Error('Truncated WAV chunk');
    if (tag === 'fmt ') {
      if (size < 16) throw new Error('Truncated WAV format');
      format = [wav.readUInt16LE(start), wav.readUInt16LE(start + 2), wav.readUInt32LE(start + 4), wav.readUInt16LE(start + 14)];
    }
    if (tag === 'data') pcm = wav.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (JSON.stringify(format) !== '[1,1,16000,16]' || !pcm?.length || pcm.length % 2) throw new Error('Expected nonempty 16 kHz mono signed 16-bit PCM');
  return pcm;
}

export function splitWav(wav, seconds = 6) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error('Invalid chunk duration');
  const pcm = readPcm(wav);
  const chunks = [];
  for (let offset = 0; offset < pcm.length; offset += seconds * 32000) chunks.push(encodeWav(pcm.subarray(offset, offset + seconds * 32000)));
  return chunks;
}
