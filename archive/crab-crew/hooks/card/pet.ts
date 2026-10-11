// The effort knob: the Claude Code pet in three styles (spec §16) and the 12x8
// mini pet used as the model icon (§16.6). Pure: no `$`, no I/O, deterministic
// for a given view. Port of crab-crew-design/final.html (POSE, petTargets,
// petRule, styleKick, REACT, petGroup, miniPet) with the animation-audit fixes:
//
//  1. Every one-shot kick (Apply reaction, glance, mood bob, gear drop) starts
//     from the value on screen and blends back to rest, so a re-trigger inside
//     the window never snaps (records carry `from`, sampled by petSnapshot).
//  2. The sprite only moves in whole pixels: every translate in this fragment
//     is an integer and every sprite translate is SMIL `calcMode="discrete"`.
//     No scale anywhere (the low "stretch" is now a crouch-and-rise).
//     Sprite frames (body variant, legs, eyes) swap instantly, like sprite
//     frames do, instead of fading one same-colour layer over another.
//  3. Level transformation <= 300 ms, Apply reaction <= 400 ms, glance 300 ms
//     with a 2 px offset.
//  4. No overshoot on level changes; reactions are one beat with <= 2 px
//     overshoot and <= 9 keyframe points.
//  5. Entrances and exits ease out, on-screen moves ease in-out; exits are 20%
//     shorter than entrances.
//  6. At most 4 animated elements per state change (lowest priority tracks
//     snap: extras leaving go first).
//  7. Curves are named for what they are: cubic-bezier ease curves.
//
// petMarkup draws one SVG fragment centred on (0, 0), the body centre on the
// rail. The card owns the knob translate/scale/opacity around it.
//
// Times (`now`, every record's `start`) are milliseconds on one clock. A track
// in flight is emitted as SMIL with a negative `begin`, and the static
// attribute carries the value on screen at `now`, so a swap mid-way continues
// the same curve.

import type { Family } from './parse'

export type PetStyle = 'energy' | 'mood' | 'gear'
export const PET_STYLES: readonly PetStyle[] = ['energy', 'mood', 'gear']
type Theme = 'dark' | 'light'

/** On-screen values of the pet's tweened keys (JSON-serializable), as petSnapshot samples them. */
export type PetVals = Record<string, number[]>

/** A level (or style) transformation: what was drawn before, when it started, and the values on screen then. */
export type PetChange = {
  level: number
  style: PetStyle
  start: number
  from?: PetVals
  /** most elements this change may animate inside the pet (default PET_MAX_ANIMATED); the card passes 3 when the knob slides too */
  max?: number
}
/** The Apply reaction of `level` (§16.4). `sx` scales horizontal travel (1 on the rail, .45 in the collapsed bar). */
export type PetReaction = { level: number; start: number; sx?: number; from?: PetVals }
/** Eyes glance toward the chosen model. */
export type PetGlance = { dir: -1 | 1; start: number; from?: PetVals }
/** `lifted` flipped (drag start or end). */
export type PetLift = { start: number; from?: PetVals }

export type PetView = {
  style: PetStyle
  /** effort level 0 low .. 4 max; rounded and clamped (fractional while dragging) */
  level: number
  /** held by the pointer: up 2 px, wider and darker shadow */
  lifted: boolean
  /** walk frame while dragging (0 pose, 1 alt); ignored in reduced motion */
  legFrame: 0 | 1
  /**
   * Records, each null when absent or finished. Build them with startChange /
   * startReaction / startGlance / startLift from the view as drawn just before
   * the change; without `from` a record starts from the previous rest pose.
   */
  change: PetChange | null
  reaction: PetReaction | null
  glance: PetGlance | null
  lift: PetLift | null
  now: number
  reduced: boolean
  theme: Theme
  /** prefix for every id in the fragment; sanitised to [A-Za-z0-9_] */
  idPrefix: string
}

/* ================= Pixel art (1 px cells, crispEdges, one path per part per colour) ================= */

/** Path data for a grid: each run of X becomes `M x y h w v1 h-w z`. */
export function pix(rows: readonly string[], ox: number, oy: number): string {
  let d = ''
  rows.forEach((r, y) => {
    let x = 0
    while (x < r.length) {
      if (r[x] === 'X') {
        let w = 0
        while (r[x + w] === 'X') w++
        d += `M${ox + x} ${oy + y}h${w}v1h${-w}z`
        x += w
      } else x++
    }
  })
  return d
}
/** Rect list [x, y, w, h = 1] -> one path. */
const RP = (list: readonly (readonly number[])[]): string =>
  list.map(([x = 0, y = 0, w = 0, h = 1]) => `M${x} ${y}h${w}v${h}h${-w}z`).join('')

/** Body 24x12, origin (-12, -9): 16x12 body with rounded corners, 4x4 arms on rows 4-7. */
export const BODY_ROWS: readonly string[] = [
  '.....XXXXXXXXXXXXXX.....',
  '....XXXXXXXXXXXXXXXX....',
  '....XXXXXXXXXXXXXXXX....',
  '....XXXXXXXXXXXXXXXX....',
  'XXXXXXXXXXXXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXXXXXXXXXXXX',
  '....XXXXXXXXXXXXXXXX....',
  '....XXXXXXXXXXXXXXXX....',
  '....XXXXXXXXXXXXXXXX....',
  '.....XXXXXXXXXXXXXX.....',
]
/** Body variants: head rows 0-3 shifted right (0 upright, 1 running, 2 sprinting). Arms never move. */
const BODY_SHIFT: readonly (readonly number[])[] = [[0, 0, 0, 0], [1, 1, 1, 1], [2, 2, 1, 1]]

