// The effort icon: what the slider knob and the collapsed bar show for "how
// hard Claude thinks". Five concepts, one engine. Pure: no `$`, no I/O,
// deterministic for a given view (every time is ms on the caller's clock).
//
//   star      the Claude starburst (coral): 3 short rays .. 12 full rays + glow
//   pet       the Claude Code pixel pet, hi-res (./pet-hires), its pose per level
//             (the default since 0.7.0). A `play` (a level change, a hover) runs
//             the level's designed sequence in whole-pixel frames, then holds the
//             static rest frame; nothing loops at rest, reduced motion is static
//   moon      new moon (thin crescent) .. full moon (+ halo)
//   dumbbell  plates added per level; at max the bar bends
//   wave      a thin sine line, amplitude and frequency grow
//
// Same shape as ./pet so ./svg can swap one for the other: a view in, one SVG
// fragment centred on (0, 0) out; one-shot records (a level or kind change, the
// acknowledgement beat) started from the values on screen and re-emitted with a
// negative SMIL begin, so a swap mid-way continues the same curve; an end time.
//
// Audit rules: clean vector, ~20 px glyph, stroke 1.5 where it is line art.
// Every geometry is a path whose numbers are affine in the parameters a level
// sets, so SMIL's linear path interpolation under a keySpline is exactly the
// eased parameter curve (what sample() replays). A level change lasts
// ICON_MS.change (280 ms, ease-out), the acknowledgement beat 280 ms, at most
// ICON_MAX_ANIMATED elements per change. Nothing moves at rest; reduced motion
// draws the target at once.

import type { Family } from './parse'
import { MODEL_TINT } from './pet'
import { petHiresMarkup, petHiresPlayMs } from './pet-hires'

export type EffortIconKind = 'star' | 'pet' | 'moon' | 'dumbbell' | 'wave'
export const EFFORT_ICONS: readonly EffortIconKind[] = ['star', 'pet', 'moon', 'dumbbell', 'wave']
export const DEFAULT_ICON: EffortIconKind = 'pet'
type Theme = 'dark' | 'light'

/** On-screen values of the icon's tweened keys (JSON-serializable), as iconSnapshot samples them. */
export type IconVals = Record<string, number[]>
/** A level (or kind) change: what was drawn before, when it started, and the values on screen then. */
export type IconChange = {
  level: number
  kind: EffortIconKind
  start: number
  from?: IconVals
  /** most elements this change may animate (default ICON_MAX_ANIMATED); the card passes 3 when the knob slides too */
  max?: number
}
/** The acknowledgement beat of the icon on screen (an effort change took effect). */
export type IconReaction = { level: number; kind: EffortIconKind; start: number; from?: IconVals }

export type IconView = {
  kind: EffortIconKind
  /** effort level 0 low .. 4 max; rounded and clamped */
  level: number
  /** the selected model: tints the active parts of the neutral icons (moon, dumbbell, wave) */
  model: Family
  change: IconChange | null
  reaction: IconReaction | null
  now: number
  reduced: boolean
  theme: Theme
  /** prefix for every id in the fragment; sanitised to [A-Za-z0-9_] */
  idPrefix: string
  /**
   * optional, pet only: the level's designed play started at `start` (ms). Drawn while `now` is
   * inside it (a whole-pixel strip, one discrete SMIL track); absent, past its end, for another
   * level, or reduced: the rest frame alone.
   */
  play?: PetPlay | null
}

/** A pet play: the level whose sequence runs, and when it started (ms). */
export type PetPlay = { level: number; start: number }

/** When a pet play ends (ms): past it nothing of it is drawn. */
export const petPlayEnd = (play: PetPlay): number => play.start + petHiresPlayMs(play.level)

export const ICON_EASE = {
  /** every leg: entrances, exits, responses to input, both legs of the one-beat reaction */
  out: '.16 1 .3 1',
} as const

export const ICON_MS = {
  /** a level change, and the new icon fading in on a kind change */
  change: 280,
  /** the old icon fading out on a kind change (20% shorter) */
  exit: 224,
  /** the acknowledgement beat (an effort change took effect) */
  reaction: 280,
} as const

