/**
 * A geometria dos bots da Solline: o Solline Pin de olhos abertos. A linha do tempo é a
 * bainha do capuz, o meio sol é o capuz, a abertura escura é outro meio sol e os olhos são
 * meios sóis pequenos. Tudo numa grelha de 256 (a do ícone da app), em funções puras: a app,
 * o gerador do ícone e os testes desenham a partir daqui.
 */

/** O humor do bot: o que a cara e o capuz mostram. */
export type Mood =
  'waiting' | 'working' | 'needs-you' | 'done' | 'crashed' | 'sleeping' | 'reading';

export const MOODS: readonly Mood[] = [
  'waiting',
  'working',
  'needs-you',
  'done',
  'crashed',
  'sleeping',
  'reading',
];

/**
 * A cor do estado vive na bainha (a linha da marca) e, quando é urgente, nos olhos: calma é
 * a cor do agente, atenção é âmbar ("precisa de ti"), perigo é vermelho ("caiu").
 */
export type Tone = 'calm' | 'attention' | 'danger';

const CX = 128;
const BASE = 150;
const HOOD_R = 84;
/** O capuz é mais alto do que largo: lê-se melhor num quadrado pequeno. */
const HOOD_RY = 112;
const FACE_R = 54;
const FACE_RY = 74;
const HEM_Y = 158;
const HEM_X0 = 38;
const HEM_X1 = 218;
const EYE_R = 13;
const EYE_Y = 128;
const EYE_DX = 22;

export const HEM_WIDTH = 16;
export const EYE_STROKE = 8;

/** A janela de desenho: o bot ao centro, a encher a largura. */
export const VIEWBOX = '24 -14 208 208';

export interface EyePath {
  d: string;
  /** fill: forma cheia; stroke: traço (olhos em arco, em X, fechados). */
  paint: 'fill' | 'stroke';
}

export interface BotFrame {
  /** O capuz (meio disco) e a sua transformação para o humor (levantado, descaído). */
  hood: string;
  hoodTransform: string;
  /** A mesma transformação em CSS (com HOOD_ORIGIN), para poder fazer transição. */
  hoodCss: string;
  /** A abertura escura onde vive a cara. */
  face: string;
  /** A bainha: a linha do tempo da marca. */
  hem: string;
  eyes: EyePath[];
  tone: Tone;
}

const num = (n: number) => Math.round(n * 100) / 100;

/** Meio disco (ou meia elipse) com o lado plano em baixo, centrado em (cx, cy). */
function halfDisc(cx: number, cy: number, r: number, ry = r): string {
  return `M${num(cx - r)} ${num(cy)}A${num(r)} ${num(ry)} 0 0 1 ${num(cx + r)} ${num(cy)}Z`;
}

function circle(cx: number, cy: number, r: number): string {
  return `M${num(cx - r)} ${num(cy)}a${num(r)} ${num(r)} 0 1 0 ${num(2 * r)} 0a${num(r)} ${num(r)} 0 1 0 ${num(-2 * r)} 0Z`;
}

function eyes(mood: Mood): EyePath[] {
  const xs = [CX - EYE_DX, CX + EYE_DX];
  switch (mood) {
    case 'working':
      // Três pontos no lugar dos olhos: está a pensar.
      return [CX - 24, CX, CX + 24].map((x) => ({ d: circle(x, EYE_Y - 4, 8), paint: 'fill' }));
    case 'needs-you':
      // Olhos grandes, a olhar para cima, para ti.
      return xs.map((x) => ({ d: circle(x, EYE_Y - 16, 15), paint: 'fill' }));
    case 'done':
      // Olhos em arco: contente.
      return xs.map((x) => ({
        d: `M${x - EYE_R} ${EYE_Y}A${EYE_R} ${EYE_R} 0 0 1 ${x + EYE_R} ${EYE_Y}`,
        paint: 'stroke',
      }));
    case 'crashed':
      return xs.map((x) => ({
        d: `M${x - 10} ${EYE_Y - 14}L${x + 10} ${EYE_Y + 6}M${x + 10} ${EYE_Y - 14}L${x - 10} ${EYE_Y + 6}`,
        paint: 'stroke',
      }));
    case 'sleeping':
      return xs.map((x) => ({ d: `M${x - EYE_R} ${EYE_Y - 3}H${x + EYE_R}`, paint: 'stroke' }));
    case 'reading':
      // Uma fenda a toda a largura da cara: está a varrer uma linha.
      return [{ d: `M${CX - 30} ${EYE_Y - 6}H${CX + 30}`, paint: 'stroke' }];
    default:
      return xs.map((x) => ({ d: halfDisc(x, EYE_Y, EYE_R), paint: 'fill' }));
  }
}

