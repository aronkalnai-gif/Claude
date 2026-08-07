/* Renders the app icon to PNG without any image dependencies.
   Run with: node tools/make-icons.mjs
   Kept in the repo so the icons can be regenerated rather than being
   opaque binaries nobody can edit. */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'icons');

/* The same constellation as icon.svg, in a 512-unit space. */
const EDGES = [
  [256, 250, 150, 158], [256, 250, 372, 170], [256, 250, 146, 352],
  [256, 250, 370, 356], [150, 158, 372, 170], [146, 352, 370, 356],
];
const NODES = [
  [256, 250, 40, [0xF0, 0xB4, 0x29]],
  [150, 158, 24, [0xF2, 0x70, 0x4A]],
  [372, 170, 22, [0x5B, 0xA9, 0xF5]],
  [146, 352, 20, [0x4E, 0xD6, 0xA0]],
  [370, 356, 26, [0xB9, 0x8C, 0xF0]],
];

function render(size, { rounded = true } = {}) {
  const s = size / 512;
  const px = new Uint8Array(size * size * 4);

  const put = (x, y, [r, g, b], a) => {
    if (a <= 0) return;
    const i = (y * size + x) * 4;
    const inv = 1 - a;
    px[i]     = px[i]     * inv + r * a;
    px[i + 1] = px[i + 1] * inv + g * a;
    px[i + 2] = px[i + 2] * inv + b * a;
    px[i + 3] = Math.min(255, px[i + 3] * inv + 255 * a);
  };

  const cx = size / 2, cy = size * 0.42, maxR = size * 0.72;
  const radius = size * 0.219;   // 112/512

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Rounded-rect mask, antialiased at the corners.
      let mask = 1;
      if (rounded) mask = roundedRectCoverage(x + 0.5, y + 0.5, size, radius);
      if (mask <= 0) continue;

      // Radial background, dark navy fading to near-black.
      const t = Math.min(1, Math.hypot(x - cx, y - cy) / maxR);
      const col = [
        lerp(0x1B, 0x0B, t), lerp(0x23, 0x0D, t), lerp(0x33, 0x12, t),
      ];
      put(x, y, col, mask);
    }
  }

  // Edges.
  const lineW = 7 * s;
  for (const [x1, y1, x2, y2] of EDGES) {
    strokeSegment(px, size, x1 * s, y1 * s, x2 * s, y2 * s, lineW, [0x3B, 0x46, 0x58], put, rounded, radius);
  }

  // Nodes.
  for (const [x, y, r, col] of NODES) {
    fillCircle(px, size, x * s, y * s, r * s, col, put, rounded, radius);
  }

  return px;
}

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

function roundedRectCoverage(x, y, size, r) {
  const dx = Math.max(r - x, x - (size - r), 0);
  const dy = Math.max(r - y, y - (size - r), 0);
  if (dx === 0 || dy === 0) return 1;
  const d = Math.hypot(dx, dy);
  return clamp01(r - d + 0.5);
}

function fillCircle(px, size, cx, cy, r, col, put, rounded, radius) {
  const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(size - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(size - 1, Math.ceil(cy + r + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      let a = clamp01(r - d + 0.5);
      if (rounded) a *= roundedRectCoverage(x + 0.5, y + 0.5, size, radius);
      put(x, y, col, a);
    }
  }
}

function strokeSegment(px, size, x1, y1, x2, y2, w, col, put, rounded, radius) {
  const half = w / 2;
  const x0 = Math.max(0, Math.floor(Math.min(x1, x2) - half - 1));
  const xe = Math.min(size - 1, Math.ceil(Math.max(x1, x2) + half + 1));
  const y0 = Math.max(0, Math.floor(Math.min(y1, y2) - half - 1));
  const ye = Math.min(size - 1, Math.ceil(Math.max(y1, y2) + half + 1));
  for (let y = y0; y <= ye; y++) {
    for (let x = x0; x <= xe; x++) {
      const d = distToSegment(x + 0.5, y + 0.5, x1, y1, x2, y2);
      let a = clamp01(half - d + 0.5) * 0.95;
      if (rounded) a *= roundedRectCoverage(x + 0.5, y + 0.5, size, radius);
      put(x, y, col, a);
    }
  }
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp01(((px - x1) * dx + (py - y1) * dy) / len2) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

const clamp01 = v => Math.min(1, Math.max(0, v));

/* ── Minimal PNG writer ─────────────────────────────────────────────── */

function png(px, size) {
  // One filter byte (0 = none) per scanline, then raw RGBA.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * size * 4, size * 4)
      .copy(raw, y * (size * 4 + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return c ^ -1;
}

/* ── Emit ───────────────────────────────────────────────────────────── */

mkdirSync(OUT, { recursive: true });

// iOS applies its own mask to the home-screen icon, so that one is square.
const targets = [
  ['apple-touch-icon.png', 180, false],
  ['icon-192.png', 192, true],
  ['icon-512.png', 512, true],
];

for (const [name, size, rounded] of targets) {
  writeFileSync(join(OUT, name), png(render(size, { rounded }), size));
  console.log(`wrote icons/${name} (${size}×${size})`);
}