/** Most animated elements a single change may start (audit rule). */
export const ICON_MAX_ANIMATED = 4

export const CORAL = '#D97757'

/* ================= palette ================= */

type Pal = {
  theme: Theme
  ink: string
  muted: string
  /** the active parts: a light tinted neutral on the dark knob, the model's own dark ink on the light one */
  accent: string
  /** a pale fill for lit areas outlined in `accent` (light theme moon) */
  pale: string
  glow: number
}
const BASE: Record<Theme, { ink: string; muted: string; mix: number; glow: number }> = {
  dark: { ink: '#E6E6E6', muted: '#939398', mix: 0.42, glow: 1 },
  light: { ink: '#1D1D1F', muted: '#6B6B70', mix: 0, glow: 0.75 },
}
/**
 * Light theme inks per model: clean and dark enough for >= 3:1 on the white
 * knob (a neutral mixed with the tint went greyish-brown with Opus).
 */
export const LIGHT_INK: Readonly<Record<Family, string>> = { haiku: '#9E6F18', sonnet: '#1F826B', opus: '#BE5D3B', fable: '#6657CC' }
const rgbOf = (h: string): number[] => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const hex = (c: readonly number[]): string =>
  '#' + c.map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('').toUpperCase()
const mix = (a: string, b: string, t: number): string => {
  const A = rgbOf(a), B = rgbOf(b)
  return hex(A.map((x, i) => x + ((B[i] ?? 0) - x) * t))
}
function palette(theme: Theme, model: Family): Pal {
  const t: Theme = theme === 'light' ? 'light' : 'dark'
  const b = BASE[t]
  const accent = t === 'light' ? LIGHT_INK[model] ?? LIGHT_INK.opus : mix(b.ink, MODEL_TINT[model] ?? CORAL, b.mix)
  return { theme: t, ink: b.ink, muted: b.muted, accent, pale: mix('#FFFFFF', MODEL_TINT[model] ?? CORAL, 0.16), glow: b.glow }
}

/* ================= small helpers ================= */

const r2 = (x: number): number => {
  const r = Math.round(x * 100) / 100
  return Object.is(r, -0) ? 0 : r
}
const r3 = (x: number): number => {
  const r = Math.round(x * 1000) / 1000
  return Object.is(r, -0) ? 0 : r
}
const at = (a: readonly number[] | undefined, i: number): number => (a ? (a[i] ?? 0) : 0)
const eqv = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((x, i) => Math.abs(x - at(b, i)) < 1e-3)
const lvl = (x: number): number => Math.max(0, Math.min(4, Math.round(Number.isFinite(x) ? x : 0)))
const kindOf = (k: unknown): EffortIconKind => ((EFFORT_ICONS as readonly unknown[]).includes(k) ? (k as EffortIconKind) : DEFAULT_ICON)
const safeId = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, '_')

/* ================= the five concepts ================= */

type Draw = {
  /** the key's value (static attribute) */
  v: (k: string) => number[]
  /** the key's SMIL animate on `attr`, '' when still; `fn` maps the key's value to the attribute */
  an: (k: string, attr: string, fn: (v: number[]) => string) => string
  /** SMIL on `attr` for a value built from several keys of one element (they tween together) */
  anMulti: (keys: readonly string[], attr: string, fn: (get: (k: string) => number[]) => string) => string
  /** the key has a track in flight */
  animating: (k: string) => boolean
  P: Pal
  /** the level drawn */
  L: number
  /** the fragment's id prefix (sanitised) */
  id: string
  /** filter attribute for a soft glow (declares the filter) */
  blur: () => string
  /** the pet's play in flight at the drawn instant (ms since it started), or null: the rest frame */
  play: { elapsed: number } | null
}
/** A per-element group of keys; the first elements are kept first when a change is over budget. */
type El = { name: string; keys: readonly string[] }
type React = {
  /** scale origin */
  anchor: readonly [number, number]
  /** scale offsets from 1 [t, sx, sy] */
  s?: readonly (readonly number[])[]
  /** translate y [t, y] */
  ty?: readonly (readonly number[])[]
  /** a flash under the glyph: soft disc (blur) or a ripple ring growing r0 -> r1 */
  flash?: { r0: number; r1?: number; peak: number; ring?: boolean }
}
type Spec = {
  els: readonly El[]
  targets: (L: number) => IconVals
  draw: (d: Draw) => string
  /** flash colour at this level */
  flashColor: (P: Pal, L: number) => string
  react: React
}

