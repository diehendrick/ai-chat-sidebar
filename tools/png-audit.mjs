// Deep check of the shipped PNGs: chunk structure, CRC validity, decompressed size.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

for (const size of [16, 48, 128]) {
  const file = path.join('extension', 'icons', `${size}.png`);
  const buf = fs.readFileSync(file);
  console.log(`\n=== ${file} (${buf.length} bytes) ===`);

  const sigOk = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  console.log('signature:', sigOk ? 'ok' : 'BAD');

  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const stored = buf.readUInt32BE(off + 8 + len);
    const calc = zlib.crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0;
    const crcOk = stored === calc;
    console.log(
      `${type.padEnd(4)} len=${String(len).padStart(4)}  crc=${stored.toString(16).padStart(8, '0')} ` +
      `calc=${calc.toString(16).padStart(8, '0')}  ${crcOk ? 'ok' : 'CRC MISMATCH'}`
    );
    if (type === 'IHDR') {
      buffer: {
        console.log(
          `     width=${data.readUInt32BE(0)} height=${data.readUInt32BE(4)} ` +
          `bitDepth=${data[8]} colorType=${data[9]} compression=${data[10]} filter=${data[11]} interlace=${data[12]}`
        );
      }
    }
    if (type === 'IDAT') {
      try {
        const raw = zlib.inflateSync(data);
        console.log(`     inflate ok: ${raw.length} bytes`);
      } catch (e) {
        console.log('     INFLATE FAILED:', e.message);
      }
    }
    off += 12 + len;
    if (type === 'IEND') break;
  }
}
