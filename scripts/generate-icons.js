import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const publicDir = path.resolve('public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// Generate icon.svg
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#a4e2b7" />
      <stop offset="100%" stop-color="#16845d" />
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="128" fill="url(#grad)" />
  <rect x="24" y="24" width="464" height="464" rx="104" fill="none" stroke="#ffffff" stroke-width="16" stroke-opacity="0.3" />
  <text x="50%" y="54%" font-family="system-ui, -apple-system, sans-serif" font-size="190" font-weight="800" fill="#ffffff" text-anchor="middle" dominant-baseline="central">A文</text>
</svg>`;

fs.writeFileSync(path.join(publicDir, 'icon.svg'), svg);

// CRC32 table for PNG chunk checksums
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = data.length;
  const chunk = Buffer.alloc(8 + len + 4);
  chunk.writeUInt32BE(len, 0);
  typeBuf.copy(chunk, 4);
  data.copy(chunk, 8);
  const toCrc = Buffer.concat([typeBuf, data]);
  const checksum = crc32(toCrc);
  chunk.writeUInt32BE(checksum, 8 + len);
  return chunk;
}

function generatePng(size, isMaskable = false) {
  const width = size;
  const height = size;

  // Raw image data: filter byte (0) + 4 bytes per pixel (RGBA) per scanline
  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(rowSize * height);

  const radius = isMaskable ? 0 : Math.floor(size * 0.25);
  const cx = size / 2;
  const cy = size / 2;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter type None

    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;

      // Rounded rectangle check if not maskable
      let inside = true;
      if (!isMaskable) {
        const dx = Math.max(Math.abs(x - cx) - (cx - radius), 0);
        const dy = Math.max(Math.abs(y - cy) - (cy - radius), 0);
        if (dx * dx + dy * dy > radius * radius) {
          inside = false;
        }
      }

      if (!inside) {
        rawData[pxOffset] = 0;
        rawData[pxOffset + 1] = 0;
        rawData[pxOffset + 2] = 0;
        rawData[pxOffset + 3] = 0; // Transparent
      } else {
        // Gradient from #a4e2b7 (164, 226, 183) to #16845d (22, 132, 93)
        const t = (x + y) / (width + height);
        const r = Math.round(164 * (1 - t) + 22 * t);
        const g = Math.round(226 * (1 - t) + 132 * t);
        const b = Math.round(183 * (1 - t) + 93 * t);

        rawData[pxOffset] = r;
        rawData[pxOffset + 1] = g;
        rawData[pxOffset + 2] = b;
        rawData[pxOffset + 3] = 255;
      }
    }
  }

  const deflated = zlib.deflateSync(rawData);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // Compression deflate
  ihdr[11] = 0; // Filter standard
  ihdr[12] = 0; // No interlace

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = makePngChunk('IHDR', ihdr);
  const idatChunk = makePngChunk('IDAT', deflated);
  const iendChunk = makePngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

fs.writeFileSync(path.join(publicDir, 'pwa-192x192.png'), generatePng(192));
fs.writeFileSync(path.join(publicDir, 'pwa-512x512.png'), generatePng(512));
fs.writeFileSync(path.join(publicDir, 'pwa-maskable-512x512.png'), generatePng(512, true));
fs.writeFileSync(path.join(publicDir, 'apple-touch-icon.png'), generatePng(180));

console.log('Successfully generated PWA icon assets in public directory.');