const pathAttr = (d: Draw, k: string, fn: (v: number[]) => string): string => `d="${fn(d.v(k))}"`
const op = (x: number): string => `${r3(x)}`

/* ---- star: the Claude starburst, 12 rays from the centre, round caps ---- */

const RAY_DIR = Array.from({ length: 12 }, (_, i) => {
  const a = ((-90 + 30 * i) * Math.PI) / 180
  return [Math.cos(a), Math.sin(a)] as const
})
const STAR_LENS: readonly (readonly number[])[] = [
  [4.4, 0, 0, 0, 4.4, 0, 0, 0, 4.4, 0, 0, 0],
  [5.8, 0, 5.8, 0, 5.8, 0, 5.8, 0, 5.8, 0, 5.8, 0],
  [7.2, 4.2, 7.2, 4.2, 7.2, 4.2, 7.2, 4.2, 7.2, 4.2, 7.2, 4.2],
  [8.4, 6.6, 8.4, 6.6, 8.4, 6.6, 8.4, 6.6, 8.4, 6.6, 8.4, 6.6],
  [9.6, 8.5, 9.2, 8.3, 9.8, 8.7, 9.3, 8.4, 9.7, 8.6, 9.1, 8.5],
]
const rays = (len: number[]): string =>
  RAY_DIR.map(([x, y], i) => `M0 0L${r2(x * at(len, i))} ${r2(y * at(len, i))}`).join('')

const STAR: Spec = {
  els: [{ name: 'rays', keys: ['rays'] }, { name: 'glow', keys: ['glow'] }],
  targets: L => ({ rays: [...(STAR_LENS[L] ?? [])], glow: [L === 4 ? 1 : 0] }),
  draw: d => {
    let s = ''
    if (d.animating('glow') || at(d.v('glow'), 0) > 0) {
      const g = (v: number[]): string => op(at(v, 0) * 0.32 * d.P.glow)
      s += `<circle r="7.5" fill="${CORAL}" opacity="${g(d.v('glow'))}" ${d.blur()}>${d.an('glow', 'opacity', g)}</circle>`
    }
    s += `<path ${pathAttr(d, 'rays', rays)} fill="none" stroke="${CORAL}" stroke-width="1.9" stroke-linecap="round">${d.an('rays', 'd', rays)}</path>`
    return s
  },
  flashColor: () => CORAL,
  react: { anchor: [0, 0], s: [[0, 0, 0], [0.3, 0.16, 0.16], [1, 0, 0]], flash: { r0: 8, peak: 0.34 } },
}

/* ---- pet: the hi-res pixel pet (./pet-hires), its pose per level, at rest; the beat is a 2 px hop ---- */

const PET: Spec = {
  els: [],
  targets: () => ({}),
  draw: d => petHiresMarkup(d.L, d.P.theme, d.play),
  flashColor: () => CORAL,
  react: { anchor: [0, 0], ty: [[0, 0], [0.35, -2], [1, 0]] },
}

/* ---- moon: the lit shape is the right half-disc closed by the terminator (x = tx at the equator) ---- */