/** Legs 24x4, rows 12-15 of the pet (origin y 3). */
export const LEG_ROWS = {
  stand: ['....XX..XX....XX..XX....', '....XX..XX....XX..XX....', '....XX..XX....XX..XX....', '....XX..XX....XX..XX....'],
  stride: ['...XX....XX..XX....XX...', '...XX....XX..XX....XX...', '...XX....XX..XX....XX...', '...XX....XX..XX....XX...'],
  run: ['....XX..XX....XX..XX....', '...XX..XX....XX..XX.....', '..XX..XX....XX..XX......', '..XX..XX....XX..XX......'],
  runB: ['....XX..XX....XX..XX....', '...XX..XX......XX..XX...', '..XX..XX........XX..XX..', '..XX..XX........XX..XX..'],
  sprint: ['....XX..XX....XX..XX....', '...XX..XX......XX..XX...', '.XX..XX..........XX..XX.', 'XX..XX............XX..XX'],
  sprintB: ['....XX..XX....XX..XX....', '.....XX..XX..XX..XX.....', '.....XX..XX..XX..XX.....', '.....XX..XX..XX..XX.....'],
  dangle: ['....XX..XX....XX..XX....', '....XX..XX....XX..XX....', '.....XX..XX..XX..XX.....', '......X...X..X...X......'],
  tuck: ['........................', '........................', '........................', '...XX..............XX...'],
} as const satisfies Record<string, readonly string[]>
type Leg = keyof typeof LEG_ROWS
const LEG_NAMES = Object.keys(LEG_ROWS) as Leg[]

/** Every grid that is not the right size, as messages (the demo's load-time check). Empty when sound. */
export function gridErrors(): string[] {
  const bad: string[] = []
  const chk = (g: readonly string[], w: number, h: number, nm: string): void => {
    if (g.length !== h) bad.push(`${nm} has ${g.length} rows, expected ${h}`)
    g.forEach((r, i) => {
      if (r.length !== w) bad.push(`${nm}[${i}] has ${r.length} cells, expected ${w}`)
    })
  }
  chk(BODY_ROWS, 24, 12, 'body')
  for (const n of LEG_NAMES) chk(LEG_ROWS[n], 24, 4, `legs.${n}`)
  chk(MINI_ROWS, 12, 8, 'mini')
  return bad
}

const shiftR = (r: string, k: number): string => '.'.repeat(k) + r.slice(0, r.length - k)
const BODY: readonly string[] = BODY_SHIFT.map((sh) => pix(BODY_ROWS.map((r, i) => shiftR(r, sh[i] ?? 0)), -12, -9))
const LEGS = Object.fromEntries(LEG_NAMES.map((n) => [n, pix(LEG_ROWS[n], -12, 3)])) as Record<Leg, string>

export const CORAL = '#D97757'
/* fixed extra colours (both themes): heavy lid, hero cape, glowing eyes */
const LID = '#8A4026'
const CAPE = '#B4482C'
const GLOWEYE = '#FFF4E6'
const GLOWHALO = '#FFE2C4'

type Eye = 'open' | 'closed' | 'lid' | 'narrow' | 'wide' | 'glow'
type Rects = readonly (readonly number[])[]
const EYE_R: Record<Eye, Rects> = {
  open: [[-6, -7, 2, 2], [4, -7, 2, 2]],
  closed: [[-7, -7, 1], [-6, -6, 2], [-4, -7, 1], [3, -7, 1], [4, -6, 2], [6, -7, 1]], // asleep: two arcs
  lid: [[-6, -6, 2], [4, -6, 2]], // half closed, lid drawn above in LID
  narrow: [[-6, -6, 2], [4, -6, 2]],
  wide: [[-6, -8, 2, 3], [4, -8, 2, 3]],
  glow: [[-6, -7, 2, 2], [4, -7, 2, 2]],
}
const EYE_D = Object.fromEntries(Object.entries(EYE_R).map(([k, r]) => [k, RP(r)])) as Record<Eye, string>
const SPD_R: Rects = [[-20, -5, 3], [-21, -2, 4], [-19, 1, 2]]
const Z_R: Rects = [[8, -14, 4], [10, -13, 1], [9, -12, 1], [8, -11, 4]]
const LID_D = RP([[-6, -7, 2], [4, -7, 2]])

