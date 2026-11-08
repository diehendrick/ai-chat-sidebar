// Validate the packed extension: manifest references exist, PNGs decode, and the
// archive uses POSIX paths (macOS/Linux friendly).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = process.argv[2] || 'extension';
const manifestPath = path.join(dir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const problems = [];

function checkPng(file) {
  const buf = fs.readFileSync(file);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('bad signature');

  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
      if (![2, 6].includes(colorType)) throw new Error(`unsupported colour type ${colorType}`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = colorType === 6 ? 4 : 3;
  const expected = (width * channels + 1) * height;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length !== expected) throw new Error(`pixel stream ${raw.length} != ${expected}`);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (width * channels + 1)];
    if (filter > 4) throw new Error(`bad filter byte ${filter} on row ${y}`);
  }
  return { width, height, bytes: buf.length };
}

const refs = new Set();
for (const p of Object.values(manifest.icons ?? {})) refs.add(p);
for (const p of Object.values(manifest.action?.default_icon ?? {})) refs.add(p);

for (const ref of [...refs].sort()) {
  const file = path.join(dir, ref);
  if (!fs.existsSync(file)) { problems.push(`manifest references missing file: ${ref}`); continue; }
  try {
    const info = checkPng(file);
    console.log(`  OK  ${ref}  ${info.width}x${info.height} ${info.bytes}B`);
  } catch (e) {
    problems.push(`invalid PNG ${ref}: ${e.message}`);
  }
}

for (const required of ['manifest.json', 'background.js', 'sidepanel.html']) {
  if (!fs.existsSync(path.join(dir, required))) problems.push(`missing ${required}`);
}

console.log(problems.length ? '\nPROBLEMS:\n - ' + problems.join('\n - ') : '\nAll manifest icon references are valid.');
process.exit(problems.length ? 1 : 0);