const MR = 8
const KAPPA = 0.5523
const lit = (v: number[]): string => {
  const tx = at(v, 0), k = r2(KAPPA * MR), kt = r2(KAPPA * tx), t = r2(tx)
  return `M0 ${-MR}C${k} ${-MR} ${MR} ${-k} ${MR} 0C${MR} ${k} ${k} ${MR} 0 ${MR}C${kt} ${MR} ${t} ${k} ${t} 0C${t} ${-k} ${kt} ${-MR} 0 ${-MR}Z`
}
/** lit fraction 0 (new) .. 1 (full) -> terminator x */
const PHASE = [0.1, 0.3, 0.5, 0.76, 1]
const MOON: Spec = {
  els: [{ name: 'lit', keys: ['tx'] }, { name: 'halo', keys: ['halo'] }],
  targets: L => ({ tx: [MR * (1 - 2 * (PHASE[L] ?? 0))], halo: [L === 4 ? 1 : 0] }),
  draw: d => {
    let s = ''
    if (d.animating('halo') || at(d.v('halo'), 0) > 0) {
      const g = (v: number[]): string => op(at(v, 0) * 0.3 * d.P.glow)
      s += `<circle r="${MR + 0.5}" fill="${d.P.accent}" opacity="${g(d.v('halo'))}" ${d.blur()}>${d.an('halo', 'opacity', g)}</circle>`
    }
    s += `<circle r="${MR - 0.6}" fill="none" stroke="${d.P.muted}" stroke-opacity=".55" stroke-width="1.2"/>`
    /* dark knob: the lit part is a light disc; light knob: a pale disc with a thin ink outline (never a dark disc) */
    const paint = d.P.theme === 'light' ? `fill="${d.P.pale}" stroke="${d.P.accent}" stroke-width="1.1" stroke-linejoin="round"` : `fill="${d.P.accent}"`
    s += `<path ${pathAttr(d, 'tx', lit)} ${paint}>${d.an('tx', 'd', lit)}</path>`
    return s
  },
  flashColor: P => P.accent,
  react: { anchor: [0, 0], s: [[0, 0, 0], [0.3, 0.07, 0.07], [1, 0, 0]], flash: { r0: 9, peak: 0.36 } },
}

/* ---- dumbbell: plates (round-capped strokes) stack out from the grip; the bar grows with them and sags at max ---- */

const PLATE_X = [3.4, 5.7, 8, 10.3]
/** plate heights per level (0 = not loaded) */
const DB_H: readonly (readonly number[])[] = [
  [7, 0, 0, 0],
  [9, 6.8, 0, 0],
  [10.4, 8.2, 6, 0],
  [11.2, 9, 6.8, 4.6],
  [12, 9.8, 7.6, 5.4],
]
const DB_SAG = 1.9
const DB_END = 11.8
/** plates: px (4 x), ph (4 heights), py (4 centre y). A plate not loaded sits inside the last loaded one, height 0. */
const plates = (px: number[], ph: number[], py: number[]): string => {
  let s = ''
  for (const side of [-1, 1]) {
    for (let j = 0; j < 4; j++) {
      const x = r2(side * at(px, j)), h = at(ph, j), y = at(py, j)
      s += `M${x} ${r2(y - h / 2)}L${x} ${r2(y + h / 2)}`
    }
  }
  return s
}
/** bar: [half length, end y, control y] (a quadratic: the centre stays on y 0 while the ends sag) */
const bar = (v: number[]): string => `M${r2(-at(v, 0))} ${r2(at(v, 1))}Q0 ${r2(at(v, 2))} ${r2(at(v, 0))} ${r2(at(v, 1))}`
const DUMBBELL: Spec = {
  els: [{ name: 'plates', keys: ['px', 'ph', 'py'] }, { name: 'bar', keys: ['bd'] }],
  targets: L => {
    const h = DB_H[L] ?? DB_H[0]!
    let last = PLATE_X[0] ?? 0
    const px = PLATE_X.map((x, j) => (at(h, j) > 0 ? (last = x) : last))
    const droop = L === 4 ? DB_SAG : 0
    const end = Math.min(DB_END, last + 2.2)
    return { px, ph: [...h], py: px.map(x => droop * (x / DB_END) * (x / DB_END)), bd: [end, droop, -droop] }
  },
  draw: d => {
    const pl = (g: (k: string) => number[]): string => plates(g('px'), g('ph'), g('py'))
    let s = `<path ${pathAttr(d, 'bd', bar)} fill="none" stroke="${d.P.muted}" stroke-width="1.5" stroke-linecap="round">${d.an('bd', 'd', bar)}</path>`
    s += `<path d="${pl(d.v)}" fill="none" stroke="${d.P.accent}" stroke-width="1.8" stroke-linecap="round">${d.anMulti(['px', 'ph', 'py'], 'd', pl)}</path>`
    return s
  },
  flashColor: P => P.accent,
  react: { anchor: [0, 0], ty: [[0, 0], [0.35, -2.5], [1, 0]] },
}