type Extra = 'aura' | 'spd' | 'z' | 'brow' | 'sweat' | 'cap' | 'band' | 'gog' | 'cape'
const EXTRAS: readonly Extra[] = ['aura', 'spd', 'z', 'brow', 'sweat', 'cap', 'band', 'gog', 'cape']
/** gear accessories: each drops 4 px into place when it enters */
const GEAR: readonly Extra[] = ['cap', 'band', 'gog', 'cape']
const XD = {
  spd: RP(SPD_R),
  z: RP(Z_R),
  brow: RP([[-7, -8, 2], [-5, -7, 2], [5, -8, 2], [3, -7, 2]]),
  sweatL: RP([[10, -11, 1], [9, -10, 2], [9, -9, 1]]),
  sweatD: RP([[10, -9, 1]]),
  capA: RP([[4, -14, 4], [1, -13, 7], [-2, -12, 10], [-5, -11, 13], [-7, -10, 15]]),
  capB: RP([[-8, -9, 16], [8, -14, 2, 2]]),
  band: RP([[-8, -8, 16], [-10, -9, 2], [-12, -10, 2], [-10, -7, 2]]),
  gogF: RP([[-7, -8, 4, 4], [3, -8, 4, 4], [-8, -7, 1], [-3, -7, 6], [7, -7, 1]]),
  gogL: RP([[-6, -7, 2, 2], [4, -7, 2, 2]]),
  cape: RP([[-10, -7, 3], [-14, -6, 5], [-18, -5, 6], [-20, -4, 8], [-21, -3, 5], [-15, -3, 3], [-22, -2, 4]]),
}

type Palette = {
  eye: string; muted: string; sweat: readonly [string, string]; cap: readonly [string, string]; band: string
  glowOp: number; shadowOp: number
}
const PALETTE: Record<Theme, Palette> = {
  dark: { eye: '#1A1A1C', muted: '#939398', sweat: ['#DCEEFF', '#8EC3F0'], cap: ['#8EC3F0', '#DCEEFF'], band: '#E6E6E6', glowOp: 0.2, shadowOp: 0.5 },
  light: { eye: '#1A1A1C', muted: '#6B6B70', sweat: ['#8EC3F0', '#5A9EDC'], cap: ['#5A9EDC', '#A9D2F5'], band: '#1D1D1F', glowOp: 0.15, shadowOp: 0.22 },
}

/* ================= Mini pet (model icon, §16.6) ================= */

export const MINI_ROWS: readonly string[] = [
  '..XXXXXXXX..',
  '..XXXXXXXX..',
  'XXXXXXXXXXXX',
  'XXXXXXXXXXXX',
  '..XXXXXXXX..',
  '..XXXXXXXX..',
  '..X.X..X.X..',
  '..X.X..X.X..',
]
const MINI_D = pix(MINI_ROWS, 0, 0)
const MINI_EYE = RP([[3, 1, 1, 2], [8, 1, 1, 2]])
/** Model tints (haiku amber, sonnet teal, opus coral, fable violet). */
export const MODEL_TINT: Readonly<Record<Family, string>> = { haiku: '#D9A441', sonnet: '#2FA38A', opus: '#D97757', fable: '#8B7CF6' }

/** The 12x8 mini pet with its top-left at (x, y), rounded to whole pixels (drawn at 1x). */
export function miniPet(x: number, y: number, fill: string, eye = '#1A1A1C'): string {
  return `<g transform="translate(${Math.round(x)} ${Math.round(y)})"><path d="${MINI_D}" fill="${fill}" shape-rendering="crispEdges"/><path d="${MINI_EYE}" fill="${eye}" shape-rendering="crispEdges"/></g>`
}

/* ================= Poses (§16.1, §16.2) ================= */

type Pose = {
  bY: number; pX: number; fY: number; body: number; eL: number
  legs: Leg; alt: Leg; eyes: Eye | null; x: readonly Extra[]; sh: readonly [number, number]
}
const PDEF: Pose = { bY: 0, pX: 0, fY: 0, body: 0, eL: 0, legs: 'stand', alt: 'stride', eyes: 'open', x: [], sh: [10, 1] }
const POSE: Record<PetStyle, readonly Partial<Pose>[]> = {
  energy: [
    { bY: 4, legs: 'tuck', alt: 'tuck', eyes: 'closed', x: ['z'] }, // low: sitting, asleep
    {}, // medium: standing (the reference)
    { pX: 1, body: 1, eL: 1, legs: 'run', alt: 'runB' }, // high: running, leaning
    { pX: 2, body: 2, eL: 1, legs: 'sprint', alt: 'sprintB', x: ['spd'] }, // xhigh: sprinting, speed lines
    { fY: -3, legs: 'dangle', alt: 'dangle', x: ['aura'], sh: [6, 0.5] }, // max: floating, aura, small shadow
  ],
  mood: [{ eyes: 'lid' }, {}, { eyes: 'narrow', x: ['brow'] }, { eyes: 'wide', x: ['sweat'] }, { eyes: 'glow', x: ['aura'] }],
  gear: [{ x: ['cap'] }, {}, { x: ['band'] }, { eyes: null, x: ['gog'] }, { x: ['cape'] }],
}

const lvl = (x: number): number => Math.max(0, Math.min(4, Math.round(Number.isFinite(x) ? x : 0)))
const poseOf = (style: PetStyle, L: number): Pose => ({ ...PDEF, ...(POSE[style] ?? POSE.energy)[lvl(L)] })

/** Rest value of every tweened key for a pose (what each track ends on). */
function targets(style: PetStyle, L: number, lifted: boolean): PetVals {
  const p = poseOf(style, L)
  const t: PetVals = { pBY: [p.bY], pPX: [p.pX], pFY: [p.fY] }
  for (const n of EXTRAS) t['opX_' + n] = [p.x.includes(n) ? 1 : 0]
  for (const n of GEAR) t['gY_' + n] = [0]
  t.shW = [p.sh[0]]
  t.shOp = [p.sh[1] * (lifted ? 1.4 : 1)]
  t.kSh = [lifted ? 2.6 : 1.8]
  t.kLift = [lifted ? -2 : 0]
  t.rT = [0, 0]
  t.rN = [0]
  t.eyeDx = [0]
  return t
}

