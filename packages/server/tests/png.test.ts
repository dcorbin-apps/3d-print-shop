import { describe, it, expect } from '@jest/globals';
import { crc32, inflateSync } from 'node:zlib';
import { png } from '../src/png';

interface Chunk {
  type: string;
  data: Buffer;
  checksum: number;
}

function chunksOf(file: Buffer): Chunk[] {
  const chunks: Chunk[] = [];
  for (let at = 8; at < file.length;) {
    const length = file.readUInt32BE(at);
    const type = file.toString('ascii', at + 4, at + 8);
    chunks.push({ type, data: file.subarray(at + 8, at + 8 + length), checksum: file.readUInt32BE(at + 8 + length) });
    at += 12 + length;
  }

  return chunks;
}

describe('an image as a PNG', () => {
  // Three pixels across and two down: red, green, blue / white, grey, and one that is not there at all.
  const image = {
    width: 3,
    height: 2,
    rgba: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 128, 128, 128, 255, 0, 0, 0, 0]),
  };

  it('opens with the signature every PNG does', () => {
    expect([...png(image).subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('is a header, the pixels and an end, each carrying its own checksum', () => {
    const chunks = chunksOf(png(image));

    expect(chunks.map(({ type }) => type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    chunks.forEach(({ type, data, checksum }) => expect(checksum).toBe(crc32(Buffer.concat([Buffer.from(type), data]))));
  });

  it('says how big it is, and that it is 8-bit colour with transparency', () => {
    const [header] = chunksOf(png(image));

    expect(header?.data.readUInt32BE(0)).toBe(3);
    expect(header?.data.readUInt32BE(4)).toBe(2);
    expect([...(header?.data.subarray(8) ?? [])]).toEqual([8, 6, 0, 0, 0]);
  });

  it('carries every pixel as it was, a row at a time with nothing done to it', () => {
    const pixels = inflateSync(chunksOf(png(image))[1]?.data ?? Buffer.alloc(0));

    expect([...pixels]).toEqual([
      ...[0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255],
      ...[0, 255, 255, 255, 255, 128, 128, 128, 255, 0, 0, 0, 0],
    ]);
  });
});