/* ---- wave: 37 samples of an enveloped sine; amplitude and frequency grow ---- */

const WN = 36
const WX = Array.from({ length: WN + 1 }, (_, i) => -9.5 + (19 * i) / WN)
const WAVE_AF: readonly (readonly [number, number])[] = [[0.9, 1], [2.1, 1.5], [3.3, 2], [4.5, 2.5], [5.6, 3.5]]
const waveY = (A: number, f: number): number[] => WX.map(x => -A * Math.cos((Math.PI * x) / 20) * Math.sin((2 * Math.PI * f * (x + 9.5)) / 19))
const waveD = (y: number[]): string => WX.map((x, i) => `${i ? 'L' : 'M'}${r2(x)} ${r2(at(y, i))}`).join('')
const WAVE: Spec = {
  els: [{ name: 'line', keys: ['wy'] }],
  targets: L => {
    const [A, f] = WAVE_AF[L] ?? WAVE_AF[0]!
    return { wy: waveY(A, f) }
  },
  draw: d =>
    `<path ${pathAttr(d, 'wy', waveD)} fill="none" stroke="${d.P.accent}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke">${d.an('wy', 'd', waveD)}</path>`,
  flashColor: P => P.accent,
  react: { anchor: [0, 0], s: [[0, 0, 0], [0.3, 0, 0.4], [1, 0, 0]] },
}

const SPECS: Record<EffortIconKind, Spec> = { star: STAR, pet: PET, moon: MOON, dumbbell: DUMBBELL, wave: WAVE }

/* ================= tracks ================= */

/** keyframes over `dur` ms from `t0` (spline per segment) */
type Trk = { kf: number[][]; kt: number[]; ks: string[]; dur: number; t0: number }
type Val = { v: number[]; tr: Trk | null }

function bez(s: string, x: number): number {
  const [x1 = 0, y1 = 0, x2 = 1, y2 = 1] = s.split(' ').map(Number)
  if (x <= 0) return 0
  if (x >= 1) return 1
  let lo = 0, hi = 1, t = x
  for (let i = 0; i < 28; i++) {
    t = (lo + hi) / 2
    const cx = 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t
    if (cx < x) lo = t
    else hi = t
  }
  return 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t
}

/** The value on screen at `now` (replica of SMIL spline interpolation). */
function sample(tr: Trk, now: number): number[] {
  const u = (now - tr.t0) / tr.dur
  const last = tr.kf[tr.kf.length - 1] ?? []
  if (u >= 1) return last.slice()
  if (u <= 0) return (tr.kf[0] ?? []).slice()
  let k = 0
  while (k < tr.kt.length - 2 && u >= at(tr.kt, k + 1)) k++
  const k0 = at(tr.kt, k)
  const e = bez(tr.ks[k] ?? ICON_EASE.out, (u - k0) / (at(tr.kt, k + 1) - k0))
  const a = tr.kf[k] ?? [], b = tr.kf[k + 1] ?? []
  return a.map((x, j) => x + (at(b, j) - x) * e)
}
const live = (tr: Trk | null, now: number): tr is Trk => !!tr && now >= tr.t0 && now - tr.t0 < tr.dur
const valOf = (tr: Trk | null, to: number[], now: number): Val => (live(tr, now) ? { v: sample(tr, now), tr } : { v: to, tr: null })
function tween(cur: number[], to: number[], dur: number, t0: number): Trk | null {
  if (cur.length !== to.length || eqv(cur, to)) return null
  return { kf: [cur, to], kt: [0, 1], ks: [ICON_EASE.out], dur, t0 }
}
/** A one-beat kick: authored offsets from `rest`, plus the on-screen offset decaying to 0 over the beat. */
function kick(f: readonly (readonly number[])[], rest: number[], cur: number[], dur: number, t0: number, gain = 1): Trk | null {
  const kf = f.map(fr => rest.map((r, j) => r + at(fr, j + 1) * gain + (at(cur, j) - r) * (1 - at(fr, 0))))
  if (kf.every(v => eqv(v, kf[0] ?? []))) return null
  return { kf, kt: f.map(fr => at(fr, 0)), ks: f.slice(1).map(() => ICON_EASE.out), dur, t0 }
}