const CHANGE_KEYS = ['pBY', 'pPX', 'pFY', ...EXTRAS.map((n) => 'opX_' + n), ...GEAR.map((n) => 'gY_' + n), 'shW', 'shOp', 'rN']
const LIFT_KEYS = ['kLift', 'kSh', 'shOp']
const REACT_KEYS = ['rT', 'rN']
const GLANCE_KEYS = ['eyeDx']

/* ================= Curves and timings ================= */

/** keySplines are cubic-bezier ease curves (none of these is a spring). */
export const EASE = {
  /** entrances and exits: fast start, long soft landing */
  out: '.16 1 .3 1',
  /** moves of something already on screen */
  inOut: '.45 0 .55 1',
} as const

export const PET_MS = {
  /** sit / stand / lift off / land (pBY, pFY) */
  move: 280,
  /** lean (pPX) */
  lean: 200,
  /** shadow width and opacity while floating */
  shadow: 280,
  /** extras fading in, and the gear drop that comes with them */
  extraIn: 225,
  /** extras fading out (20% shorter) */
  extraOut: 180,
  /** mood: the 1 px bob as the face changes */
  bob: 300,
  /** any level transformation ends within this */
  change: 300,
  /** pick up / set down while dragging */
  lift: 200,
  /** a kick channel returning to rest when another reaction takes over */
  settle: 160,
  glance: 300,
  /** longest Apply reaction */
  reaction: 400,
} as const

/** Most animated elements a single state change may start (audit rule). */
export const PET_MAX_ANIMATED = 4

/* Apply reactions (§16.4, audited): authored whole-pixel frames [t, ...value], t in 0..1 of dur. One beat each. */
type Frames = readonly (readonly number[])[]
/** loop radius: 2 px, so no discrete step is longer than 2 px (radius 4 read as teleporting) */
const LOOP_R = 2
const LOOP: Frames = Array.from({ length: 9 }, (_, i) => {
  const u = i / 8, p = u * u * (3 - 2 * u), a = 2 * Math.PI * p
  return [Math.round(i * 0.1125 * 1000) / 1000, Math.round(LOOP_R * Math.sin(a)), Math.round(-LOOP_R * (1 - Math.cos(a)))]
})
export const REACTIONS: readonly { name: string; ch: 'rT' | 'rN'; dur: number; f: Frames }[] = [
  // low: crouch 1 px, rise 2 px above rest, settle
  { name: 'crouch-and-rise', ch: 'rT', dur: 360, f: [[0, 0, 0], [0.1, 0, 1], [0.3, 0, 0], [0.42, 0, -1], [0.55, 0, -2], [0.75, 0, -1], [0.88, 0, 0]] },
  // medium: one nod of the upper body
  { name: 'nod', ch: 'rN', dur: 320, f: [[0, 0], [0.12, 1], [0.25, 2], [0.6, 1], [0.75, 0]] },
  // high: a short 4 px dash forward and back
  { name: 'dash', ch: 'rT', dur: 380, f: [[0, 0, 0], [0.08, 1, 0], [0.16, 2, 0], [0.24, 3, 0], [0.32, 4, 0], [0.56, 3, 0], [0.68, 2, 0], [0.8, 1, 0], [0.9, 0, 0]] },
  // xhigh: one hop
  { name: 'hop', ch: 'rT', dur: 380, f: [[0, 0, 0], [0.08, 0, -2], [0.18, 0, -3], [0.32, 0, -4], [0.5, 0, -3], [0.62, 0, -2], [0.72, 0, -1], [0.8, 0, 0]] },
  // max: a small 2 px loop, 9 points
  { name: 'loop', ch: 'rT', dur: 400, f: LOOP },
]
const GLANCE_F: Frames = [[0, 0], [0.08, 1], [0.16, 2], [0.72, 1], [0.84, 0]]
const BOB_F: Frames = [[0, 0], [0.3, 1], [0.7, 0]]
const DROP = -4

/* ================= Tracks ================= */

/** keyframes over `dur` ms from `t0`; `ks` null = discrete (whole-pixel sprite steps) */
type Trk = { kf: number[][]; kt: number[]; ks: string[] | null; dur: number; t0: number }
type Val = { v: number[]; tr: Trk | null }

const r3 = (x: number): number => {
  const r = Math.round(x * 1000) / 1000
  return Object.is(r, -0) ? 0 : r
}
const F = (v: readonly number[]): string => v.map(r3).join(' ')
const at = <T>(a: readonly T[], i: number): T => a[i] as T
const eqv = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((x, i) => Math.abs(x - at(b, i)) < 1e-3)

function bez(s: string, x: number): number {
  const [x1 = 0, y1 = 0, x2 = 1, y2 = 1] = s.split(' ').map(Number)
  if (x <= 0) return 0
  if (x >= 1) return 1
  let lo = 0
  let hi = 1
  let t = x
  for (let i = 0; i < 28; i++) {
    t = (lo + hi) / 2
    const cx = 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t
    if (cx < x) lo = t
    else hi = t
  }
  return 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t
}
/** progress x at which the eased curve reaches y */
function inv(s: string, y: number): number {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2
    if (bez(s, m) < y) lo = m
    else hi = m
  }
  return (lo + hi) / 2
}

