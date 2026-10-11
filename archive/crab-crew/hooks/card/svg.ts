/**
 * The docked control card (above the prompt): renderer and motion engine. Pure:
 * no `$`, no I/O, deterministic (every function takes `now`, in milliseconds).
 *
 * Pipeline per change: view -> numeric targets -> per-key transition records
 * (retarget, called by the render hook when the view it draws differs from the
 * one it drew last) -> the whole SVG string (renderCard). Every new record starts
 * from the value on screen at `now` (the presentation value).
 *
 * Redraw stability (the host redraws the band on every streamed token, and the
 * desktop reloads an interactive Svg's frame whenever its source changes):
 * renderCard is a function of (view, anim) alone while anything is in flight
 * (it draws at `anim.at`, the instant the motion started, so every SMIL `begin`
 * is fixed), and of the view alone once `animEnd` has passed (no SMIL at all).
 * Two redraws with no change in between return the same string.
 *
 * Apply on select: there is no Apply button. The card is a live control of the
 * session: `view.draft` is what the card shows selected (the hooks module
 * resolves it: the session's value, or the person's choice while it applies),
 * `view.step` is the latest reply's "Próximo passo" recommendation (`hasRec`
 * false: there is none yet, nothing is outlined). A recommended value that is not
 * selected keeps a faint dashed outline (a ring on the rail), drawn under the
 * selection so it is hidden whenever they match.
 *
 * Three looks, each as wide as the band (`view.width`, CSS px) and of a fixed height:
 *  - expanded card: task, model well, effort rail (knob + value word under it), mode well;
 *  - collapsed bar (the default): [compact 5-step effort rail, the effort icon (the pet by
 *    default) as its knob] [Name ver] [mode icon] (+ the quiet recommendation chip when the
 *    session differs from it and it fits) … [crew] [hide] [chevron] [gear];
 *  - hidden: a slim full-width handle (renderHandle) that brings the bar back.
 * The crew, hide, chevron and gear controls are drawn here and are zones (hitMap), like the pills.
 * The bar's rail is a slider band (tap a step or drag the knob), like the expanded rail.
 *
 * The pet knob plays its level's designed sequence (./pet-hires: Derretido, Café, A teclar,
 * mais rápido, Aura) once on a level change and once on hover (startPetHover), in whole-pixel
 * frames, then holds the static rest frame: `anim.pet`, keyed to its start like every other
 * motion, so a redraw mid-play returns the same string and past its end nothing of it is drawn.
 * A change of look, of width (and a drag) is instant.
 *
 * Layout (layout(W)): the drawing is laid out at its real width, never scaled. The
 * surface fills the frame edge to edge (no margin, no shadow: the band is the card),
 * PAD_Y px above and below it. Left content anchors to the left edge (INSET), the
 * hide / chevron / gear targets (CTRL px each) to the right edge. The model and mode
 * wells share one 4-column grid across the content column; the effort rail spans the
 * same column, its first and last ticks set so the knob lands flush with its edges.
 *
 * Motion rules applied here:
 *  - a value change eases out ('.16 1 .3 1'), from the value on screen, in
 *    <= 280 ms (exits ~20% shorter than entrances); no springs, no overshoot;
 *  - at most MAX_ANIMATED animated elements per change. An element is one
 *    object on screen moving as one (`Track.unit`): the knob, the selected name,
 *    the model selection, the mode selection, the fill, the effort word. When a
 *    change would start more, the lowest-priority ones snap (PRIORITY);
 *  - nothing moves at rest, on hover or on a press; reduced motion is instant.
 */
import { EFFORTS, FAMILIES, FAMILY_NAME, FAMILY_VERSION, MODES as MODE_ORDER, MODE_NAME, type Family, type Mode, type NextStep } from './parse'
import { MODE_ICON_SIZE, modeIcon, modeIconPaths } from './mode-icons'
import {
  DEFAULT_ICON,
  EFFORT_ICONS,
  ICON_MAX_ANIMATED,
  iconEnd,
  iconMarkup,
  startIconChange,
  petPlayEnd,
  type EffortIconKind,
  type IconChange,
  type IconView,
  type PetPlay,
} from './effort-icon'
import { MODEL_TINT } from './pet'
import { crewPetMarkup } from '../crew/costumes'

// ───────────────────────────── public types ─────────────────────────────

export type Theme = 'dark' | 'light'
/** 'A' = transparent Client region over the SVG (default, "Direto"); 'B' = native buttons (fallback, "Botões"). */
export type Mapping = 'A' | 'B'
/** The three controls a person changes (and the acknowledgement names). */
export type Control = 'model' | 'effort' | 'mode'

export type CardView = {
  /** the latest reply's recommendation (task, model, effort, mode) */
  step: NextStep
  /** optional, default true: false when no reply has recommended anything yet (no outline, no chip, no task) */
  hasRec?: boolean
  /** what the card shows selected; effort is the slider index 0..4, fractional while dragging */
  draft: { model: Family; effort: number; mode: Mode }
  collapsed: boolean
  /** optional: everything hidden down to the handle (wins over `collapsed`) */
  hidden?: boolean
  dragging: boolean
  /** optional, defaults to 'A' */
  mapping?: Mapping
  /** optional effort icon (`/crab icon`), default 'star' */
  icon?: EffortIconKind
  /** optional: the band's width in CSS px, the card is laid out at (default CARD_WIDTH, clamped to MIN_WIDTH..MAX_WIDTH) */
  width?: number
}

/** One property in flight. Two keyframes, or three when `via` is set. Times in ms. */
export type Track = {
  from: number[]
  to: number[]
  start: number
  dur: number
  spline: string
  via?: { at: number; v: number[]; spline: string }
  /** the on-screen element this track moves (budget of MAX_ANIMATED per change) */
  unit?: string
}

/** Motion record of one card: what is in flight, and since when. */
export type AnimState = {
  tracks: Record<string, Track>
  /** direction of the last effort level change: the value word rolls with it */
  wdir: 1 | -1
  /** the effort icon's level / kind change (./effort-icon), null when absent; started from the values on screen */
  change: IconChange | null
  /** when the latest motion started (ms): the instant the card is drawn at while it runs; null at rest */
  at: number | null
  /** the pet knob's play in flight (a level change, a hover), or null; optional for older records */
  pet?: PetPlay | null
}

export type Rect = { x: number; y: number; w: number; h: number }
/** A mapping A target (zoneAt ids). */
export type Zone = Rect & { id: string }
/** Tick geometry of the effort rail (SVG px): centre of level i = x0 + step * i. */
export type RailGeometry = { x0: number; step: number; count: number }
export type HitMap = {
  /** the card surface; every rect below lies inside it */
  card: Rect
  /** the hide control (expanded or bar): down to the handle; hidden: the handle itself */
  hide: Rect
  /** the chevron (expanded or bar): collapses or expands */
  toggle: Rect
  /** the gear (expanded or bar): opens the settings pane */
  gear: Rect
  /** the crew pet (expanded or bar): opens the Crew pane */
  crew: Rect
  /** expanded only (otherwise empty) */
  models: Rect[]
  /** expanded and bar: the 5 tick columns of the rail band (the bar's compact rail too); empty hidden */
  efforts: Rect[]
  /** expanded and bar: the rail band for taps and drags (mapping A); null hidden */
  slider: Rect | null
  /** expanded and bar: the rail's ticks (mapping A drags), null hidden */
  rail: RailGeometry | null
  /** expanded only */
  modes: Rect[]
  /** mapping A zones for this view, first match wins (the slider band is separate and last) */
  zones: Zone[]
  /** the fallback native row under the SVG, on the content column */
  native: { rowLeft: number; rowWidth: number; rowHeight: number }
}

/** The width (CSS px) a view without one is laid out at. */
export const CARD_WIDTH = 560
/** The narrowest and widest the card is laid out at: below MIN_WIDTH the card keeps it (the pills still hold their names). */
export const MIN_WIDTH = 280
export const MAX_WIDTH = 2400
/** px of frame above and below the surface (the band's own panel gives the rest) */
export const PAD_Y = 4
/** the content's inset from the surface's left and right edges */
export const INSET = 16
/** the surface's corner radius */
const SURF_R = 12
/** a hide / chevron / gear hit target's width (px), and the gap between the gear's target and the right edge */
export const CTRL = 28
const CTRL_GAP = 8
/** the knob: a round thumb (pill material) holding the icon, on the expanded rail */
export const KNOB_R = 13
/** Most animated elements (units) a single change may start. */
export const MAX_ANIMATED = 4

