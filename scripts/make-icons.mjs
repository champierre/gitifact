// Generates simple PNG icons without any dependency (pure PNG encoder).
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
// Rounded purple square with a white "play" triangle.
function pixel(size) {
  const r = size * 0.22;
  return (x, y) => {
    const cx = Math.min(Math.max(x + 0.5, r), size - r), cy = Math.min(Math.max(y + 0.5, r), size - r);
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    const inside = d <= r ? 1 : 0;
    if (!inside) return [0, 0, 0, 0];
    const px = (x + 0.5) / size, py = (y + 0.5) / size;
    const inTri = px >= 0.36 && px <= 0.72 && Math.abs(py - 0.5) <= (0.72 - px) * 0.8;
    return inTri ? [255, 255, 255, 255] : [111, 66, 193, 255];
  };
}
mkdirSync(new URL('../public/icons', import.meta.url), { recursive: true });
for (const s of [16, 32, 48, 128]) {
  writeFileSync(new URL(`../public/icons/icon-${s}.png`, import.meta.url), png(s, pixel(s)));
}
console.log('icons written');