/* ================= records -> values ================= */

const REACT_KEYS = ['rs', 'ry', 'rf', 'rr'] as const
const restOf = (S: Spec): IconVals => ({ rs: [1, 1], ry: [0], rf: [0], rr: [S.react.flash?.r0 ?? 0] })
const changeKeys = (S: Spec): string[] => ['ko', ...S.els.flatMap(e => e.keys)]

type Resolved = {
  kind: EffortIconKind
  L: number
  vals: Record<string, Val>
  /** the previous kind, fading out (kind change in flight) */
  old: { kind: EffortIconKind; L: number; vals: Record<string, Val> } | null
}

function resolve(p: IconView): Resolved {
  const kind = kindOf(p.kind)
  const S = SPECS[kind]
  const L = lvl(p.level)
  const tg: IconVals = { ko: [1], ...S.targets(L), ...restOf(S) }
  const vals: Record<string, Val> = {}
  for (const [k, v] of Object.entries(tg)) vals[k] = { v, tr: null }
  let old: Resolved['old'] = null
  if (p.reduced) return { kind, L, vals, old }
  const now = p.now
  const c = p.change && p.change.start <= now ? p.change : null
  const r = p.reaction && p.reaction.start <= now ? p.reaction : null
  /* change keys and reaction keys are disjoint: the order does not matter */
  const applyReaction = (): void => {
    if (!r) return
    const rest = restOf(S), cur = (k: string): number[] => (r.from && r.from[k] && r.from[k].length === (rest[k] ?? []).length ? r.from[k] : rest[k]) ?? [0]
    const R = S.react, dur = ICON_MS.reaction, gain = 0.75 + 0.125 * lvl(r.level)
    const fl = R.flash
    const tr: Record<string, Trk | null> = {
      rs: R.s ? kick(R.s, [1, 1], cur('rs'), dur, r.start, gain) : tween(cur('rs'), [1, 1], ICON_MS.change, r.start),
      ry: R.ty ? kick(R.ty, [0], cur('ry'), dur, r.start, gain) : tween(cur('ry'), [0], ICON_MS.change, r.start),
      /* a ripple caught mid-way continues from the ring on screen */
      rf: fl ? (fl.ring ? tween([at(cur('rf'), 0) > 0.02 ? at(cur('rf'), 0) : fl.peak], [0], dur, r.start) : kick([[0, 0], [0.3, fl.peak], [1, 0]], [0], cur('rf'), dur, r.start)) : null,
      rr: fl && fl.ring && fl.r1 !== undefined ? tween(cur('rr'), [fl.r1], dur, r.start) : null,
    }
    for (const k of REACT_KEYS) vals[k] = valOf(tr[k] ?? null, tg[k] ?? [0], now)
  }
  if (c) {
    const reserved = r && r.start === c.start ? (S.react.flash ? 2 : 1) : 0
    if (kindOf(c.kind) === kind) {
      const def: IconVals = { ko: [1], ...S.targets(lvl(c.level)) }
      const cur = (k: string): number[] => {
        const f = c.from && c.from[k]
        return f && f.length === (tg[k] ?? []).length ? f : def[k] ?? tg[k] ?? [0]
      }
      const els: El[] = [{ name: 'group', keys: ['ko'] }, ...S.els]
      let budget = Math.min(ICON_MAX_ANIMATED, c.max ?? ICON_MAX_ANIMATED) - reserved
      for (const el of els) {
        const trs = el.keys.map(k => [k, tween(cur(k), tg[k] ?? [0], ICON_MS.change, c.start)] as const)
        if (!trs.some(([, t]) => t)) continue
        const keep = budget > 0
        if (keep) budget--
        for (const [k, t] of trs) vals[k] = keep ? valOf(t, tg[k] ?? [0], now) : { v: tg[k] ?? [0], tr: null }
      }
    } else {
      /* kind change: the old glyph fades out where it was, the new one fades in (2 elements) */
      const ok = kindOf(c.kind), OS = SPECS[ok], oL = lvl(c.level)
      const otg: IconVals = { ko: [1], ...OS.targets(oL), ...restOf(OS) }
      const ov: Record<string, Val> = {}
      for (const [k, v] of Object.entries(otg)) {
        const f = c.from && c.from[k]
        ov[k] = { v: f && f.length === v.length ? f : v, tr: null }
      }
      const o0 = at(ov.ko?.v, 0)
      const fade = valOf(tween([o0], [0], ICON_MS.exit, c.start), [0], now)
      if (fade.tr) {
        ov.ko = fade
        old = { kind: ok, L: oL, vals: ov }
      }
      vals.ko = valOf(tween([0], [1], ICON_MS.change, c.start), [1], now)
    }
  }
  applyReaction()
  return { kind, L, vals, old }
}