/** The value on screen at `now` (replica of SMIL spline / discrete interpolation). */
function sample(tr: Trk, now: number): number[] {
  const u = (now - tr.t0) / tr.dur
  const last = at(tr.kf, tr.kf.length - 1)
  if (u >= 1) return last.slice()
  if (u <= 0) return at(tr.kf, 0).slice()
  let k = 0
  while (k < tr.kt.length - 1 && u >= at(tr.kt, k + 1)) k++
  if (!tr.ks) return at(tr.kf, k).slice()
  if (k >= tr.kt.length - 1) return last.slice()
  const k0 = at(tr.kt, k)
  const e = bez(at(tr.ks, k), (u - k0) / (at(tr.kt, k + 1) - k0))
  const a = at(tr.kf, k)
  const b = at(tr.kf, k + 1)
  return a.map((x, j) => x + (at(b, j) - x) * e)
}
const live = (tr: Trk | null, now: number): tr is Trk => !!tr && now >= tr.t0 && now - tr.t0 < tr.dur
const valOf = (tr: Trk | null, to: number[], now: number): Val => (live(tr, now) ? { v: sample(tr, now), tr } : { v: to, tr: null })

/** strictly increasing keyTimes, 3 decimals, first 0 */
function times(kt: number[]): number[] {
  const out: number[] = []
  kt.forEach((t, i) => {
    let x = i === 0 ? 0 : r3(t)
    if (i > 0) x = Math.max(x, r3(at(out, i - 1) + 0.001))
    out.push(x)
  })
  return out
}

/** A continuous tween (opacity, shadow geometry). */
function fade(cur: number[], to: number[], dur: number, spline: string, t0: number): Trk | null {
  return eqv(cur, to) ? null : { kf: [cur, to], kt: [0, 1], ks: [spline], dur, t0 }
}

/** A whole-pixel move: one discrete step per pixel, each step where the eased curve crosses the half pixel. */
function steps(cur: number[], to: number[], dur: number, spline: string, t0: number): Trk | null {
  const a = cur.map(Math.round)
  const b = to.map(Math.round)
  const n = Math.max(0, ...a.map((x, j) => Math.abs(at(b, j) - x)))
  if (n === 0) return null
  const kf: number[][] = []
  const kt: number[] = []
  for (let k = 0; k <= n; k++) {
    kf.push(a.map((x, j) => Math.round(x + ((at(b, j) - x) * k) / n)))
    kt.push(k === 0 ? 0 : inv(spline, (k - 0.5) / n))
  }
  return { kf, kt: times(kt), ks: null, dur, t0 }
}

/**
 * A one-shot kick from the value on screen: the authored frames (rest = 0) plus
 * the on-screen offset decaying linearly to 0 by the last frame, rounded to
 * whole pixels; repeated frames are merged. Starts exactly where the pet is.
 */
function kick(f: Frames, cur: number[], dur: number, t0: number, sx = 1, onePx = false): Trk | null {
  const n = f.length
  const kf: number[][] = []
  const kt: number[] = []
  f.forEach((fr, i) => {
    const w = n > 1 ? 1 - i / (n - 1) : 0
    const v = fr.slice(1).map((x, j) => Math.round((j === 0 ? x * sx : x) + at(cur, j) * w) + 0)
    if (kf.length && eqv(at(kf, kf.length - 1), v)) return
    if (onePx && kf.length) {
      /* fill a gap the merge left (a bob starting 2 px down) one pixel at a time, evenly in time */
      const a = at(kf, kf.length - 1)
      const ta = at(kt, kt.length - 1)
      const gap = Math.max(...v.map((x, j) => Math.abs(x - at(a, j))))
      for (let k = 1; k < gap; k++) {
        kf.push(a.map((x, j) => Math.round(x + ((at(v, j) - x) * k) / gap) + 0))
        kt.push(ta + ((at(fr, 0) - ta) * k) / gap)
      }
    }
    kf.push(v)
    kt.push(at(fr, 0))
  })
  if (kf.every((v) => eqv(v, at(kf, 0)))) return null
  return { kf, kt: times(kt), ks: null, dur, t0 }
}

/* ================= Records -> tracks ================= */

type Out = Record<string, Val>

/** The elements a record animates when it starts at the same time as a change (budget sharing). */
function reservedBy(p: PetView, start: number): Set<string> {
  const r = new Set<string>()
  if (p.lift && p.lift.start === start) r.add('kLift').add('shadow')
  if (p.reaction && p.reaction.start === start) r.add('react')
  if (p.glance && p.glance.start === start) r.add('glance')
  return r
}