/** The card's geometry at one width: everything left anchors to INSET, the controls to the right edge. */
export type Layout = {
  /** the width laid out at (CSS px, whole) */
  W: number
  /** the content column */
  grid: { x: number; w: number }
  /** one column of the model and mode wells */
  colW: number
  /** a pill (model or mode), 2 px inside its column */
  pill: { w: number; h: number; rx: number }
  /** the effort ticks: the knob is flush with the column at low and at max */
  rail: RailGeometry
  /** centres (x) of the crew, hide, chevron and gear glyphs */
  ctrl: { crew: number; hide: number; chev: number; gear: number }
  /** the left edge of the crew target (the leftmost control): the bar's body ends there */
  ctrlLeft: number
}

/** A width as laid out: whole px, MIN_WIDTH..MAX_WIDTH; anything not a number is CARD_WIDTH. */
export const widthOf = (w: number | undefined): number =>
  Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(typeof w === 'number' && Number.isFinite(w) ? w : CARD_WIDTH)))

const layoutCache = new Map<number, Layout>()
/** The geometry of the card at width `width` (CSS px). */
export function layout(width?: number): Layout {
  const W = widthOf(width)
  const hit = layoutCache.get(W)
  if (hit) return hit
  const gx = INSET, gw = W - 2 * INSET, colW = gw / 4
  const gear = W - CTRL_GAP - CTRL / 2
  const L: Layout = {
    W,
    grid: { x: gx, w: gw },
    colW,
    pill: { w: colW - 4, h: 24, rx: 6.5 },
    rail: { x0: gx + KNOB_R, step: (gw - 2 * KNOB_R) / 4, count: 5 },
    ctrl: { crew: gear - 3 * CTRL, hide: gear - 2 * CTRL, chev: gear - CTRL, gear },
    ctrlLeft: gear - CTRL / 2 - 3 * CTRL,
  }
  layoutCache.set(W, L)
  return L
}

/** The content column at the default width (the fallback native row uses the same span). */
export const GRID = layout(CARD_WIDTH).grid
/** The effort ticks at the default width. */
export const RAIL: RailGeometry = layout(CARD_WIDTH).rail

// ───────────────────────────── data ─────────────────────────────

const FAM: readonly Family[] = FAMILIES
const MODELS = FAM.map(f => FAMILY_NAME[f])
const VER = FAM.map(f => FAMILY_VERSION[f])
const TINT = FAM.map(f => MODEL_TINT[f])
const EFF = ['low', 'medium', 'high', 'xhigh', 'max']
const MODES: readonly Mode[] = MODE_ORDER
/** visible names (Plan, Auto, Ask, Edits), segment order */
const MODE_NAMES = MODES.map(m => MODE_NAME[m])
const FONT = "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif"
/* Segoe UI widths (spec §3): no canvas in the engine, so fixed tables, keyed by family.
   The bar's name: 13 px, weight 600, letter-spacing -.06; the version after it: 11 px, regular. */
const TW_NAME: Readonly<Record<Family, number>> = { haiku: 33.8, sonnet: 41.3, opus: 30.6, fable: 30.7 }
const TW_VER = 15.1
/** px between a name and its version */
const VER_GAP = 4
/** the expanded pills' name (12.5 px, weight 600) + version unit, the widest of the four: below it the pills drop the version */
const TW_PILL_UNIT = 39.7 + VER_GAP + TW_VER
/** rows of the expanded card (centre y, frame px): the header (task, controls), the model well, the rail, the mode well */
const ROW = { head: PAD_Y + 20, model: PAD_Y + 56, rail: PAD_Y + 96, mode: PAD_Y + 146 } as const
/** the surface heights: the expanded card, the bar, the hidden handle */
const SURF = { expanded: 176, bar: 40, hidden: 12 } as const
/** the effort word's baseline, under the knob (offset from the knob centre) */
const WORD_DY = 26
/** The frame height of each look: fixed, so the prompt box never moves on its own. */
export const LOOK_H = { expanded: SURF.expanded + 2 * PAD_Y, bar: SURF.bar + 2 * PAD_Y, hidden: SURF.hidden + 2 * PAD_Y } as const
const lookOf = (v: Pick<CardView, 'collapsed' | 'hidden'>): keyof typeof LOOK_H => (v.hidden ? 'hidden' : v.collapsed ? 'bar' : 'expanded')
/**
 * The bar's compact effort rail: 5 ticks BAR_RAIL.step px apart from x0, a 2 px track BAR_TRACK_DY under
 * the knob row, the knob (the effort icon, the pet by default) centred on (tick, BAR_KNOB_Y), whole pixels.
 */
export const BAR_RAIL: RailGeometry = { x0: INSET + 12, step: 16, count: 5 }
const BAR_KNOB_Y = PAD_Y + SURF.bar / 2 - 2
const BAR_TRACK_DY = 11
/** the rail band's edges (the slider zone and the track): from the inset to the last tick plus the knob's half width */
const BAR_RAIL_X0 = INSET
const BAR_RAIL_X1 = BAR_RAIL.x0 + BAR_RAIL.step * 4 + 12
/**
 * The collapsed bar, one row on one baseline: the compact effort rail, then the name + version from
 * nameX, the mode icon MODE_GAP_BAR after the version.
 */
const BAR = { cy: PAD_Y + SURF.bar / 2, nameX: BAR_RAIL_X1 + 10, base: PAD_Y + SURF.bar / 2 + 4 } as const
/** the bar's knob x for a (fractional) effort, on a whole pixel */
const barKnobX = (lv: number): number => Math.round(BAR_RAIL.x0 + BAR_RAIL.step * Math.max(0, Math.min(4, lv)))
const MODE_GAP_BAR = 12
/** x of the bar's mode icon (its left edge) for model i */
const barModeX = (i: number): number => BAR.nameX + TW_NAME[FAM[i] ?? 'opus'] + VER_GAP + TW_VER + MODE_GAP_BAR
/* mode pills: [icon 16] gap [name], the unit centred in its pill. Name widths measured
   (canvas, Segoe UI 12 px, weight 600, letter-spacing -.04), keyed by mode */
const TW_MODE: Readonly<Record<Mode, number>> = { plan: 23.3, auto: 26.3, default: 19.4, acceptEdits: 25.9 }
const MODE_GAP = 5
const modeUnit = (i: number): number => MODE_ICON_SIZE + MODE_GAP + TW_MODE[MODES[i] ?? 'auto']
/* the recommendation chip on the bar: "Name · effort" at 11 px (letter-spacing -.02), measured, then a 12 px mode icon */
const TW_REC_NAME: Readonly<Record<Family, number>> = { haiku: 27.7, sonnet: 34.1, opus: 25.6, fable: 25.4 }
const TW_REC_EFF = [17.1, 40, 21.5, 26.6, 20.1]
const TW_SEP = 8.3 /* " · " */
/** the chip: starts REC.gap after the mode icon, a capsule REC.h high, text REC.pad inside, a REC.icon px mode icon REC.iconGap after the text */
const REC = { gap: 12, pad: 9, h: 20, icon: 12, iconGap: 5 } as const
const recTextW = (model: number, level: number): number => TW_REC_NAME[FAM[model] ?? 'opus'] + TW_SEP + (TW_REC_EFF[level] ?? 21.5)
/** the chip's width for a recommendation */
const recW = (model: number, level: number): number => REC.pad + recTextW(model, level) + REC.iconGap + REC.icon + REC.pad

const TINT_PILL = 0.12
const TINT_FILL = 0.35

type Tokens = {
  surface: string; sOp: number; rim: string; rimOp: number
  text: string; muted: string; segMuted: string
  track: string; trackRim: string; trackRimOp: number; pill: string; pillEdge: string; pillEdgeOp: number; pillSh: number
  slTrack: string; slFill: string; tick: string; hintOp: number
  /** the recommendation chip: a faint capsule of the muted ink, and its text's opacity */
  chipOp: number; chipTextOp: number
}
const THEMES: Record<Theme, Tokens> = {
  dark: {
    surface: '#232326', sOp: 0.94, rim: '#FFFFFF', rimOp: 0.08,
    text: '#E6E6E6', muted: '#939398', segMuted: '#9C9CA1',
    track: '#1A1A1D', trackRim: '#000000', trackRimOp: 0.3, pill: '#3A3A3F', pillEdge: '#FFFFFF', pillEdgeOp: 0.12, pillSh: 0.45,
    slTrack: '#3A3A3F', slFill: '#C8C8CC', tick: '#5E5E64', hintOp: 0.5,
    chipOp: 0.12, chipTextOp: 0.85,
  },
  light: {
    surface: '#FFFFFF', sOp: 0.9, rim: '#000000', rimOp: 0.09,
    text: '#1D1D1F', muted: '#6B6B70', segMuted: '#5F5F64',
    track: '#EEEEF1', trackRim: '#000000', trackRimOp: 0.035, pill: '#FFFFFF', pillEdge: '#FFFFFF', pillEdgeOp: 1, pillSh: 0.16,
    slTrack: '#E2E2E6', slFill: '#3A3A3C', tick: '#C2C2C7', hintOp: 0.45,
    chipOp: 0.08, chipTextOp: 0.9,
  },
}

