// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { encodeWav, readPcm, splitWav } from '../scripts/synthetic-audio.mjs';

describe('synthetic PCM fixture integrity', () => {
  it.each([1, 96000, 96001, 208000])('preserves all %i samples across independent WAV chunks', (samples) => {
    const pcm = Buffer.alloc(samples * 2);
    for (let index = 0; index < samples; index++) pcm.writeInt16LE((index % 65536) - 32768, index * 2);
    const chunks = splitWav(encodeWav(pcm));
    expect(Buffer.concat(chunks.map(readPcm))).toEqual(pcm);
    expect(chunks.every((chunk) => chunk.length <= 192044)).toBe(true);
    for (const chunk of chunks) expect(chunk.readUInt32LE(4)).toBe(chunk.length - 8);
  });
  it('handles a padded odd-length metadata chunk before the PCM', () => {
    const wav = encodeWav(Buffer.alloc(4));
    const metadata = Buffer.alloc(10); metadata.write('JUNK'); metadata.writeUInt32LE(1, 4);
    const extended = Buffer.concat([wav.subarray(0, 12), metadata, wav.subarray(12)]);
    extended.writeUInt32LE(extended.length - 8, 4);
    expect(readPcm(extended)).toEqual(Buffer.alloc(4));
  });
  it('rejects invalid/truncated/unsupported audio rather than uploading it', () => {
    expect(() => readPcm(Buffer.alloc(44))).toThrow('RIFF WAV');
    expect(() => readPcm(encodeWav(Buffer.alloc(4)).subarray(0, 46))).toThrow('Truncated');
    const stereo = encodeWav(Buffer.alloc(4)); stereo.writeUInt16LE(2, 22);
    expect(() => readPcm(stereo)).toThrow('16 kHz mono');
    expect(() => encodeWav(Buffer.alloc(3))).toThrow('complete 16-bit');
    expect(() => splitWav(encodeWav(Buffer.alloc(4)), 0)).toThrow('Invalid chunk');
  });
});
