/* Renders the app icon from tools/ship.mjs — the PNGs iOS wants for the
   home screen, and the SVG the browser uses as a favicon.

   Run with: node tools/make-icons.mjs

   Kept in the repo so the icons can be edited by moving a coordinate,
   rather than being opaque binaries nobody can open. No dependencies:
   the rasteriser and the PNG writer are both below. */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shapes, CLIPS, PALETTE } from './ship.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'icons');
const UNIT = 512;          // the space ship.mjs draws in
const SS = 4;              // subsamples per axis

/* ── Raster ─────────────────────────────────────────────────────────── */

/* Supersampled painter's algorithm: every shape is a hard in/out test at
   each subsample, and the antialiasing falls out of averaging the SS²
   samples in a pixel. Slower than analytic coverage, but it handles
   polygons, strokes, circles and clip paths with one code path — and it
   runs at build time, so the only thing it costs is a second. */
function render(size, { rounded = true } = {}) {
  const s = size / UNIT;
  const scene = shapes().map(sh => prepare(sh, s));
  const px = new Uint8ClampedArray(size * size * 4);

  const cx = size / 2, cy = size * 0.42, maxR = size * 0.72;
  const radius = size * 0.219;                          // 112/512
  const top = rgb(PALETTE.paperTop), edge = rgb(PALETTE.paperEdge);
  const step = 1 / SS, half = step / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px1 = x + sx * step + half, py1 = y + sy * step + half;
          if (rounded && outsideRounded(px1, py1, size, radius)) continue;

          // Ground first: warm paper, a shade deeper towards the edge.
          const t = Math.min(1, Math.hypot(px1 - cx, py1 - cy) / maxR);
          let col = [
            top[0] + (edge[0] - top[0]) * t,
            top[1] + (edge[1] - top[1]) * t,
            top[2] + (edge[2] - top[2]) * t,
          ];
          for (const sh of scene) if (hits(sh, px1, py1)) col = sh.rgb;

          r += col[0]; g += col[1]; b += col[2]; a += 255;
        }
      }

      const n = SS * SS, i = (y * size + x) * 4;
      // Un-premultiply: the colour is the average over *covered* samples,
      // while alpha is the coverage. Averaging over all SS² instead would
      // darken every rounded corner towards black.
      const cov = a / 255;
      if (cov > 0) { px[i] = r / cov; px[i + 1] = g / cov; px[i + 2] = b / cov; }
      px[i + 3] = a / n;
    }
  }
  return px;
}

function prepare(sh, s) {
  const out = { ...sh, rgb: rgb(sh.fill || sh.color) };
  if (sh.kind === 'circle') {
    out.c = [sh.c[0] * s, sh.c[1] * s];
    out.r = sh.r * s;
    out.bbox = [out.c[0] - out.r, out.c[1] - out.r, out.c[0] + out.r, out.c[1] + out.r];
  } else {
    out.pts = sh.pts.map(([x, y]) => [x * s, y * s]);
    const pad = sh.kind === 'stroke' ? (sh.width * s) / 2 + 1 : 1;
    out.bbox = bbox(out.pts, pad);
    if (sh.kind === 'stroke') out.half = (sh.width * s) / 2;
    if (sh.clip) out.clipPts = CLIPS[sh.clip].map(([x, y]) => [x * s, y * s]);
  }
  return out;
}

function hits(sh, x, y) {
  const [x0, y0, x1, y1] = sh.bbox;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  if (sh.clipPts && !inPolygon(sh.clipPts, x, y)) return false;

  if (sh.kind === 'circle') return Math.hypot(x - sh.c[0], y - sh.c[1]) <= sh.r;
  if (sh.kind === 'poly') return inPolygon(sh.pts, x, y);

  for (let i = 1; i < sh.pts.length; i++) {
    if (distToSegment(x, y, sh.pts[i - 1], sh.pts[i]) <= sh.half) return true;
  }
  return false;
}

function bbox(pts, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

/* Crossing number. The outlines are simple closed curves, so this and a
   winding rule agree everywhere it matters. */
function inPolygon(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(px, py, [x1, y1], [x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp01(((px - x1) * dx + (py - y1) * dy) / len2) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

const outsideRounded = (x, y, size, r) => {
  const dx = Math.max(r - x, x - (size - r), 0);
  const dy = Math.max(r - y, y - (size - r), 0);
  return dx > 0 && dy > 0 && Math.hypot(dx, dy) > r;
};

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

const rgb = hex => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/* ── SVG ────────────────────────────────────────────────────────────── */

/* Written from the same shape list, so the favicon is the same drawing
   the PNGs are, not a hand-kept copy of it. */
function svg() {
  const n = v => Math.round(v * 10) / 10;
  const pts = p => p.map(([x, y]) => `${n(x)},${n(y)}`).join(' ');
  const body = shapes().map(sh => {
    if (sh.kind === 'circle') {
      return `  <circle cx="${n(sh.c[0])}" cy="${n(sh.c[1])}" r="${n(sh.r)}" fill="${sh.fill}"/>`;
    }
    if (sh.kind === 'poly') {
      return `  <polygon points="${pts(sh.pts)}" fill="${sh.fill}"/>`;
    }
    const clip = sh.clip ? ` clip-path="url(#${sh.clip})"` : '';
    return `  <polyline points="${pts(sh.pts)}" fill="none" stroke="${sh.color}"` +
           ` stroke-width="${sh.width}" stroke-linecap="round" stroke-linejoin="round"${clip}/>`;
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${UNIT} ${UNIT}" width="${UNIT}" height="${UNIT}">
  <title>Odyssey</title>
  <defs>
    <radialGradient id="paper" cx="50%" cy="42%" r="72%">
      <stop offset="0%" stop-color="${PALETTE.paperTop}"/>
      <stop offset="100%" stop-color="${PALETTE.paperEdge}"/>
    </radialGradient>
${Object.entries(CLIPS).map(([id, poly]) =>
  `    <clipPath id="${id}"><polygon points="${pts(poly)}"/></clipPath>`).join('\n')}
  </defs>
  <rect width="${UNIT}" height="${UNIT}" rx="112" fill="url(#paper)"/>
${body}
</svg>
`;
}

/* ── Minimal PNG writer ─────────────────────────────────────────────── */

function png(px, size) {
  // One filter byte (0 = none) per scanline, then raw RGBA.
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  const src = Buffer.from(px.buffer, px.byteOffset, px.length);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    src.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA

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

writeFileSync(join(OUT, 'icon.svg'), svg());
console.log('wrote icons/icon.svg');

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