/** The crew control's glyph: the plain crew pet, still, no costume, no tint (a muted shadow), per theme. */
const CREW_GLYPH: Record<Theme, string> = {
  dark: crewPetMarkup({ role: null, model: null, status: 'done', theme: 'dark', reduced: true, idPrefix: 'kcrewd' }),
  light: crewPetMarkup({ role: null, model: null, status: 'done', theme: 'light', reduced: true, idPrefix: 'kcrewl' }),
}

// ───────────────────────────── curves and timings ─────────────────────────────

/** keySplines: plain cubic-bezier ease curves (none is a spring). */
export const CURVE = {
  /** every state change: fast start, long soft landing */
  out: '.16 1 .3 1',
  /** flat segment (a hold before a delayed fade) */
  lin: '0 0 1 1',
} as const
const { out: EASE_OUT, lin: LIN } = CURVE

/** Durations (ms), all <= 280. Exits are ~20% shorter than the matching entrance. */
export const CARD_MS = {
  /** a pill, the knob or the fill moving to a new choice */
  select: 280,
  fadeIn: 200,
  fadeOut: 160,
  /** release of a drag: the knob eases onto the tick */
  release: 240,
} as const
const FRAME_MS = 1000 / 60

/** Snap order when a change would start more than MAX_ANIMATED units (first = kept first). */
const PRIORITY = ['knob', 'name', 'model', 'mode', 'fill', 'word', 'fade']

// ───────────────────────────── small helpers ─────────────────────────────

const g = (a: readonly number[] | undefined, i: number): number => (a ? (a[i] ?? 0) : 0)
const r2 = (x: number): number => {
  const r = Math.round(x * 100) / 100
  return Object.is(r, -0) ? 0 : r
}
const r3 = (x: number): number => {
  const r = Math.round(x * 1000) / 1000
  return Object.is(r, -0) ? 0 : r
}
const F = (v: readonly number[]): string => v.map(r2).join(' ')
/** the gear glyph, centred on (0,0): 8 teeth, drawn as a stroked outline (a small circle is the hub) */
const GEAR_PATH = ((): string => {
  const R = 6.6, r = 4.9, pts: string[] = []
  const at = (rad: number, deg: number): string => `${r2(rad * Math.cos((deg * Math.PI) / 180))} ${r2(rad * Math.sin((deg * Math.PI) / 180))}`
  for (let i = 0; i < 8; i++) {
    const c = i * 45
    pts.push(at(r, c - 15), at(R, c - 8.5), at(R, c + 8.5), at(r, c + 15))
  }
  return `M${pts.join('L')}Z`
})()
const eqv = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((x, i) => Math.abs(x - g(b, i)) < 1e-3)
/* drop what XML 1.0 cannot hold (C0 controls, lone surrogates, U+FFFE/FFFF), then escape */
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const esc = (s: string): string => s.replace(XML_BAD, '').replace(/[&<>"]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'))
const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x))
const levelOf = (effort: number): number => Math.round(clamp(Number.isFinite(effort) ? effort : 0, 0, 4))
const iconOf = (v: CardView): EffortIconKind => ((EFFORT_ICONS as readonly unknown[]).includes(v.icon) ? (v.icon as EffortIconKind) : DEFAULT_ICON)
/** left edge of pill i (model and mode share the grid) */
const pillX = (L: Layout, i: number): number => L.grid.x + 2 + L.colW * i
/** centre of column i */
const colCx = (L: Layout, i: number): number => L.grid.x + L.colW * (i + 0.5)
const tickX = (L: Layout, i: number): number => L.rail.x0 + L.rail.step * i
/** The drawn task is capped: past the controls it is masked anyway, and the source must stay under the Svg limit. */
export const TASK_MAX = 240
const clampTask = (t: string): string => {
  const one = t.replace(/\s+/g, ' ').trim()
  return one.length > TASK_MAX ? one.slice(0, TASK_MAX - 1).trimEnd() + '…' : one
}
/** keys drawn as whole-pixel discrete steps (the knob's placement) */
const PX_KEYS = new Set(['kT', 'bk'])