function changeOut(p: PetView, c: PetChange, tg: PetVals, L: number): Out {
  const now = p.now
  const t0 = c.start
  const def = targets(c.style, c.level, p.lifted)
  const cur = (k: string): number[] => (c.from && c.from[k]) || def[k] || [0]
  const to = (k: string): number[] => tg[k] ?? [0]
  /* candidate elements, highest priority first; each element is one SVG node */
  /* `legAt`: the legs element swaps its grid at this time (ms) instead of at once */
  type El = { name: string; tracks: Record<string, Trk | null>; legAt?: number }
  const els: El[] = []
  const add = (name: string, tracks: Record<string, Trk | null>): void => {
    if (Object.values(tracks).some((t) => t)) els.push({ name, tracks })
  }
  add('fY', { pFY: steps(cur('pFY'), to('pFY'), PET_MS.move, EASE.inOut, t0) })
  const bY = steps(cur('pBY'), to('pBY'), PET_MS.move, EASE.inOut, t0)
  add('bY', { pBY: bY })
  /* Sitting down: the old legs stay until the body lands on the tucked feet (the step where pBY
     reaches its target), so the feet never show under a body that is still standing or floating.
     Every other swap reads right at once: those legs are as long as the old ones, or emerge from
     under the rising body. */
  const pNew = poseOf(p.style, L)
  const pOld = poseOf(c.style, c.level)
  if (bY && pNew.legs === 'tuck' && pOld.legs !== 'tuck') els.push({ name: 'legs', tracks: {}, legAt: t0 + at(bY.kt, bY.kt.length - 1) * bY.dur })
  add('pX', { pPX: steps(cur('pPX'), to('pPX'), PET_MS.lean, EASE.inOut, t0) })
  if (p.style === 'mood' && (c.level !== L || c.style !== p.style)) add('bob', { rN: kick(BOB_F, cur('rN'), PET_MS.bob, t0, 1, true) })
  const leaving: El[] = []
  for (const n of EXTRAS) {
    const o0 = at(cur('opX_' + n), 0)
    const o1 = at(to('opX_' + n), 0)
    const tracks: Record<string, Trk | null> = {}
    if (o1 > o0) tracks['opX_' + n] = fade([o0], [o1], PET_MS.extraIn, EASE.out, t0)
    else tracks['opX_' + n] = fade([o0], [o1], PET_MS.extraOut, EASE.out, t0)
    if (GEAR.includes(n)) {
      const y0 = o0 < 0.05 && o1 > o0 ? DROP : at(cur('gY_' + n), 0)
      /* in-out steps spread -4, -3, -2, -1, 0 over the fade (ease-out put every step in the first 70 ms) */
      tracks['gY_' + n] = steps([y0], to('gY_' + n), PET_MS.extraIn, EASE.inOut, t0)
    }
    if (o1 > o0) add('x:' + n, tracks)
    else if (Object.values(tracks).some((t) => t)) leaving.push({ name: 'x:' + n, tracks })
  }
  /* a fading extra outranks the shadow: under a tight budget only the shadow's width snaps */
  els.push(...leaving)
  add('shadow', { shW: fade(cur('shW'), to('shW'), PET_MS.shadow, EASE.inOut, t0), shOp: fade(cur('shOp'), to('shOp'), PET_MS.shadow, EASE.inOut, t0) })

  const reserved = reservedBy(p, t0)
  let budget = Math.min(PET_MAX_ANIMATED, c.max ?? PET_MAX_ANIMATED) - reserved.size
  const out: Out = {}
  for (const k of CHANGE_KEYS) if (k !== 'rN') out[k] = { v: to(k), tr: null }
  for (const el of els) {
    const keep = reserved.has(el.name) || budget > 0
    if (keep && !reserved.has(el.name)) budget--
    for (const [k, tr] of Object.entries(el.tracks)) out[k] = keep ? valOf(tr, to(k), now) : { v: to(k), tr: null }
    if (keep && el.legAt !== undefined && el.legAt > now) out.legAt = { v: [el.legAt], tr: null }
  }
  return out
}

function liftOut(p: PetView, l: PetLift, tg: PetVals): Out {
  const up = p.lifted
  const pose = targets(p.style, lvl(p.level), !up)
  const cur = (k: string): number[] => (l.from && l.from[k]) || pose[k] || [0]
  const to = (k: string): number[] => tg[k] ?? [0]
  return {
    kLift: valOf(steps(cur('kLift'), to('kLift'), PET_MS.lift, EASE.inOut, l.start), to('kLift'), p.now),
    kSh: valOf(fade(cur('kSh'), to('kSh'), PET_MS.lift, EASE.inOut, l.start), to('kSh'), p.now),
    shOp: valOf(fade(cur('shOp'), to('shOp'), PET_MS.lift, EASE.inOut, l.start), to('shOp'), p.now),
  }
}

function reactionOut(p: PetView, r: PetReaction): Out {
  const R = at(REACTIONS, lvl(r.level))
  const cur = (k: string): number[] => (r.from && r.from[k]) || (k === 'rT' ? [0, 0] : [0])
  const rest = (k: string): number[] => (k === 'rT' ? [0, 0] : [0])
  const out: Out = {}
  for (const k of REACT_KEYS) {
    const tr = k === R.ch ? kick(R.f, cur(k), R.dur, r.start, k === 'rT' ? r.sx ?? 1 : 1) : steps(cur(k), rest(k), PET_MS.settle, EASE.inOut, r.start)
    out[k] = valOf(tr, rest(k), p.now)
  }
  return out
}

function glanceOut(p: PetView, g: PetGlance): Out {
  const cur = (g.from && g.from.eyeDx) || [0]
  const f = GLANCE_F.map(([t = 0, x = 0]) => [t, x * g.dir])
  return { eyeDx: valOf(kick(f, cur, PET_MS.glance, g.start, 1, true), [0], p.now) }
}

