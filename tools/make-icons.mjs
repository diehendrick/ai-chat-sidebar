import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const outDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', 'replica', 'chat-panel', 'icons');
fs.mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(size) {
  const px = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const radius = size * 0.42;
  const bubbleTop = size * 0.28;
  const bubbleBottom = size * 0.62;
  const bubbleLeft = size * 0.24;
  const bubbleRight = size * 0.76;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // rounded-square background with a subtle vertical gradient
      const r = size * 0.24;
      const dx = Math.max(Math.abs(x - cx) - (size / 2 - r - size * 0.04), 0);
      const dy = Math.max(Math.abs(y - cx) - (size / 2 - r - size * 0.04), 0);
      const inside = Math.hypot(dx, dy) <= r;
      if (!inside) { px[i + 3] = 0; continue; }

      const t = y / size;
      px[i] = Math.round(96 + t * 30);
      px[i + 1] = Math.round(116 + t * 26);
      px[i + 2] = Math.round(255 - t * 20);
      px[i + 3] = 255;

      // white chat bubble
      const inBubble = x > bubbleLeft && x < bubbleRight && y > bubbleTop && y < bubbleBottom;
      if (inBubble) { px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; }

      // three dots inside the bubble
      const dotY = (bubbleTop + bubbleBottom) / 2;
      const dots = [0.38, 0.5, 0.62].map((f) => f * size);
      for (const d of dots) {
        if (Math.abs(x - d) < size * 0.03 && Math.abs(y - dotY) < size * 0.045) {
          px[i] = 96; px[i + 1] = 116; px[i + 2] = 255;
        }
      }
    }
  }

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

for (const size of [16, 48, 128]) {
  const file = path.join(outDir, `${size}.png`);
  fs.writeFileSync(file, makePng(size));
  console.log('wrote', file);
}