function bez(s: string, x: number): number {
  const p = s.split(' ').map(Number)
  const x1 = g(p, 0), y1 = g(p, 1), x2 = g(p, 2), y2 = g(p, 3)
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

function frames(tr: Track): { kf: number[][]; kt: number[]; ks: string[] } {
  return tr.via
    ? { kf: [tr.from, tr.via.v, tr.to], kt: [0, tr.via.at, 1], ks: [tr.spline, tr.via.spline] }
    : { kf: [tr.from, tr.to], kt: [0, 1], ks: [tr.spline] }
}

/** The value a track draws at `now` (a replica of the SMIL spline). */
export function sampleTrack(tr: Track, now: number): number[] {
  if (!tr.dur) return tr.to.slice()
  const u = (now - tr.start) / tr.dur
  if (u >= 1) return tr.to.slice()
  if (u <= 0) return tr.from.slice()
  const { kf, kt, ks } = frames(tr)
  let k = 0
  while (k < kt.length - 2 && u > g(kt, k + 1)) k++
  const a = kf[k] ?? tr.from, b = kf[k + 1] ?? tr.to
  const p = (u - g(kt, k)) / (g(kt, k + 1) - g(kt, k))
  const e = bez(ks[k] ?? LIN, p)
  return a.map((x, j) => x + (g(b, j) - x) * e)
}

/** A whole-pixel track: the eased curve sampled once per display frame, rounded, repeats merged (SMIL discrete). */
function pxFrames(tr: Track): { kf: number[][]; kt: number[] } {
  const n = Math.max(1, Math.ceil(tr.dur / FRAME_MS))
  const kf: number[][] = [], kt: number[] = []
  for (let i = 0; i <= n; i++) {
    const u = i / n
    const v = sampleTrack(tr, tr.start + u * tr.dur).map(x => Math.round(x) + 0)
    const last = kf[kf.length - 1]
    if (last && eqv(last, v)) continue
    kf.push(v)
    kt.push(r3(u))
  }
  return { kf, kt }
}
/** What a whole-pixel track draws at `now`. */
function pxAt(tr: Track, now: number): number[] {
  const { kf, kt } = pxFrames(tr)
  const u = (now - tr.start) / tr.dur
  let k = 0
  while (k < kt.length - 1 && u >= g(kt, k + 1)) k++
  return (kf[k] ?? tr.to).slice()
}

const alive = (tr: Track | undefined, now: number): tr is Track => !!tr && tr.dur > 0 && now < tr.start + tr.dur
/** the value on screen of a key's track at `now` */
const shown = (k: string, tr: Track, now: number): number[] => (PX_KEYS.has(k) ? pxAt(tr, now) : sampleTrack(tr, now))

// ───────────────────────────── view -> state ─────────────────────────────

type St = {
  E: boolean; model: number; effort: number; mode: number
  dragging: boolean; wdir: 1 | -1
  /** the recommendation (the footer's values); the selection itself when there is none, so nothing differs */
  rec: { model: number; effort: number; mode: number }
  /** a reply has recommended something */
  hasRec: boolean
  /** the geometry at the view's width */
  L: Layout
}

function toSt(v: CardView, wdir: 1 | -1): St {
  const model = Math.max(0, FAM.indexOf(v.draft.model))
  const effort = clamp(Number.isFinite(v.draft.effort) ? v.draft.effort : 0, 0, 4)
  const mode = Math.max(0, MODES.indexOf(v.draft.mode))
  const hasRec = v.hasRec !== false
  return {
    E: !v.collapsed,
    model,
    effort,
    mode,
    dragging: v.dragging,
    wdir,
    hasRec,
    rec: hasRec
      ? {
          model: Math.max(0, FAM.indexOf(v.step.model)),
          effort: Math.max(0, EFFORTS.indexOf(v.step.effort)),
          mode: Math.max(0, MODES.indexOf(v.step.mode)),
        }
      : { model, effort: Math.round(effort), mode },
    L: layout(v.width),
  }
}

/** True when the card shows exactly the footer's recommendation (rounded effort). */
export function matchesRecommendation(view: CardView): boolean {
  const st = toSt(view, 1)
  return st.model === st.rec.model && Math.round(st.effort) === st.rec.effort && st.mode === st.rec.mode
}

/** Slider position (SVG x, expanded card laid out at `width`) -> fractional effort 0..4. */
export function effortFromX(x: number, width?: number): number {
  return effortOnRail(x, layout(width).rail)
}

/** A knob x on `rail` (the expanded rail or the bar's compact one) -> fractional effort 0..4. */
export function effortOnRail(x: number, rail: RailGeometry): number {
  return clamp((x - rail.x0) / Math.max(1, rail.step), 0, 4)
}

// ───────────────────────────── targets ─────────────────────────────

type Vals = Record<string, number[]>

/** The bar's chip fits between the mode icon and the controls at this width. */
const chipFits = (st: St): boolean => barModeX(st.model) + MODE_ICON_SIZE + REC.gap + recW(st.rec.model, st.rec.effort) <= st.L.ctrlLeft - 8

function targets(st: St): Vals {
  const t: Vals = {}, sel = st.model, lv = st.effort, Lv = Math.round(lv), md = st.mode, L = st.L
  /* the chevron points down on the bar (expand), up on the card (collapse) */
  t.chR = [st.E ? 0 : 180]
  if (!st.E) {
    /* bar: only the selected name shows, in the text slot; the mode icon (and the chip) after it */
    for (let i = 0; i < 4; i++) t['opN' + i] = [i === sel ? 1 : 0]
    t.cmX = [barModeX(sel)]
    /* the quiet recommendation chip, only while the session differs from it (and it fits) */
    const differs = st.rec.model !== sel || st.rec.effort !== Lv || st.rec.mode !== md
    t.opRec = [st.hasRec && differs && chipFits(st) ? 1 : 0]
    /* the compact rail: the knob on a whole pixel (also mid-drag), the fill up to it */
    const bx = barKnobX(lv)
    t.bk = [bx, BAR_KNOB_Y]
    t.bfW = [Math.max(0, bx - BAR_RAIL_X0)]
    return t
  }
  /* model: the pill on the well, each name centred in its column */
  t.mPill = [pillX(L, sel), ROW.model - L.pill.h / 2, L.pill.w, L.pill.h, L.pill.rx]
  for (let i = 0; i < 4; i++) {
    t['nT' + i] = [colCx(L, i), ROW.model]
    t['opN' + i] = [1]
    t['opNB' + i] = [i === sel ? 1 : 0]
    t['opPT' + i] = [i === sel ? 1 : 0]
    t['opOB' + i] = [i === md ? 1 : 0]
  }
  /* mode: the pill slides along the same grid as the model pill */
  t.oPill = [pillX(L, md)]
  /* effort: the knob sits on a whole pixel, also mid-drag */
  const kx = Math.round(tickX(L, lv))
  t.fillW = [Math.max(0, kx - L.grid.x)]
  for (let i = 0; i < 5; i++) {
    t['opTA' + i] = [i > lv + 0.05 ? 1 : 0]
    t['opW' + i] = [i === Lv ? 1 : 0]
    t['wY' + i] = [i === Lv ? 0 : -6 * st.wdir]
  }
  t.kT = [kx, ROW.rail]
  return t
}

// ───────────────────────────── transition spec ─────────────────────────────

/** 'instant' = a change of look or of width, or the knob under the pointer: nothing animates. */
type Kind = 'instant' | 'release' | 'select'

/** The on-screen element a key belongs to. */
function unitOf(k: string): string {
  if (k === 'kT' || k === 'bk') return 'knob'
  if (k === 'mPill' || /^op(PT|NB)\d$/.test(k)) return 'model'
  if (k === 'oPill' || /^opOB\d$/.test(k)) return 'mode'
  if (k === 'fillW' || k === 'bfW' || /^opTA\d$/.test(k)) return 'fill'
  if (/^(opW|wY)\d$/.test(k)) return 'word'
  if (/^nT\d$|^opN\d$|^cmX$/.test(k)) return 'name'
  return 'fade'
}

function spec(k: string, cur: number[], to: number[], kind: Kind, now: number): Track {
  const one = (dur: number): Track => ({ from: cur, to, start: now, dur, spline: EASE_OUT, unit: unitOf(k) })
  const up = g(to, 0) > g(cur, 0)
  if (kind === 'release' && (k === 'kT' || k === 'fillW' || k === 'bk' || k === 'bfW')) return one(CARD_MS.release) /* lands on the tick, no overshoot */
  if (/^wY/.test(k)) return one(g(to, 0) === 0 ? CARD_MS.fadeIn : CARD_MS.fadeOut)
  if (k.startsWith('op')) return one(up ? CARD_MS.fadeIn : CARD_MS.fadeOut)
  return one(CARD_MS.select)
}

function kindOf(b: CardView, a: CardView): Kind {
  if (lookOf(b) !== lookOf(a) || widthOf(b.width) !== widthOf(a.width) || (b.mapping ?? 'A') !== (a.mapping ?? 'A') || a.dragging) return 'instant'
  return b.dragging ? 'release' : 'select'
}

// ───────────────────────────── icon glue ─────────────────────────────

function iconViewOf(v: CardView, change: IconChange | null, now: number, theme: Theme, reduced: boolean, idPrefix: string, play: PetPlay | null = null): IconView {
  return {
    play: reduced ? null : play,
    kind: iconOf(v),
    level: levelOf(v.draft.effort),
    model: v.draft.model,
    change: reduced ? null : change,
    reaction: null,
    now,
    reduced,
    theme,
    idPrefix,
  }
}
/** an icon record still running at `now` */
const recLive = (change: IconChange, now: number): boolean => iconEnd({ change, reaction: null, reduced: false, now }) !== null

/** Tolerates a record from an older version (missing fields read as absent; unknown icon kinds dropped). */
function norm(a: Partial<AnimState> | null | undefined): AnimState {
  const x: Partial<AnimState> = a ?? {}
  const kindOk = (r: { kind?: unknown } | null | undefined): boolean => !!r && (EFFORT_ICONS as readonly unknown[]).includes(r.kind)
  return {
    tracks: x.tracks ?? {},
    wdir: x.wdir === -1 ? -1 : 1,
    change: kindOk(x.change) ? (x.change ?? null) : null,
    at: typeof x.at === 'number' ? x.at : null,
    pet: x.pet && typeof x.pet.start === 'number' && typeof x.pet.level === 'number' ? x.pet : null,
  }
}

/** a pet play still running at `now` */
const petLive = (p: PetPlay | null | undefined, now: number): p is PetPlay => !!p && now >= p.start && now < petPlayEnd(p)

// ───────────────────────────── retarget ─────────────────────────────

export function emptyAnim(): AnimState {
  return { tracks: {}, wdir: 1, change: null, at: null, pet: null }
}

/**
 * The pointer came over the effort knob or rail: the pet plays its level's sequence once, from `now`,
 * unless one is already running (nothing restarts under a resting pointer), the icon is not the pet, the
 * card is hidden or dragged, or motion is reduced. The drawing is keyed to the new start (`at`), so the
 * redraws during the play return the same string; anything else in flight continues from where it is.
 */
export function startPetHover(animIn: AnimState, view: CardView, now: number, reduced: boolean): AnimState {
  const anim = norm(animIn)
  if (reduced || view.hidden || view.dragging || iconOf(view) !== 'pet' || petLive(anim.pet, now)) return anim
  return { ...anim, pet: { level: levelOf(view.draft.effort), start: now }, at: now }
}

/** True while a pet play runs at `now` (the hooks skip a hover then: no redraw for it). */
export const petPlaying = (anim: AnimState, now: number): boolean => petLive(norm(anim).pet, now)

/**
 * Called when the view on screen changes. Computes, per key, the value on screen
 * at `now` and starts a new transition from it to the new target; keys whose
 * target did not change keep their running curve. The icon's level / kind change
 * starts from the values on screen too. A change of look, the mapping and a drag
 * are instant; reduced motion: nothing moves. A change that starts nothing new
 * keeps `at`, so the drawing (keyed to it) stays the same.
 */
export function retarget(prevIn: AnimState, before: CardView, after: CardView, now: number, reduced: boolean): AnimState {
  const prev = norm(prevIn)
  const kind = kindOf(before, after)
  const Lb = levelOf(before.draft.effort), La = levelOf(after.draft.effort)
  const wdir: 1 | -1 = La !== Lb ? (La > Lb ? 1 : -1) : prev.wdir
  if (reduced || kind === 'instant') return { ...emptyAnim(), wdir }
  /* the pet knob plays the new level's sequence on a level change and on the release of a drag (the commit);
     a play already running for the same level keeps going */
  const petPrev = petLive(prev.pet, now) && levelOf(prev.pet.level) === La ? prev.pet : null
  const petNew: PetPlay | null = iconOf(after) === 'pet' && (La !== Lb || kind === 'release') && !petPrev ? { level: La, start: now } : null
  const pet: PetPlay | null = petNew ?? petPrev
  const tgB = targets(toSt(before, prev.wdir))
  const tgA = targets(toSt(after, wdir))
  const curOf = (k: string): number[] => {
    const p = prev.tracks[k]
    return alive(p, now) ? shown(k, p, now) : (tgB[k] ?? tgA[k] ?? [0]).slice()
  }
  const tracks: Record<string, Track> = {}
  let started = false

  for (const k of Object.keys(tgA)) {
    const to = tgA[k] ?? [0], p = prev.tracks[k]
    let cur = curOf(k)
    if (alive(p, now) && eqv(p.to, to)) { tracks[k] = p; continue } /* same target: keep the running curve */
    if (eqv(cur, to)) continue /* static */
    if (/^wY/.test(k)) { /* a hidden word re-enters from the side it is coming from */
      const o = g(curOf('opW' + k.slice(2)), 0)
      if (o < 0.04) {
        if (g(to, 0) === 0) cur = [6 * wdir]
        else continue
      }
    }
    /* geometry of something invisible before and after: it just jumps */
    const layer = /^nT\d$/.test(k) ? 'opN' + k.slice(2) : null
    if (layer) {
      const o0 = g(curOf(layer), 0), o1 = g(tgA[layer], 0)
      if (o1 === 0 && o0 < 0.04) continue
      if (o0 < 0.04) continue /* a name that appears does so in place */
      if (o1 === 0) { /* a name that goes fades where it is, then moves while invisible */
        tracks[k] = { from: cur, to, start: now, dur: CARD_MS.fadeOut, spline: LIN, via: { at: 0.99, v: cur, spline: LIN }, unit: 'fade' }
        started = true
        continue
      }
    }
    tracks[k] = spec(k, cur, to, kind, now)
    started = true
  }

  /* the icon: start from what is drawn just before this change */
  let change: IconChange | null = prev.change && recLive(prev.change, now) ? prev.change : null
  if (La !== Lb || iconOf(before) !== iconOf(after)) {
    change = startIconChange(iconViewOf(before, change, now, 'dark', false, ''), now)
    /* the knob sliding to the new tick is one more element: the icon gets one fewer */
    if (tracks.kT?.start === now) change = { ...change, max: ICON_MAX_ANIMATED - 1 }
    started = true
  }
  if (petNew) started = true
  if (!started) return { tracks, wdir, change, at: Object.keys(tracks).length > 0 || change !== null || pet !== null ? prev.at : null, pet }

  /* budget: at most MAX_ANIMATED elements start moving in one change; the lowest priority snap */
  const fresh = Object.keys(tracks).filter(k => tracks[k]?.start === now && (tracks[k]?.dur ?? 0) > 0)
  const units = new Set(fresh.map(k => tracks[k]?.unit ?? 'fade'))
  if (change?.start === now) units.add('knob')
  if (units.size > MAX_ANIMATED) {
    const rank = (u: string): number => (PRIORITY.indexOf(u) + 1 || PRIORITY.length + 1)
    const keep = new Set([...units].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_ANIMATED))
    for (const k of fresh) if (!keep.has(tracks[k]?.unit ?? 'fade')) delete tracks[k]
    if (!keep.has('knob') && change?.start === now) change = null
  }
  return { tracks, wdir, change, at: now, pet }
}