function hoodTransform(mood: Mood): string {
  // Pivô na bainha, ao centro: o capuz levanta-se ou descai a partir da base.
  const pivot = (t: string) => `translate(${CX} ${HEM_Y}) ${t} translate(${-CX} ${-HEM_Y})`;
  switch (mood) {
    case 'needs-you':
      return pivot('scale(1.05)');
    case 'crashed':
      return pivot('scale(1 0.9)');
    case 'sleeping':
      return pivot('scale(1 0.92)');
    default:
      return '';
  }
}

/** O pivô do capuz (o centro da bainha), em unidades da grelha. */
export const HOOD_ORIGIN = `${CX}px ${HEM_Y}px`;

function hoodCss(mood: Mood): string {
  switch (mood) {
    case 'needs-you':
      return 'scale(1.05)';
    case 'crashed':
      return 'scale(1, 0.9)';
    case 'sleeping':
      return 'scale(1, 0.92)';
    default:
      return 'scale(1)';
  }
}

function toneOf(mood: Mood): Tone {
  if (mood === 'needs-you') return 'attention';
  if (mood === 'crashed') return 'danger';
  return 'calm';
}

/** O desenho do bot para um humor, parado (a animação interpola entre estes). */
export function botFrame(mood: Mood): BotFrame {
  return {
    hood: halfDisc(CX, BASE, HOOD_R, HOOD_RY),
    hoodTransform: hoodTransform(mood),
    hoodCss: hoodCss(mood),
    face: halfDisc(CX, BASE, FACE_R, FACE_RY),
    hem: `M${HEM_X0} ${HEM_Y}H${HEM_X1}`,
    eyes: eyes(mood),
    tone: toneOf(mood),
  };
}

/**
 * Capuzes com a mesma luminosidade e pouca saturação: a cor diz quem é sem gritar. A cor
 * forte fica para o estado.
 */
export const HOODS = {
  claude: 'oklch(0.7 0.09 45)',
  codex: 'oklch(0.7 0.09 210)',
  reviewer: 'oklch(0.7 0.09 150)',
  acp: 'oklch(0.7 0.09 350)',
  other: 'oklch(0.7 0.09 265)',
  solline: 'oklch(0.79 0.145 82)',
  familiar: 'oklch(0.62 0.012 80)',
} as const;

export type Hood = keyof typeof HOODS;

export const STATE_COLOURS: Record<Exclude<Tone, 'calm'>, string> = {
  attention: 'oklch(0.79 0.145 82)',
  danger: 'oklch(0.66 0.18 28)',
};

/** As cores de um bot num tom: o capuz é a identidade; a bainha e os olhos dizem o estado. */
export interface BotPalette {
  hood: string;
  hem: string;
  face: string;
  eyes: string;
}

export function palette(hood: Hood, tone: Tone = 'calm'): BotPalette {
  const base = HOODS[hood];
  const calmEyes = hood === 'solline' ? '#ffd071' : '#fff1d6';
  return {
    hood: base,
    hem: tone === 'calm' ? `color-mix(in oklch, ${base} 78%, black)` : STATE_COLOURS[tone],
    face: '#14120f',
    eyes: tone === 'attention' ? STATE_COLOURS.attention : calmEyes,
  };
}

/** O bot como SVG em texto: para o gerador do ícone, pré-visualizações e testes. */
export function botSvg(mood: Mood, hood: Hood, size = 64): string {
  const f = botFrame(mood);
  const p = palette(hood, f.tone);
  const eyesMarkup = f.eyes
    .map((e) =>
      e.paint === 'fill'
        ? `<path d="${e.d}" fill="${p.eyes}"/>`
        : `<path d="${e.d}" fill="none" stroke="${p.eyes}" stroke-width="${EYE_STROKE}" stroke-linecap="round"/>`,
    )
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}" width="${size}" height="${size}">` +
    `<g transform="${f.hoodTransform}">` +
    `<path d="${f.hood}" fill="${p.hood}"/>` +
    `<path d="${f.face}" fill="${p.face}"/>` +
    eyesMarkup +
    `</g>` +
    `<path d="${f.hem}" stroke="${p.hem}" stroke-width="${HEM_WIDTH}" stroke-linecap="round"/>` +
    `</svg>`
  );
}
