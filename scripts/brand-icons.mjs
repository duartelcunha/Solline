/**
 * Gera o ícone da app (apps/desktop/build/icon.ico e icon.png) a partir da geometria dos
 * bots (packages/ui/src/bot/geometry.ts): o bot âmbar da Solline num quadrado de carvão.
 *
 * Uso: node scripts/brand-icons.mjs [pasta-de-pré-visualização]
 *
 * Amostra as formas pixel a pixel (sem renderizador): os tamanhos grandes com 4x4 amostras
 * por pixel (bordas suaves); os de 24 px para baixo com uma amostra no centro de cada pixel,
 * para sair pixel art nítida em vez de uma mancha. Os tamanhos são os que o Windows 11 usa
 * na barra de tarefas e no explorador.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { botFrame, HOODS } = await import(
  pathToUrl(path.join(root, 'packages/ui/src/bot/geometry.ts'))
);

function pathToUrl(p) {
  return new URL(`file:///${p.replace(/\\/g, '/')}`).href;
}

const SIZES = [256, 64, 48, 40, 36, 32, 30, 24, 20, 16];
const PIXEL_ART = 24;

/* ---------- cores ---------- */

function oklchToRgb(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, c)) * 255);
  });
}

function parseOklch(css) {
  const [L, C, h] = css
    .match(/oklch\(([^)]+)\)/)[1]
    .split(/\s+/)
    .map(Number);
  return { L, C, h };
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hood = parseOklch(HOODS.solline);
const COLOURS = {
  ground: hex('#2b2824'),
  hood: oklchToRgb(hood.L, hood.C, hood.h),
  // A bainha é o capuz mais escuro (como o color-mix com preto da app).
  hem: oklchToRgb(hood.L * 0.78, hood.C * 0.78, hood.h),
  face: hex('#14120f'),
  eyes: hex('#ffd071'),
};

/* ---------- formas (na grelha de 256 dos bots) ---------- */

// O bot "à espera"; as medidas vêm da mesma geometria que a app desenha.
const frame = botFrame('waiting');
const nums = (d) => d.match(/-?\d+(\.\d+)?/g).map(Number);
const [hx0, hy, hrx, hry] = (() => {
  const [x0, y0, rx, ry] = nums(frame.hood);
  return [x0, y0, rx, ry];
})();
const HOOD = { cx: hx0 + hrx, cy: hy, rx: hrx, ry: hry };
const [fx0, fy, frx, fry] = nums(frame.face);
const FACE = { cx: fx0 + frx, cy: fy, rx: frx, ry: fry };
const [hemX0, hemY, hemX1] = nums(frame.hem);
const HEM = { x0: hemX0, x1: hemX1, y: hemY, r: 8 };
const EYES = frame.eyes.map((e) => {
  const [x0, y0, r] = nums(e.d);
  return { cx: x0 + r, cy: y0, r };
});

const inHalfEllipse = (x, y, e) =>
  y <= e.cy && ((x - e.cx) / e.rx) ** 2 + ((y - e.cy) / e.ry) ** 2 <= 1;

function colourAt(x, y, eyeScale = 1) {
  // Ordem de pintura: bainha por cima, depois olhos, cara, capuz.
  const cx = Math.min(Math.max(x, HEM.x0), HEM.x1);
  if (Math.hypot(x - cx, y - HEM.y) <= HEM.r) return COLOURS.hem;
  if (EYES.some((e) => y <= e.cy + 2 && Math.hypot(x - e.cx, y - e.cy) <= e.r * eyeScale)) {
    return COLOURS.eyes;
  }
  if (inHalfEllipse(x, y, FACE)) return COLOURS.face;
  if (inHalfEllipse(x, y, HOOD)) return COLOURS.hood;
  return null;
}

/* ---------- pixel art (24, 20 e 16 px, desenhados à mão) ---------- */

/**
 * Em tamanhos pequenos, amostrar dá uma mancha: cada linha é o conteúdo centrado dessa
 * linha do ícone (A capuz, F cara, E olhos, H bainha), a começar em `top`.
 */
const GRIDS = {
  24: {
    top: 4,
    rows: [
      'AAAAAA',
      'AAAAAAAAAA',
      'AAAAAAAAAAAA',
      'AAAAAAAAAAAAAA',
      'AAAAAFFFFAAAAA',
      'AAAAFFFFFFFFAAAA',
      'AAAFFFFFFFFFFAAA',
      'AAAFFFFFFFFFFFFAAA',
      'AAAFFFFFFFFFFFFAAA',
      'AAAFFEEFFFFEEFFAAA',
      'AAAFEEEEFFEEEEFAAA',
      'AAAFFFFFFFFFFFFAAA',
      'AAAFFFFFFFFFFFFAAA',
      'AAAFFFFFFFFFFFFAAA',
      'HHHHHHHHHHHHHHHHHHHH',
      'HHHHHHHHHHHHHHHHHHHH',
    ],
  },
  20: {
    top: 4,
    rows: [
      'AAAAAA',
      'AAAAAAAAAA',
      'AAAAAAAAAAAA',
      'AAAAFFFFAAAA',
      'AAAFFFFFFFFAAA',
      'AAAFFFFFFFFAAA',
      'AAAFEEFFEEFAAA',
      'AAAFEEFFEEFAAA',
      'AAAFFFFFFFFAAA',
      'AAAFFFFFFFFAAA',
      'HHHHHHHHHHHHHHHH',
    ],
  },
  16: {
    top: 3,
    rows: [
      'AAAA',
      'AAAAAAAA',
      'AAAAAAAAAA',
      'AAAAFFAAAA',
      'AAAFFFFFFAAA',
      'AAFFFFFFFFAA',
      'AAFEEFFEEFAA',
      'AAFFFFFFFFAA',
      'AAFFFFFFFFAA',
      'HHHHHHHHHHHHHH',
    ],
  },
};
const GRID_COLOURS = { A: 'hood', F: 'face', E: 'eyes', H: 'hem' };

function gridColour(size, px, py) {
  const grid = GRIDS[size];
  const row = grid.rows[py - grid.top];
  if (!row) return null;
  const start = (size - row.length) / 2;
  const key = row[px - start];
  return key ? COLOURS[GRID_COLOURS[key]] : null;
}

/* ---------- desenho ---------- */

/**
 * A janela da grelha de 256 que cabe no quadrado: o bot (196 de largura) fica com cerca de
 * 76% da largura do ícone, centrado na vertical.
 */
const SPAN = 258;
const BOX = { x: 128 - SPAN / 2, y: (38 + 166) / 2 - SPAN / 2, w: SPAN, h: SPAN };

function render(size) {
  const radius = size * 0.22;
  const samples = size <= PIXEL_ART ? 1 : 4;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const ux = (px + (sx + 0.5) / samples) / size;
          const uy = (py + (sy + 0.5) / samples) / size;
          // Quadrado de cantos redondos.
          const qx = Math.max(Math.abs(ux * size - size / 2) - (size / 2 - radius), 0);
          const qy = Math.max(Math.abs(uy * size - size / 2) - (size / 2 - radius), 0);
          if (Math.hypot(qx, qy) > radius) continue;
          // Do pixel para a grelha do bot (o bot fica um pouco abaixo do centro, assente).
          const x = BOX.x + ux * BOX.w;
          const y = BOX.y + uy * BOX.h;
          const c = (GRIDS[size] ? gridColour(size, px, py) : colourAt(x, y, 1)) ?? COLOURS.ground;
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