/** Latest end time (ms) of anything in flight, or null at rest: past it the card draws no SMIL at all. */
export function animEnd(animIn: AnimState): number | null {
  const anim = norm(animIn)
  let end: number | null = null
  const up = (t: number): void => { end = end === null ? t : Math.max(end, t) }
  for (const tr of Object.values(anim.tracks)) if (tr.dur) up(tr.start + tr.dur)
  const pe = anim.change ? iconEnd({ change: anim.change, reaction: null, reduced: false, now: -Infinity }) : null
  if (pe !== null) up(pe)
  if (anim.pet) up(petPlayEnd(anim.pet))
  return end
}

/** The elements (units) whose motion started at `now`: at most MAX_ANIMATED after a retarget. */
export function unitsAt(animIn: AnimState, now: number): string[] {
  const anim = norm(animIn)
  const u = new Set<string>()
  for (const tr of Object.values(anim.tracks)) if (tr.start === now && tr.dur > 0) u.add(tr.unit ?? 'fade')
  if (anim.change?.start === now || anim.pet?.start === now) u.add('knob')
  return [...u]
}

// ───────────────────────────── SMIL emission ─────────────────────────────

type Fn = (v: number[]) => number[]

function smil(head: string, tr: Track | undefined, now: number, fn?: Fn): string {
  if (!alive(tr, now)) return ''
  const { kf, kt, ks } = frames(tr)
  const vs = kf.map(v => F(fn ? fn(v) : v))
  if (vs.every(x => x === vs[0])) return ''
  return `<${head} values="${vs.join(';')}" keyTimes="${kt.join(';')}" calcMode="spline" keySplines="${ks.join(';')}" dur="${r3(tr.dur / 1000)}s" begin="${r3(-(now - tr.start) / 1000)}s" fill="freeze"/>`
}
const animStr = (tr: Track | undefined, now: number, attr: string, fn?: Fn): string => smil(`animate attributeName="${attr}"`, tr, now, fn)
const animTStr = (tr: Track | undefined, now: number, type: string, fn?: Fn): string =>
  smil(`animateTransform attributeName="transform" type="${type}"`, tr, now, fn)
/** a whole-pixel translate: one rounded value per display frame, held (discrete) */
function animPxStr(tr: Track | undefined, now: number): string {
  if (!alive(tr, now)) return ''
  const { kf, kt } = pxFrames(tr)
  if (kf.length < 2) return ''
  return `<animateTransform attributeName="transform" type="translate" values="${kf.map(F).join(';')}" keyTimes="${kt.join(';')}" calcMode="discrete" dur="${r3(tr.dur / 1000)}s" begin="${r3(-(now - tr.start) / 1000)}s" fill="freeze"/>`
}


// ───────────────────────────── builders ─────────────────────────────

type Ctx = {
  id: string
  v: (k: string) => number[]
  a: (k: string, attr: string, fn?: Fn) => string
  t: (k: string, type: string, fn?: Fn) => string
  px: (k: string) => string
  T: Tokens
  st: St
  task: string
  /** the effort icon fragment (on the knob expanded, on its own in the bar) */
  icon: string
}

const RA = ['x', 'y', 'width', 'height', 'rx']

function helpers(P: Ctx) {
  const { v, a } = P
  const n = (k: string): number => g(v(k), 0)
  return {
    n,
    rect: (k: string, extra: string, inner = ''): string => {
      const q = v(k)
      return `<rect ${q.map((x, j) => `${RA[j]}="${r2(x)}"`).join(' ')} ${extra}>${q.map((_, j) => a(k, RA[j] ?? 'x', z => [g(z, j)])).join('')}${inner}</rect>`
    },
    O: (k: string): string => `opacity="${r2(n(k))}"`,
    OA: (k: string): string => a(k, 'opacity'),
    /* skip layers that are invisible and still */
    lay: (k: string, inner: string): string => {
      const an = a(k, 'opacity')
      if (!an && n(k) === 0) return ''
      return `<g opacity="${r2(n(k))}">${an}${inner}</g>`
    },
  }
}

/**
 * The surface: the band itself, edge to edge (x 0..W), PAD_Y px of frame above and
 * below, one hairline rim, no shadow (nothing to cast it on but the band) and a clip for
 * the content. `ch`: the surface height.
 */
