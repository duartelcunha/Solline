/** Original cut-paper companions. Shape identifies the agent; eyes and posture communicate state. */
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
export type Tone = 'calm' | 'attention' | 'danger';
export const HOODS = {
  claude: '#df826f',
  codex: '#819bd1',
  reviewer: '#bd94bd',
  acp: '#e6b08f',
  other: '#9c89b9',
  solline: '#d2aa51',
  familiar: '#d2aa51',
} as const;
export type Hood = keyof typeof HOODS;
export const STATE_COLOURS = { attention: '#e8b64d', danger: '#d76464' };
export const VIEWBOX = '0 0 256 224';
export const HEM_WIDTH = 8;
export const EYE_STROKE = 6;
export const HOOD_ORIGIN = '128px 164px';
export interface EyePath {
  d: string;
  paint: 'fill' | 'stroke';
  layer?: 'pupil' | 'lid';
}
export interface BotFrame {
  hood: string;
  hoodTransform: string;
  hoodCss: string;
  face: string;
  hem: string;
  eyes: EyePath[];
  tone: Tone;
}
export interface BotPalette {
  hood: string;
  hem: string;
  face: string;
  eyes: string;
}

/** Each silhouette is authored rather than a random/noisy blob, and remains recognisable at 24 px. */
const SHAPES: Record<Hood, string> = {
  familiar:
    'M115 35C134 11 164 20 168 44C171 62 166 64 186 69C218 75 232 99 213 120C201 134 192 130 199 151C210 185 185 202 159 190C144 183 143 178 128 191C103 213 76 201 75 178C74 164 67 165 52 161C20 152 20 121 43 107C59 97 58 96 50 80C38 55 60 34 83 42C100 48 102 50 115 35Z',
  solline:
    'M115 35C134 11 164 20 168 44C171 62 166 64 186 69C218 75 232 99 213 120C201 134 192 130 199 151C210 185 185 202 159 190C144 183 143 178 128 191C103 213 76 201 75 178C74 164 67 165 52 161C20 152 20 121 43 107C59 97 58 96 50 80C38 55 60 34 83 42C100 48 102 50 115 35Z',
  claude:
    'M131 21L150 62L192 42L182 85L225 101L188 125L212 166L166 162L151 204L124 172L84 197L83 155L38 160L61 122L29 92L73 82L65 38L108 60Z',
  codex:
    'M87 37C111 25 128 41 129 57C145 30 171 31 183 49C192 61 184 79 177 88C209 77 229 95 224 115C221 129 205 135 191 136C215 150 210 178 189 184C172 189 157 177 149 166C153 196 131 209 111 199C97 192 94 179 96 167C75 191 47 182 44 162C41 145 55 135 69 130C37 124 29 101 43 84C55 71 72 76 81 82C68 62 72 44 87 37Z',
  reviewer:
    'M132 25L153 53L190 42L194 78L226 94L207 125L221 158L185 166L170 200L136 186L105 204L87 174L49 170L53 133L27 107L55 83L60 48L98 53Z',
  acp: 'M57 63C67 41 117 22 150 29C182 35 192 53 176 70C166 80 147 83 132 84C182 78 218 95 216 119C214 139 186 143 164 146C188 151 193 168 177 183C156 202 97 204 66 183C42 167 42 144 64 135C35 121 38 99 63 90C50 83 49 76 57 63Z',
  other:
    'M58 71C80 39 113 39 132 56C158 24 193 40 198 68C202 89 190 100 181 112C215 130 212 166 183 176C162 183 151 172 136 163C119 198 80 196 68 169C60 151 67 138 75 124C41 120 40 95 58 71Z',
};
const ellipse = (x: number, y: number, rx: number, ry: number) =>
  `M${x - rx} ${y}a${rx} ${ry} 0 1 0 ${rx * 2} 0a${rx} ${ry} 0 1 0 ${-rx * 2} 0Z`;