/** Every key's value (and track in flight) at `p.now`. Records apply oldest first; a later one takes over shared keys. */
function resolve(p: PetView): { pose: Pose; vals: Out } {
  const L = lvl(p.level)
  const tg = targets(p.style, L, p.lifted)
  const vals: Out = {}
  for (const k of Object.keys(tg)) vals[k] = { v: tg[k] ?? [0], tr: null }
  if (!p.reduced) {
    const recs: { start: number; out: () => Out }[] = []
    if (p.change) { const c = p.change; recs.push({ start: c.start, out: () => changeOut(p, c, tg, L) }) }
    if (p.lift) { const l = p.lift; recs.push({ start: l.start, out: () => liftOut(p, l, tg) }) }
    if (p.reaction) { const r = p.reaction; recs.push({ start: r.start, out: () => reactionOut(p, r) }) }
    if (p.glance) { const g = p.glance; recs.push({ start: g.start, out: () => glanceOut(p, g) }) }
    recs.sort((a, b) => a.start - b.start) // stable: change, lift, reaction, glance on ties
    for (const r of recs) if (r.start <= p.now) Object.assign(vals, r.out())
  }
  return { pose: poseOf(p.style, L), vals }
}

const pick = (v: PetVals, keys: readonly string[]): PetVals => Object.fromEntries(keys.filter((k) => v[k]).map((k) => [k, v[k] ?? [0]]))

/** The values the pet draws at `at` (every tweened key). */
export function petSnapshot(view: PetView, atMs: number): PetVals {
  const { vals } = resolve({ ...view, now: atMs })
  return Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, v.v.map(r3)]))
}

/* Record builders: pass the view as drawn just before the change. */

/** A level or style change starting at `now`, from what `prev` draws at `now`. */
export function startChange(prev: PetView, now: number): PetChange {
  return { level: lvl(prev.level), style: prev.style, start: now, from: pick(petSnapshot(prev, now), CHANGE_KEYS) }
}
/** The Apply reaction for the level on screen. `sx` .45 in the collapsed bar. */
export function startReaction(prev: PetView, now: number, sx = 1): PetReaction {
  return { level: lvl(prev.level), start: now, sx, from: pick(petSnapshot(prev, now), REACT_KEYS) }
}
export function startGlance(prev: PetView, dir: -1 | 1, now: number): PetGlance {
  return { dir, start: now, from: pick(petSnapshot(prev, now), GLANCE_KEYS) }
}
/** `lifted` is about to flip. */
export function startLift(prev: PetView, now: number): PetLift {
  return { start: now, from: pick(petSnapshot(prev, now), LIFT_KEYS) }
}

/** Latest end (ms) of anything in flight after view.now, or null at rest: schedule the settle render there. */
export function petEnd(view: PetView): number | null {
  if (view.reduced) return null
  const ends: number[] = []
  if (view.change) ends.push(view.change.start + PET_MS.change)
  if (view.lift) ends.push(view.lift.start + PET_MS.lift)
  if (view.reaction) ends.push(view.reaction.start + at(REACTIONS, lvl(view.reaction.level)).dur)
  if (view.glance) ends.push(view.glance.start + PET_MS.glance)
  const end = Math.max(-Infinity, ...ends)
  return end > view.now ? end : null
}

/* ================= Markup ================= */

const safeId = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, '_')

function smil(tr: Trk | null, now: number, head: string, fn: (v: number[]) => number[]): string {
  if (!tr) return ''
  const vs = tr.kf.map((v) => F(fn(v)))
  if (vs.every((x) => x === vs[0])) return ''
  const mode = tr.ks ? `calcMode="spline" keySplines="${tr.ks.join(';')}"` : 'calcMode="discrete"'
  return `<${head} values="${vs.join(';')}" keyTimes="${tr.kt.map(r3).join(';')}" ${mode} dur="${r3(tr.dur / 1000)}s" begin="${r3(-(now - tr.t0) / 1000)}s" fill="freeze"/>`
}

const px = (d: string, c: string, ex = ''): string => `<path d="${d}" fill="${c}"${ex} shape-rendering="crispEdges"/>`