const pick = (v: IconVals, keys: readonly string[]): IconVals => Object.fromEntries(keys.filter(k => v[k]).map(k => [k, v[k] ?? [0]]))

/** The values the icon draws at `atMs` (every tweened key). */
export function iconSnapshot(view: IconView, atMs: number): IconVals {
  const { vals } = resolve({ ...view, now: atMs })
  return Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, v.v.map(r3)]))
}

/**
 * A level or kind change starting at `now`, from what `prev` draws at `now` (the target is the view drawn next).
 */
export function startIconChange(prev: IconView, now: number): IconChange {
  const kind = kindOf(prev.kind)
  return { level: lvl(prev.level), kind, start: now, from: pick(iconSnapshot(prev, now), changeKeys(SPECS[kind])) }
}
/** The acknowledgement beat of the icon on screen, from its current reaction values. */
export function startIconReaction(prev: IconView, now: number): IconReaction {
  const kind = kindOf(prev.kind)
  return { level: lvl(prev.level), kind, start: now, from: pick(iconSnapshot(prev, now), REACT_KEYS) }
}

/** Latest end (ms) of anything in flight after view.now, or null at rest: schedule the settle render there. */
export function iconEnd(view: Pick<IconView, 'change' | 'reaction' | 'now' | 'reduced'>): number | null {
  if (view.reduced) return null
  const ends: number[] = []
  if (view.change) ends.push(view.change.start + ICON_MS.change)
  if (view.reaction) ends.push(view.reaction.start + ICON_MS.reaction)
  const end = Math.max(-Infinity, ...ends)
  return end > view.now ? end : null
}

/* ================= markup ================= */

function smil(tr: Trk | null, now: number, attr: string, fn: (v: number[]) => string, type?: string): string {
  if (!tr || !live(tr, now)) return ''
  const vs = tr.kf.map(fn)
  if (vs.every(x => x === vs[0])) return ''
  const head = type ? `animateTransform attributeName="transform" type="${type}"` : `animate attributeName="${attr}"`
  return `<${head} values="${vs.join(';')}" keyTimes="${tr.kt.map(r3).join(';')}" calcMode="spline" keySplines="${tr.ks.join(';')}" dur="${r3(tr.dur / 1000)}s" begin="${r3(-(now - tr.t0) / 1000)}s" fill="freeze"/>`
}

/** One kind's glyph from resolved values (animations only when `now` is given). */
function glyph(kind: EffortIconKind, L: number, vals: Record<string, Val>, now: number | null, P: Pal, blurUsed: { on: boolean; id: string }, id: string, play: { elapsed: number } | null = null): string {
  const S = SPECS[kind]
  const V = (k: string): Val => vals[k] ?? { v: [0], tr: null }
  /* every track in a glyph is a two-keyframe tween of one change: keys of one element share start, length and curve */
  const anMulti = (keys: readonly string[], attr: string, fn: (get: (k: string) => number[]) => string): string => {
    if (now === null) return ''
    const t0 = keys.map(k => V(k).tr).find((t): t is Trk => !!t && live(t, now))
    if (!t0) return ''
    const end = (i: 0 | 1) => (k: string): number[] => {
      const tr = V(k).tr
      return tr && live(tr, now) ? (i === 0 ? tr.kf[0] : tr.kf[tr.kf.length - 1]) ?? V(k).v : V(k).v
    }
    return smil({ kf: [[0], [1]], kt: [0, 1], ks: t0.ks, dur: t0.dur, t0: t0.t0 }, now, attr, v => fn(end(at(v, 0) === 0 ? 0 : 1)))
  }
  const d: Draw = {
    v: k => V(k).v,
    an: (k, attr, fn) => anMulti([k], attr, g => fn(g(k))),
    anMulti,
    animating: k => !!V(k).tr,
    P,
    L,
    id,
    blur: () => {
      blurUsed.on = true
      return `filter="url(#${blurUsed.id})"`
    },
    play,
  }
  return S.draw(d)
}

