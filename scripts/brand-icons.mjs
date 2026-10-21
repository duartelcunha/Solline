/**
 * Gera o ícone da app (apps/desktop/build/icon.ico e icon.png) com a marca da Solline: um sol
 * a nascer no horizonte, com o reflexo em duas linhas, num quadrado de carvão. A mesma
 * geometria do componente Logo (apps/desktop/src/renderer/src/components/logo.tsx), numa
 * grelha de 44.
 *
 * Uso: node scripts/brand-icons.mjs [pasta-de-pré-visualização]
 *
 * Amostra as formas pixel a pixel (sem renderizador), com 4x4 amostras por pixel. Os de 24 px
 * para baixo são pixel art desenhada à mão (ROWS), para saírem nítidos em vez de uma mancha.
 * Os tamanhos são os que o Windows 11 usa na barra de tarefas e no explorador.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SIZES = [256, 64, 48, 40, 36, 32, 30, 24, 20, 16];

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const GROUND = hex('#1b1916');
const SUN = hex('#e8ae45');

/* ---------- formas (na grelha de 44, como o Logo) ---------- */

const SUN_SHAPE = { cx: 22, cy: 23, r: 12 };
const LINES = [
  { x0: 12, x1: 32, y: 28.5, r: 1.5 },
  { x0: 16.5, x1: 27.5, y: 33.5, r: 1.5 },
];

function isSun(x, y) {
  if (y <= SUN_SHAPE.cy && Math.hypot(x - SUN_SHAPE.cx, y - SUN_SHAPE.cy) <= SUN_SHAPE.r)
    return true;
  return LINES.some((l) => {
    const dx = Math.max(l.x0 - x, 0, x - l.x1);
    return Math.hypot(dx, y - l.y) <= l.r;
  });
}

/**
 * Pixel art: por tamanho, [linha, largura] de cada fila âmbar, centradas. O sol é um meio
 * disco; o reflexo são duas filas mais curtas.
 */
const ROWS = {
  24: [
    [7, 4],
    [8, 8],
    [9, 10],
    [10, 12],
    [11, 12],
    [12, 12],
    [15, 10],
    [17, 6],
  ],
  20: [
    [5, 4],
    [6, 8],
    [7, 10],
    [8, 10],
    [9, 10],
    [12, 8],
    [14, 4],
  ],
  16: [
    [4, 4],
    [5, 6],
    [6, 8],
    [7, 8],
    [9, 6],
    [11, 4],
  ],
};

function pixelSun(size, px, py) {
  return ROWS[size].some(([row, width]) => row === py && Math.abs(px + 0.5 - size / 2) < width / 2);
}

function render(size) {
  const radius = size * 0.25;
  const samples = ROWS[size] ? 1 : 4;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const ux = px + (sx + 0.5) / samples;
          const uy = py + (sy + 0.5) / samples;
          // Quadrado de cantos redondos.
          const qx = Math.max(Math.abs(ux - size / 2) - (size / 2 - radius), 0);
          const qy = Math.max(Math.abs(uy - size / 2) - (size / 2 - radius), 0);
          if (Math.hypot(qx, qy) > radius) continue;
          const sun = ROWS[size]
            ? pixelSun(size, px, py)
            : isSun((ux / size) * 44, (uy / size) * 44);
          const c = sun ? SUN : GROUND;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 255;
        }
      }
      const n = samples * samples;
      const i = (py * size + px) * 4;
      out[i] = a ? Math.round(r / (a / 255)) : 0;
      out[i + 1] = a ? Math.round(g / (a / 255)) : 0;
      out[i + 2] = a ? Math.round(b / (a / 255)) : 0;
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

/* ---------- PNG e ICO ---------- */

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([head, ...entries, ...images.map((i) => i.data)]);
}

const images = SIZES.map((size) => ({ size, data: png(size, render(size)) }));
const build = path.join(root, 'apps/desktop/build');
mkdirSync(build, { recursive: true });
writeFileSync(path.join(build, 'icon.ico'), ico(images));
writeFileSync(path.join(build, 'icon.png'), images[0].data);
const preview = process.argv[2];
if (preview) {
  mkdirSync(preview, { recursive: true });
  for (const { size, data } of images) writeFileSync(path.join(preview, `icon-${size}.png`), data);
}
console.log(`icon.ico (${SIZES.join(', ')} px) e icon.png em ${build}`);