function eyes(mood: Mood): EyePath[] {
  const xs = [103, 153];
  if (mood === 'done')
    return xs.map((x) => ({
      d: `M${x - 13} 116Q${x} 96 ${x + 13} 116`,
      paint: 'stroke',
      layer: 'lid',
    }));
  if (mood === 'sleeping')
    return xs.map((x) => ({
      d: `M${x - 12} 116Q${x} 124 ${x + 12} 116`,
      paint: 'stroke',
      layer: 'lid',
    }));
  const curious = mood === 'needs-you';
  const reading = mood === 'reading';
  const surprised = mood === 'crashed';
  const centres = curious || surprised ? [99, 157] : xs;
  const whites: EyePath[] = centres.map((x, i) => ({
    d: ellipse(
      x,
      curious ? 105 + i * 9 : surprised ? 109 + i * 4 : 112,
      curious ? 24 - i * 5 : surprised ? 24 - i * 2 : 18,
      curious ? 31 - i * 9 : surprised ? 28 - i * 4 : reading ? 15 : 25,
    ),
    paint: 'fill',
  }));
  const pupils: EyePath[] = centres.map((x, i) => ({
    d: ellipse(
      x,
      curious ? 105 + i * 9 : surprised ? 115 + i * 2 : 113,
      curious ? 9 - i : surprised ? 8 : 10,
      curious ? 14 - i * 3 : surprised || reading ? 8 : 14,
    ),
    paint: 'fill',
    layer: 'pupil',
  }));
  // A soft "oh" signals a problem without an angry brow. Attention is a curious,
  // asymmetric glance, without a smile: eye shape and posture survive reduced motion.
  const expression: EyePath[] = surprised
    ? [
        {
          d: ellipse(128, 157, 9, 11),
          paint: 'stroke',
          layer: 'lid',
        },
      ]
    : [];
  return [...whites, ...pupils, ...expression];
}
export function botFrame(mood: Mood, hood: Hood = 'solline'): BotFrame {
  const posture =
    mood === 'sleeping'
      ? 'rotate(-7deg) scale(1.03, .94)'
      : mood === 'needs-you'
        ? 'rotate(7deg) translateY(-3px) scale(.97, 1.04)'
        : mood === 'crashed'
          ? 'rotate(-5deg) scale(1.03, .94)'
          : 'scale(1)';
  const svgPosture =
    mood === 'sleeping'
      ? 'rotate(-7 128 164)'
      : mood === 'needs-you'
        ? 'rotate(7 128 164) translate(0 -3)'
        : mood === 'crashed'
          ? 'rotate(-5 128 164)'
          : '';
  return {
    hood: SHAPES[hood],
    hoodTransform: svgPosture,
    hoodCss: posture,
    face: '',
    hem: 'M88 209H168',
    eyes: eyes(mood),
    tone: mood === 'needs-you' ? 'attention' : mood === 'crashed' ? 'danger' : 'calm',
  };
}
export function palette(hood: Hood, tone: Tone = 'calm'): BotPalette {
  return {
    hood: HOODS[hood],
    hem: tone === 'calm' ? `color-mix(in oklch, ${HOODS[hood]} 78%, black)` : STATE_COLOURS[tone],
    face: '#202128',
    eyes: '#fffdf4',
  };
}
export function botSvg(mood: Mood, hood: Hood, size = 64): string {
  const f = botFrame(mood, hood),
    p = palette(hood, f.tone);
  const markup = f.eyes
    .map(
      (e) =>
        `<path d="${e.d}" fill="${e.paint === 'fill' ? (e.layer === 'pupil' ? p.face : p.eyes) : 'none'}" stroke="${e.paint === 'stroke' ? p.face : 'none'}" stroke-width="${EYE_STROKE}" stroke-linecap="round"/>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}" width="${size}" height="${size}"><g transform="${f.hoodTransform}"><path d="${f.hood}" fill="${p.hood}"/>${markup}</g></svg>`;
}