function material(I: string, T: Tokens, W: number, ch: number): string {
  return `<defs><clipPath id="${I}cp"><rect x="0" y="${PAD_Y}" width="${W}" height="${ch}" rx="${SURF_R}"/></clipPath></defs>` +
    `<rect x="0" y="${PAD_Y}" width="${W}" height="${ch}" rx="${SURF_R}" fill="${T.surface}" fill-opacity="${T.sOp}"/>` +
    `<rect x=".5" y="${PAD_Y + 0.5}" width="${W - 1}" height="${ch - 1}" rx="${SURF_R - 0.5}" fill="none" stroke="${T.rim}" stroke-opacity="${T.rimOp}"/>`
}

/** A segmented well on the grid, centred on row y. */
const well = (L: Layout, T: Tokens, cy: number): string =>
  `<rect x="${r2(L.grid.x)}" y="${cy - 14}" width="${r2(L.grid.w)}" height="28" rx="8" fill="${T.track}" stroke="${T.trackRim}" stroke-opacity="${T.trackRimOp}"/>`
/** The recommendation hint: a faint dashed outline inside pill i's rect, fully covered by the pill when selected. */
const hint = (L: Layout, T: Tokens, i: number, cy: number): string =>
  `<rect class="cc-rec" x="${r2(pillX(L, i) + 0.5)}" y="${r2(cy - L.pill.h / 2 + 0.5)}" width="${r2(L.pill.w - 1)}" height="${L.pill.h - 1}" rx="${L.pill.rx - 0.5}" fill="none" stroke="${T.muted}" stroke-opacity="${T.hintOp}" stroke-dasharray="3 2.5"/>`
/** A small stroked glyph in the muted ink, centred on (x, the controls' row). */
const ctrl = (x: number, inner: string): string => `<g transform="translate(${r2(x)} ${ROW.head})">${inner}</g>`
/** The hide control: a short bar (minimise). */
const hideGlyph = (T: Tokens): string => `<path class="cc-hide" d="M-4.5 0H4.5" fill="none" stroke="${T.muted}" stroke-width="1.5" stroke-linecap="round"/>`
/** "Name" + the version after it, muted and regular, on one baseline (one text: the version follows whatever the name's real width). */
const nameText = (attrs: string, inner: string, i: number, ver: boolean, verFill: string): string =>
  `<text ${attrs}>${inner}${MODELS[i]}${ver ? `<tspan dx="${VER_GAP}" font-size="11" font-weight="400" letter-spacing="0" fill="${verFill}">${VER[i]}</tspan>` : ''}</text>`