/** The flash and the reaction transforms around a glyph. */
function wrap(kind: EffortIconKind, L: number, vals: Record<string, Val>, now: number, P: Pal, inner: string, blurUsed: { on: boolean; id: string }): string {
  const S = SPECS[kind]
  const V = (k: string): Val => vals[k] ?? { v: [0], tr: null }
  const fl = S.react.flash
  let flash = ''
  const rf = V('rf')
  if (fl && (rf.tr || at(rf.v, 0) > 0)) {
    const c = S.flashColor(P, L)
    const o = (v: number[]): string => op(at(v, 0) * (fl.ring ? 1 : P.glow))
    const rr = V('rr'), r = (v: number[]): string => `${r2(at(v, 0))}`
    flash = fl.ring
      ? `<circle r="${r(rr.v)}" fill="none" stroke="${c}" stroke-width="1.3" stroke-opacity="${o(rf.v)}">${smil(rr.tr, now, 'r', r)}${smil(rf.tr, now, 'stroke-opacity', o)}</circle>`
      : `<circle r="${fl.r0}" fill="${c}" opacity="${o(rf.v)}" filter="url(#${blurUsed.id})">${smil(rf.tr, now, 'opacity', o)}</circle>`
    if (!fl.ring) blurUsed.on = true
  }
  let s = inner
  const rs = V('rs')
  if (rs.tr || !eqv(rs.v, [1, 1])) {
    const [ax, ay] = S.react.anchor
    const sc = (v: number[]): string => `${r3(at(v, 0))} ${r3(at(v, 1))}`
    const body = ax || ay ? `<g transform="translate(${-ax} ${-ay})">${s}</g>` : s
    s = `<g transform="scale(${sc(rs.v)})">${smil(rs.tr, now, '', sc, 'scale')}${body}</g>`
    if (ax || ay) s = `<g transform="translate(${ax} ${ay})">${s}</g>`
  }
  const ry = V('ry')
  if (ry.tr || at(ry.v, 0) !== 0) s = `<g transform="translate(0 ${r3(at(ry.v, 0))})">${smil(ry.tr, now, '', v => `0 ${r3(at(v, 0))}`, 'translate')}${s}</g>`
  return flash + s
}

/** The effort icon centred on (0, 0): one fragment (a kind change shows the old glyph fading out under the new). */
export function iconMarkup(p: IconView): string {
  const I = safeId(p.idPrefix)
  const P = palette(p.theme, p.model)
  const { kind, L, vals, old } = resolve(p)
  const now = p.now
  const blurUsed = { on: false, id: `${I}ib` }
  const group = (vs: Record<string, Val>, inner: string): string => {
    const ko = vs.ko ?? { v: [1], tr: null }
    const o = (v: number[]): string => op(at(v, 0))
    const an = smil(ko.tr, now, 'opacity', o)
    if (!an && at(ko.v, 0) === 1) return inner
    if (!an && at(ko.v, 0) === 0) return ''
    return `<g opacity="${o(ko.v)}">${an}${inner}</g>`
  }
  /* the pet's play: only for the level drawn, only while it runs at `now` (past its end the rest frame alone) */
  const pp = p.play
  const play = kind === 'pet' && !p.reduced && pp && lvl(pp.level) === L && now >= pp.start && now < petPlayEnd(pp) ? { elapsed: now - pp.start } : null
  let s = ''
  if (old) s += group(old.vals, glyph(old.kind, old.L, old.vals, null, P, blurUsed, `${I}o`))
  s += group(vals, wrap(kind, L, vals, now, P, glyph(kind, L, vals, now, P, blurUsed, I, play), blurUsed))
  const defs = blurUsed.on ? `<defs><filter id="${blurUsed.id}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.2"/></filter></defs>` : ''
  return defs + s
}