/** Petmarkup centred on (0, 0): shadow on the rail, then the sprite in whole-pixel groups. */
export function petMarkup(p: PetView): string {
  const I = safeId(p.idPrefix)
  const T = PALETTE[p.theme] ?? PALETTE.dark
  const now = p.now
  const { pose, vals } = resolve(p)
  const V = (k: string): Val => vals[k] ?? { v: [0], tr: null }
  const n = (k: string): number => at(V(k).v, 0)
  const aA = (k: string, attr: string, fn: (v: number[]) => number[] = (x) => x): string => smil(V(k).tr, now, `animate attributeName="${attr}"`, fn)
  /** translate group; `fn` maps the key's value to (x, y); skipped when 0 0 and still */
  const tr = (k: string | Val, fn: (v: number[]) => number[], inner: string): string => {
    const val = typeof k === 'string' ? V(k) : k
    const xy = fn(val.v).map(Math.round)
    const an = smil(val.tr, now, 'animateTransform attributeName="transform" type="translate"', fn)
    if (!an && xy.every((x) => x === 0)) return inner
    return `<g transform="translate(${F(xy)})">${an}${inner}</g>`
  }
  const ty = (k: string, inner: string): string => tr(k, (x) => [0, at(x, 0)], inner)
  const tx = (k: string | Val, inner: string): string => tr(k, (x) => [at(x, 0), 0], inner)
  /** an extra: opacity layer (plus the gear drop), skipped when invisible and still */
  const ex = (name: Extra, inner: string): string => {
    const o = V('opX_' + name)
    const oa = smil(o.tr, now, 'animate attributeName="opacity"', (x) => x)
    if (!oa && at(o.v, 0) === 0) return ''
    const g = GEAR.includes(name) ? V('gY_' + name) : null
    const y = g ? Math.round(at(g.v, 0)) : 0
    const ya = g ? smil(g.tr, now, 'animateTransform attributeName="transform" type="translate"', (x) => [0, at(x, 0)]) : ''
    if (!oa && !ya && y === 0 && at(o.v, 0) === 1) return inner
    const op = at(o.v, 0) === 1 && !oa ? '' : ` opacity="${r3(at(o.v, 0))}"`
    const tf = y || ya ? ` transform="translate(0 ${y})"` : ''
    return `<g${op}${tf}>${oa}${ya}${inner}</g>`
  }

  const motion = !p.reduced
  const legOf = (q: Pose): Leg => (motion && p.legFrame === 1 ? q.alt : q.legs)
  const leg: Leg = legOf(pose)
  /* sitting down: the old legs hold until the body lands on the tucked feet, then the grid swaps (discrete) */
  const ch = p.change
  const legAt = vals.legAt ? at(vals.legAt.v, 0) : null
  const oldLeg: Leg | null = ch && legAt !== null && legAt > now ? legOf(poseOf(ch.style, ch.level)) : null
  const legs =
    ch && legAt !== null && oldLeg && oldLeg !== leg
      ? `<path d="${LEGS[oldLeg]}" fill="${CORAL}" shape-rendering="crispEdges"><animate attributeName="d" values="${LEGS[oldLeg]};${LEGS[leg]}" keyTimes="0;${r3((legAt - ch.start) / PET_MS.move)}" calcMode="discrete" dur="${r3(PET_MS.move / 1000)}s" begin="${r3(-(now - ch.start) / 1000)}s" fill="freeze"/></path>`
      : px(LEGS[leg], CORAL)
  const eyeName = pose.eyes
  let eyes = ''
  if (eyeName === 'glow') eyes = `<path d="${EYE_D.glow}" fill="${GLOWHALO}" opacity=".9" filter="url(#${I}eg)"/>` + px(EYE_D.glow, GLOWEYE)
  else if (eyeName === 'lid') eyes = px(EYE_D.lid, T.eye) + px(LID_D, LID)
  else if (eyeName) eyes = px(EYE_D[eyeName], T.eye)
  const aura = ex('aura', `<ellipse cx="0" cy="-2" rx="16" ry="11" fill="${CORAL}" opacity="${T.glowOp}" filter="url(#${I}cg)"/>`)

  // the blink is the only animation at rest: first 10 s after this swap, then every 13.14 s
  const blink = motion ? `<animate id="${I}blink" attributeName="opacity" values="1;0;0;1" keyTimes="0;.07;.93;1" dur=".14s" begin="10s;${I}blink.end+13s"/>` : ''

  // upper body: cape behind, body, eyes (glance > blink), brows, z, sweat, front gear
  let up = ex('cape', px(XD.cape, CAPE))
  up += px(at(BODY, pose.body), CORAL)
  // the brow rides the glance too, so a narrowed eye never slides out from under it
  up += tx({ v: [pose.eL], tr: null }, tx('eyeDx', `<g>${blink}${eyes}</g>` + ex('brow', px(XD.brow, T.eye))))
  up += ex('z', px(XD.z, T.muted, ' opacity=".8"'))
  up += ex('sweat', px(XD.sweatL, T.sweat[0]) + px(XD.sweatD, T.sweat[1]))
  up += ex('cap', px(XD.capA, T.cap[0]) + px(XD.capB, T.cap[1]))
  up += ex('band', px(XD.band, T.band))
  up += ex('gog', px(XD.gogF, T.eye) + px(XD.gogL, T.sweat[0]))
  // whole pet: aura, speed lines, legs, then the upper body (lean > sit > nod)
  let whole = aura + ex('spd', px(XD.spd, T.muted, ' opacity=".75"')) + legs
  whole += tx('pPX', ty('pBY', ty('rN', up)))

  let s = `<defs><filter id="${I}kb" x="-100%" y="-300%" width="300%" height="700%"><feGaussianBlur stdDeviation="1.8"/></filter>`
  if (aura) s += `<filter id="${I}cg" x="-60%" y="-80%" width="220%" height="260%"><feGaussianBlur stdDeviation="3.5"/></filter>`
  if (eyeName === 'glow') s += `<filter id="${I}eg" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="1"/></filter>`
  s += `</defs>`
  // shadow on the rail: outside every sprite group; one element (rx float, ry lift, opacity both)
  s += `<ellipse cx="0" cy="8" rx="${r3(n('shW'))}" ry="${r3(n('kSh'))}" fill="#000" opacity="${r3(n('shOp') * T.shadowOp)}" filter="url(#${I}kb)">`
  s += `${aA('shW', 'rx')}${aA('kSh', 'ry')}${aA('shOp', 'opacity', (x) => [at(x, 0) * T.shadowOp])}</ellipse>`
  // lift > reaction > float, all whole-pixel discrete translates
  s += ty('kLift', tr('rT', (x) => [at(x, 0), at(x, 1)], ty('pFY', whole)))
  return s
}
