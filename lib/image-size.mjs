// Pixel size of a JPEG or WebP read from its own header bytes, so the Performance Contract can
// compare what the markup declares with what is actually on disk. Dependency-free on purpose.

import { readFile } from 'node:fs/promises';

const ascii = (bytes, at, length) => String.fromCharCode(...bytes.subarray(at, at + length));
const be16 = (bytes, at) => (bytes[at] << 8) | bytes[at + 1];
const le16 = (bytes, at) => bytes[at] | (bytes[at + 1] << 8);
const le24 = (bytes, at) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);

// Start-of-frame markers carry the dimensions; C4, C8 and CC are not frames (DHT, JPG, DAC).
const isStartOfFrame = (marker) => marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);

function jpegSize(bytes) {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) throw new Error(`JPEG marker expected at byte ${at}`);
    const marker = bytes[at + 1];
    if (marker === 0xff) { at += 1; continue; } // fill byte
    if (isStartOfFrame(marker)) {
      return { format: 'jpeg', width: be16(bytes, at + 7), height: be16(bytes, at + 5) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    if (marker === 0xda) break; // scan data before any frame header
    at += 2 + be16(bytes, at + 2);
  }
  throw new Error('JPEG has no start-of-frame header');
}

function webpSize(bytes) {
  const chunk = ascii(bytes, 12, 4);
  const payload = 20;
  if (chunk === 'VP8 ') {
    // Lossy: 3-byte frame tag, 3-byte start code, then 14-bit width and height.
    return { format: 'webp', width: le16(bytes, payload + 6) & 0x3fff, height: le16(bytes, payload + 8) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    // Lossless: 1-byte signature, then width-1 and height-1 packed into 14 bits each.
    const b = bytes.subarray(payload + 1, payload + 5);
    return {
      format: 'webp',
      width: (b[0] | ((b[1] & 0x3f) << 8)) + 1,
      height: ((b[1] >> 6) | (b[2] << 2) | ((b[3] & 0x0f) << 10)) + 1,
    };
  }
  if (chunk === 'VP8X') {
    // Extended: flags + reserved, then 24-bit canvas width-1 and height-1.
    return { format: 'webp', width: le24(bytes, payload + 4) + 1, height: le24(bytes, payload + 7) + 1 };
  }
  throw new Error(`WebP chunk ${JSON.stringify(chunk)} is not a VP8 bitstream`);
}

export function imageSize(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
  if (bytes.length > 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return webpSize(bytes);
  throw new Error('not a JPEG or WebP');
}

export async function imageSizeOf(fileUrl) {
  return imageSize(new Uint8Array(await readFile(fileUrl)));
}