/** Everything on the surface. */
function content(P: Ctx): string {
  const { id: I, v, a, t, T, st, task } = P
  const { n, rect, O, OA, lay } = helpers(P)
  const L = st.L
  let s = ''
  /* hide, chevron and gear, right-anchored on the controls' row: each a CTRL px zone */
  s += ctrl(L.ctrl.hide, hideGlyph(T))
  s += ctrl(L.ctrl.chev, `<g transform="rotate(${r2(n('chR'))})"><path d="M-4.5 2.25L0-2.25L4.5 2.25" fill="none" stroke="${T.muted}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></g>`)
  s += ctrl(L.ctrl.gear, `<path class="cc-gear" d="${GEAR_PATH}" fill="none" stroke="${T.muted}" stroke-width="1.25" stroke-linejoin="round"/><circle r="2.1" fill="none" stroke="${T.muted}" stroke-width="1.25"/>`)
  /* the crew: a small still pet (half scale: whole device pixels at 2x) that opens the Crew pane */
  s += ctrl(L.ctrl.crew, `<g class="cc-crew" transform="translate(0 1) scale(.5)"><title>Crew</title>${CREW_GLYPH[T === THEMES.light ? 'light' : 'dark']}</g>`)

  if (!st.E) {
    /* the bar, one row on one baseline: the compact effort rail with the icon as its knob, Name ver, the mode icon, the quiet chip */
    const ty = BAR_KNOB_Y + BAR_TRACK_DY, fw = Math.max(0, n('bfW'))
    s += `<rect class="cc-bar-rail" x="${BAR_RAIL_X0}" y="${ty}" width="${BAR_RAIL_X1 - BAR_RAIL_X0}" height="2" rx="1" fill="${T.slTrack}"/>`
    s += `<rect x="${BAR_RAIL_X0}" y="${ty}" width="${r2(fw)}" height="2" rx="1" fill="${T.slFill}" fill-opacity=".55">${a('bfW', 'width', x => [Math.max(0, g(x, 0))])}</rect>`
    for (let i = 0; i < 5; i++) s += `<rect x="${BAR_RAIL.x0 + BAR_RAIL.step * i - 1}" y="${ty}" width="2" height="2" fill="${T.tick}"/>`
    const bk = v('bk').map(x => Math.round(x))
    s += `<g class="cc-bar-knob" transform="translate(${F(bk)})">${P.px('bk')}${P.icon}</g>`
    for (let i = 0; i < 4; i++) {
      if (n('opN' + i) === 0 && !OA('opN' + i)) continue
      s += `<g ${O('opN' + i)}>${OA('opN' + i)}${nameText(`x="${BAR.nameX}" y="${BAR.base}" font-size="13" font-weight="600" letter-spacing="-.06" fill="${T.text}"`, '', i, true, T.muted)}</g>`
    }
    const mBar = MODES[st.mode] ?? 'auto', mTop = BAR.cy - MODE_ICON_SIZE / 2
    s += modeIcon(mBar, T.segMuted, { x: r2(n('cmX')), y: mTop, title: MODE_NAMES[st.mode], attrs: 'class="cc-mode"', anim: t('cmX', 'translate', x => [g(x, 0), mTop]) })
    /* the recommendation: a faint capsule riding the mode icon's slide, lower contrast than the label */
    const R = st.rec, x0 = MODE_ICON_SIZE + REC.gap, tw = recTextW(R.model, R.effort)
    s += lay('opRec', `<g transform="translate(${r2(n('cmX'))} 0)">${t('cmX', 'translate', x => [g(x, 0), 0])}` +
      `<rect class="cc-rec-chip" x="${x0}" y="${BAR.cy - REC.h / 2}" width="${r2(recW(R.model, R.effort))}" height="${REC.h}" rx="${REC.h / 2}" fill="${T.muted}" fill-opacity="${T.chipOp}"/>` +
      `<text x="${x0 + REC.pad}" y="${BAR.base}" font-size="11" letter-spacing="-.02" fill="${T.muted}" opacity="${T.chipTextOp}">${esc(`${MODELS[R.model]} · ${EFF[R.effort]}`)}</text>` +
      `<g class="cc-rec-mode" transform="translate(${r2(x0 + REC.pad + tw + REC.iconGap)} ${BAR.cy - REC.icon / 2}) scale(${REC.icon / MODE_ICON_SIZE})" opacity="${T.chipTextOp}"><title>${MODE_NAMES[R.mode]}</title>${modeIconPaths(MODES[R.mode] ?? 'auto', T.muted)}</g></g>`)
    return s
  }

  /* the expanded card */
  const fd = `${I}fd`, fadeEnd = L.ctrlLeft - 8, fadeStart = fadeEnd - 36
  s = `<defs>` +
    `<filter id="${I}ps" x="-30%" y="-50%" width="160%" height="220%"><feDropShadow dx="0" dy="1" stdDeviation="1.1" flood-color="#000" flood-opacity="${T.pillSh}"/></filter>` +
    `<linearGradient id="${I}pe" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${T.pillEdge}" stop-opacity="${T.pillEdgeOp}"/><stop offset=".55" stop-color="${T.pillEdge}" stop-opacity="0"/></linearGradient>` +
    `<linearGradient id="${fd}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    `<mask id="${I}tm" maskUnits="userSpaceOnUse" x="0" y="0" width="${L.W}" height="${LOOK_H.expanded}"><rect x="0" y="0" width="${r2(fadeStart)}" height="${LOOK_H.expanded}" fill="#fff"/><rect x="${r2(fadeStart)}" y="0" width="36" height="${LOOK_H.expanded}" fill="url(#${fd})"/></mask>` +
    `</defs>` + s
  /* task, on the column's left edge, faded out before the controls */
  s += `<g mask="url(#${I}tm)"><text x="${r2(L.grid.x)}" y="${ROW.head + 4.5}" font-size="13" font-weight="500" letter-spacing="-.13" fill="${T.text}">${esc(task)}</text></g>`
  /* model control: well, recommendation hint, pill, tint */
  s += well(L, T, ROW.model)
  if (st.rec.model !== st.model || a('mPill', 'x')) s += hint(L, T, st.rec.model, ROW.model)
  s += rect('mPill', `fill="${T.pill}" filter="url(#${I}ps)"`)
  for (let i = 0; i < 4; i++) s += lay('opPT' + i, rect('mPill', `fill="${TINT[i]}" fill-opacity="${TINT_PILL}"`)) /* the model's tint, cross-faded */
  s += rect('mPill', `fill="none" stroke="url(#${I}pe)"`)
  /* names: centred in their column, the version after the name when the pill holds it; muted and bold layers cross-fade */
  const ver = L.pill.w >= TW_PILL_UNIT + 12
  for (let i = 0; i < 4; i++) {
    const nb = n('opNB' + i), nbA = OA('opNB' + i)
    const base = `text-anchor="middle" y="4.4" font-size="12.5" letter-spacing="-.06"`
    s += `<g transform="translate(${F(v('nT' + i))})">${t('nT' + i, 'translate')}` +
      (nb !== 1 || nbA ? nameText(`${base} fill="${T.segMuted}" opacity="${r2(1 - nb)}"`, a('opNB' + i, 'opacity', x => [1 - g(x, 0)]), i, ver, T.muted) : '') +
      (nb !== 0 || nbA ? nameText(`${base} font-weight="600" fill="${T.text}" ${O('opNB' + i)}`, nbA, i, ver, T.muted) : '') +
      `</g>`
  }
  /* the mode control, on the model's grid */
  const oY = ROW.mode - L.pill.h / 2
  s += well(L, T, ROW.mode)
  if (st.rec.mode !== st.mode || a('oPill', 'x')) s += hint(L, T, st.rec.mode, ROW.mode)
  const oRect = (extra: string): string =>
    `<rect x="${r2(n('oPill'))}" y="${oY}" width="${r2(L.pill.w)}" height="${L.pill.h}" rx="${L.pill.rx}" ${extra}>${a('oPill', 'x')}</rect>`
  s += oRect(`fill="${T.pill}" filter="url(#${I}ps)"`)
  s += oRect(`fill="none" stroke="url(#${I}pe)"`)
  for (let i = 0; i < 4; i++) {
    /* icon + name, centred; muted and selected layers cross-fade (the selected one in the text colour) */
    const m = MODES[i] ?? 'auto', x0 = r2(-modeUnit(i) / 2), tx = r2(x0 + MODE_ICON_SIZE + MODE_GAP), ob = n('opOB' + i), obA = OA('opOB' + i)
    const iy = ROW.mode - MODE_ICON_SIZE / 2, ty = ROW.mode + 4.2
    const muted = ob !== 1 || obA
      ? `<g opacity="${r2(1 - ob)}">${a('opOB' + i, 'opacity', x => [1 - g(x, 0)])}${modeIcon(m, T.segMuted, { x: x0, y: iy })}<text x="${tx}" y="${ty}" font-size="12" letter-spacing="-.04" fill="${T.segMuted}">${MODE_NAMES[i]}</text></g>`
      : ''
    const bold = ob !== 0 || obA
      ? `<g ${O('opOB' + i)}>${obA}${modeIcon(m, T.text, { x: x0, y: iy })}<text x="${tx}" y="${ty}" font-size="12" font-weight="600" letter-spacing="-.04" fill="${T.text}">${MODE_NAMES[i]}</text></g>`
      : ''
    s += `<g transform="translate(${r2(colCx(L, i))} 0)">${muted}${bold}</g>`
  }
  /* the rail across the column. The fill carries the selected model's tint (overlay layers, cross-faded) */
  const fw = Math.max(0, n('fillW')), ry = ROW.rail - 2, gx = r2(L.grid.x)
  const fillRect = (fill: string, extra = ''): string =>
    `<rect x="${gx}" y="${ry}" width="${r2(fw)}" height="4" rx="2" fill="${fill}" ${extra}>${a('fillW', 'width', x => [Math.max(0, g(x, 0))])}</rect>`
  s += `<rect x="${gx}" y="${ry}" width="${r2(L.grid.w)}" height="4" rx="2" fill="${T.slTrack}"/>`
  s += fillRect(T.slFill)
  for (let i = 0; i < 4; i++) s += lay('opPT' + i, fillRect(TINT[i] ?? T.slFill, `fill-opacity="${TINT_FILL}"`))
  for (let i = 0; i < 5; i++) s += lay('opTA' + i, `<rect x="${r2(tickX(L, i) - 2)}" y="${ry}" width="4" height="4" rx="2" fill="${T.tick}"/>`)
  /* the recommended level: a faint ring around its tick (the knob covers it when they match) */
  if (st.hasRec) s += `<circle class="cc-rec" cx="${r2(tickX(L, st.rec.effort))}" cy="${ROW.rail}" r="4.5" fill="none" stroke="${T.muted}" stroke-opacity="${T.hintOp}" stroke-width="1.2"/>`
  /* knob: a round thumb holding the effort icon, centred on (0,0), on whole pixels.
     The effort word rides under it, rolling on each level change. */
  const k = v('kT').map(x => Math.round(x))
  let words = ''
  for (let i = 0; i < 5; i++) {
    if (n('opW' + i) === 0 && !a('opW' + i, 'opacity')) continue
    words += `<g transform="translate(0 ${r2(n('wY' + i))})" opacity="${r2(0.55 * n('opW' + i))}">${t('wY' + i, 'translate', x => [0, g(x, 0)])}${a('opW' + i, 'opacity', x => [0.55 * g(x, 0)])}<text y="${WORD_DY}" text-anchor="middle" font-size="10" font-weight="500" fill="${T.muted}">${EFF[i]}</text></g>`
  }
  s += `<g transform="translate(${F(k)})">${P.px('kT')}${words}<g>${thumb(I, T)}${P.icon}</g></g>`
  return s
}

/** The knob's thumb: the pill material (fill, soft drop shadow, top-edge light). Uses the content defs `ps` and `pe`. */
function thumb(I: string, T: Tokens): string {
  return `<circle r="${KNOB_R}" fill="${T.pill}" filter="url(#${I}ps)"/><circle r="${KNOB_R - 0.5}" fill="none" stroke="url(#${I}pe)"/>`
}

/**
 * The knob alone at rest (thumb + icon) as a standalone SVG `px` pixels wide
 * (viewBox 32 x 32 centred on the knob). For previews (the playground grid).
 */
export function renderKnob(icon: EffortIconKind, level: number, model: Family, theme: Theme, idPrefix = 'q_', px = 32): string {
  const I = idPrefix.replace(/[^A-Za-z0-9_]/g, '_') || 'q_'
  const T = THEMES[theme]
  const defs = `<defs><filter id="${I}ps" x="-30%" y="-50%" width="160%" height="220%"><feDropShadow dx="0" dy="1" stdDeviation="1.1" flood-color="#000" flood-opacity="${T.pillSh}"/></filter>` +
    `<linearGradient id="${I}pe" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${T.pillEdge}" stop-opacity="${T.pillEdgeOp}"/><stop offset=".55" stop-color="${T.pillEdge}" stop-opacity="0"/></linearGradient></defs>`
  const ic = iconMarkup({ kind: icon, level: levelOf(level), model, change: null, reaction: null, now: 0, reduced: true, theme, idPrefix: I + 'i' })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="-16 -16 32 32">${defs}${thumb(I, T)}${ic}</svg>`
}

function ariaLabel(st: St, task: string): string {
  const say = (m: number, e: number, o: number): string => `${MODELS[m]} ${VER[m]}, ${EFF[e]} effort, ${MODE_NAMES[o]} mode`
  const L = Math.round(st.effort), R = st.rec
  if (!st.hasRec) return `Session: ${say(st.model, L, st.mode)}.`
  const same = st.model === R.model && L === R.effort && st.mode === R.mode
  return `Next step: ${task}. ${say(st.model, L, st.mode)}. ${same ? 'As recommended' : `Recommended: ${say(R.model, R.effort, R.mode)}`}.`
}

// ───────────────────────────── render ─────────────────────────────

/** The root: laid out at its own size (the viewBox is the frame, 1 unit = 1 CSS px, nothing scales). */
const svgRoot = (W: number, H: number, alt: string, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" role="img" aria-label="${esc(alt)}" style="display:block">${body}</svg>`

/** Hidden: a slim full-width handle with an up chevron in its middle; the zone `show` (all of it) brings the bar back. */
function renderHandle(T: Tokens, st: St): { svg: string; width: number; height: number; alt: string } {
  const W = st.L.W, h = SURF.hidden, y = PAD_Y, cx = r2(W / 2), cy = y + h / 2
  const alt = `Crab card hidden (${MODELS[st.model]} ${VER[st.model]}, ${EFF[Math.round(st.effort)]} effort, ${MODE_NAMES[st.mode]} mode): press to show it.`
  const body = `<rect x="0" y="${y}" width="${W}" height="${h}" rx="${h / 2}" fill="${T.surface}" fill-opacity="${T.sOp}"/>` +
    `<rect x=".5" y="${y + 0.5}" width="${W - 1}" height="${h - 1}" rx="${(h - 1) / 2}" fill="none" stroke="${T.rim}" stroke-opacity="${T.rimOp}"/>` +
    `<path class="cc-show" d="M${r2(cx - 4)} ${cy + 2}L${cx} ${cy - 2}L${r2(cx + 4)} ${cy + 2}" fill="none" stroke="${T.muted}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`
  return { svg: svgRoot(W, LOOK_H.hidden, alt, body), width: W, height: LOOK_H.hidden, alt }
}

/**
 * The whole card as one SVG string for the Svg element (`source`), plus the frame
 * size to give it (CSS px). While `anim` is in flight at `now` the card is drawn at
 * `anim.at` (fixed SMIL begins: a redraw returns the same string); once it ended,
 * the view alone (no SMIL). The card is laid out at `view.width` (`width`, when
 * given, stands in for it); the frame height is fixed per look (LOOK_H).
 */
export function renderCard(viewIn: CardView, animIn: AnimState, now: number, theme: Theme, reduced: boolean, idPrefix = 'k_', width?: number): { svg: string; width: number; height: number; alt: string } {
  const view = width === undefined ? viewIn : { ...viewIn, width }
  const anim = norm(animIn)
  /* per-card id prefix, so cards inlined into one document never share ids */
  const ID = idPrefix.replace(/[^A-Za-z0-9_]/g, '_') || 'k_'
  const T = THEMES[theme]
  const st = toSt(view, anim.wdir)
  if (view.hidden) return renderHandle(T, st)
  const task = view.hasRec === false ? '' : clampTask(view.step.task)
  const tg = targets(st)
  /* in flight: drawn at the instant the motion started; ended (or reduced): the view alone */
  const end = animEnd(anim)
  const live = !reduced && end !== null && now < end
  const t0 = live ? (anim.at ?? now) : now
  /* a record whose target is no longer the view's is dropped, so fill=freeze never holds a stale value */
  const tracks: Record<string, Track> = {}
  if (live) for (const [k, tr] of Object.entries(anim.tracks)) if (eqv(tr.to, tg[k] ?? tr.to)) tracks[k] = tr
  const P: Ctx = {
    id: ID,
    v: k => tg[k] ?? [0],
    a: (k, attr, fn) => animStr(tracks[k], t0, attr, fn),
    t: (k, type, fn) => animTStr(tracks[k], t0, type, fn),
    px: k => animPxStr(tracks[k], t0),
    T,
    st,
    task,
    icon: iconMarkup(iconViewOf(view, live ? anim.change : null, t0, theme, reduced, ID + 'i', live ? (anim.pet ?? null) : null)),
  }
  const look = lookOf(view)
  const body = material(ID, T, st.L.W, SURF[look]) + `<g clip-path="url(#${ID}cp)">${content(P)}</g>`
  const H = LOOK_H[look]
  const alt = ariaLabel(st, task)
  return { svg: svgRoot(st.L.W, H, alt, body), width: st.L.W, height: H, alt }
}

// ───────────────────────────── hit map ─────────────────────────────

/**
 * Layout rectangles in SVG px of the card at `view.width` (1 unit = 1 CSS px). Mapping A
 * hit-tests pointer positions against `zones` (then `slider`); the hide, chevron and gear
 * targets are CTRL px wide, anchored to the right edge, as high as their row (the pointer
 * arrives in whole cells). The fallback native row sits on the content column.
 */
export function hitMap(view: CardView): HitMap {
  const L = layout(view.width), W = L.W
  const native = { rowLeft: L.grid.x, rowWidth: L.grid.w, rowHeight: 30 }
  const none = { models: [], efforts: [], slider: null, rail: null, modes: [] }
  if (view.hidden) {
    /* the whole strip is the handle */
    const show: Rect = { x: 0, y: 0, w: W, h: LOOK_H.hidden }
    return { card: { x: 0, y: PAD_Y, w: W, h: SURF.hidden }, hide: show, toggle: show, gear: show, crew: show, ...none, zones: [{ id: 'show', ...show }], native }
  }
  /* crew, hide, chevron and gear, side by side at the right edge, as high as the bar or the header row */
  const y = PAD_Y, h = view.collapsed ? SURF.bar : ROW.model - 20 - PAD_Y
  const crew: Rect = { x: L.ctrlLeft, y, w: CTRL, h }
  const hide: Rect = { x: L.ctrlLeft + CTRL, y, w: CTRL, h }
  const toggle: Rect = { x: L.ctrlLeft + 2 * CTRL, y, w: CTRL, h }
  const gear: Rect = { x: L.ctrlLeft + 3 * CTRL, y, w: CTRL, h }
  const top: Zone[] = [{ id: 'crew', ...crew }, { id: 'hide', ...hide }, { id: 'chev', ...toggle }, { id: 'gear', ...gear }]
  if (view.collapsed) {
    const card: Rect = { x: 0, y: PAD_Y, w: W, h: SURF.bar }
    /* the compact rail is a slider band (taps and drags), split into its 5 tick columns */
    const R = BAR_RAIL
    const edge = (i: number): number => (i <= 0 ? BAR_RAIL_X0 : i >= 5 ? BAR_RAIL_X1 : R.x0 + R.step * (i - 0.5))
    const efforts = [0, 1, 2, 3, 4].map(i => ({ x: r2(edge(i)), y, w: r2(edge(i + 1) - edge(i)), h }))
    const slider: Rect = { x: BAR_RAIL_X0, y, w: BAR_RAIL_X1 - BAR_RAIL_X0, h }
    /* the rest of the bar, between the rail and the controls, is one target that opens the card */
    const body: Zone = { id: 'body', x: BAR_RAIL_X1, y, w: L.ctrlLeft - BAR_RAIL_X1, h }
    return { card, hide, toggle, gear, crew, models: [], efforts, slider, rail: { ...R }, modes: [], zones: [...top, body], native }
  }
  /* model and mode: the same columns (x and width), rows 40 high around their wells */
  const col = (i: number, cy: number): Rect => ({ x: r2(L.grid.x + L.colW * i), y: cy - 20, w: r2(L.colW), h: 40 })
  const models = [0, 1, 2, 3].map(i => col(i, ROW.model))
  const modes = [0, 1, 2, 3].map(i => col(i, ROW.mode))
  const railY = ROW.model + 20, railH = ROW.mode - 20 - railY
  /* the 5 tick columns: split halfway between ticks, the outer ones reach the column's edges */
  const edge = (i: number): number => (i <= 0 ? L.grid.x : i >= 5 ? L.grid.x + L.grid.w : tickX(L, i) - L.rail.step / 2)
  const efforts = [0, 1, 2, 3, 4].map(i => ({ x: r2(edge(i)), y: railY, w: r2(edge(i + 1) - edge(i)), h: railH }))
  const zones: Zone[] = [...top, ...models.map((m, i) => ({ id: 'm' + i, ...m })), ...modes.map((m, i) => ({ id: 'o' + i, ...m }))]
  return {
    card: { x: 0, y: PAD_Y, w: W, h: SURF.expanded },
    hide,
    toggle,
    gear,
    crew,
    models,
    efforts,
    slider: { x: L.grid.x, y: railY, w: L.grid.w, h: railH },
    rail: { ...L.rail },
    modes,
    zones,
    native,
  }
}

/**
 * Mapping A: which zone a point (SVG px) falls in. Returns the zone ids
 * ('crew' | 'hide' | 'chev' | 'gear' | 'body' | 'show' | 'm0'..'m3' | 'slider' | 'o0'..'o3'), or null.
 */
export function zoneAt(view: CardView, x: number, y: number): string | null {
  const h = hitMap(view)
  const inR = (r: Rect): boolean => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
  for (const z of h.zones) if (inR(z)) return z.id
  if (h.slider && inR(h.slider)) return 'slider'
  return null
}
