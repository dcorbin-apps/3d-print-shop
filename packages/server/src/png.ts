import { crc32, deflateSync } from 'node:zlib';
import type { Image } from './renderBeads.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EIGHT_BITS = 8;
const RGBA = 6;
const NO_FILTER = 0;

// AIDEV-NOTE: the smallest PNG a browser shows - one IDAT, every row unfiltered, 8-bit RGBA. Node
// already has the deflate and the checksum a PNG is built from, so this is the whole of an encoder
// and there is no image library to depend on for one picture.
/** An image as a PNG file. */
export function png({ width, height, rgba }: Image): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([EIGHT_BITS, RGBA, 0, 0, 0], 8);

  const stride = width * 4;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    rows[row * (stride + 1)] = NO_FILTER;
    rows.set(rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }

  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed));

  return Buffer.concat([length, typed, checksum]);
}
