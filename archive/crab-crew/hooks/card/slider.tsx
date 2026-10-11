/**
 * Interaction mapping A (spec §9, "Direto"): a transparent Client region over the
 * whole docked card's Svg (expanded, bar or the hidden handle). The default; the
 * compact native row ("Botões", mapping B) is the fallback.
 *
 * Since 0.7.0 the region is IN FLOW, sized explicitly in cells by the hooks module,
 * and the Svg is an absolute layer drawn before it (register.tsx, the AbovePrompt
 * hook): a Client inside a `position: "absolute"` Box never received the pointer
 * (BoxProps.position: "the pointer on it is on its parent").
 *
 * Runs on the drawing thread with no `$`. It turns pointer cells into SVG px
 * (the region's own measured cells over the drawing's layout size, so it lines
 * up whatever the surface's cell metric),
 * tracks the effort drag 1:1 (with a grab offset when the knob itself was
 * grabbed), measures the release velocity, projects it, and posts to the hooks
 * module:
 *
 *   { kind: 'effort-drag', x, phase: 'down' | 'move', velocity }
 *   { kind: 'effort-commit', level, x, velocity, via: 'drag' | 'tap' | 'key' }
 *   { kind: 'zone', id, phase: 'down', at: [col, row] }
 *   { kind: 'zone', id, phase: 'up', inside }
 *   { kind: 'measure', cellPx, columns }
 *   { kind: 'miss', at: [col, row], px: [x, y] }      a press on no zone (for the diag log)
 *   { kind: 'hover', id: 'effort' }                    the pointer came over the effort rail (once per entry)
 *   { kind: 'layout', columns, rows }                  the region as laid out (once per size, `report` only)
 *   { kind: 'batch', items: [...] }                    several of the above queued in one frame, in order
 *
 * `x` is the knob centre in SVG px, clamped to the rail. `velocity` is px/s.
 * Hover: only the effort rail reacts (the pet plays once); it posts once when the
 * pointer comes over the rail band and again only after it left it. Nothing else
 * draws hover feedback (each would redraw the Svg).
 * Zones (hide, chevron, gear, models, modes, the collapsed bar, the handle) are passed in by
 * the hooks module (svg.ts hitMap), in the drawing's own px (the card is laid out at the
 * band's width, `svgWidth`); the effort band is `slider`.
 *
 * Measure: the engine gives the hooks module the band in cells, not px. The region lies
 * exactly over the Svg (svgWidth px), so its own column count measures the desktop's
 * cell: when it disagrees with svgWidth / measure.cellPx by more than MEASURE_SLACK
 * columns, it posts the cell it sees, once per (width, band, columns). The hooks module
 * redraws at the new width only for a change of 8 px or more, so it settles in one step.
 *
 * Client rules kept: listeners and the frame timer start once (while `state`
 * is undefined); `setState` is called only there; at most one post per frame
 * (a queue drained by the frame clock, consecutive drag moves coalesced).
 * Time is the frame clock's (16 ms ticks), so the module stays deterministic.
 *
 * The gesture math is exported as pure functions for the tests.
 */
import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface, JsonValue } from 'claude-code'

// ---------------------------------------------------------------------------
// Geometry (SVG px; defaults = the expanded card, svg.ts hitMap)

export type Rect = { x: number; y: number; w: number; h: number }
export type Zone = Rect & { id: string }
export type Rail = { x0: number; step: number; count: number }

export type Geometry = {
  /** The level the card shows now (0 low .. 4 max). */
  level: number
  svgWidth: number
  svgHeight: number
  /** Px per cell when the region has not been laid out yet (demo: 8×16). */
  cellW: number
  cellH: number
  /** The effort band; null when there is no slider (collapsed card). */
  slider: Rect | null
  rail: Rail
  zones: Zone[]
  /** Cells to draw when the Client element is not given a size. */
  columns: number | null
  rows: number | null
  /** Opaque data from the hooks module, echoed on every post as `tag` (which card, which footer). */
  tag: JsonValue | null
  /** The band's columns and the cell (px) the hooks module computed svgWidth from; null: never measure. */
  measure: { cols: number; cellPx: number } | null
  /**
   * Px per row when the region is sized in whole rows over a shorter drawing (the hooks module gives the
   * region `askRows` = ceil(svgHeight / cellH) rows): while the region is laid out at the rows asked, rows
   * map at this height from the top; laid out at any other count (the surface did not take the size), the
   * region is taken to span the drawing and rows map proportionally, as before 0.7.0. null: proportional.
   */
  rowPx: number | null
  /** The rows the hooks module sized the region to (see rowPx); null: not sized. */
  askRows: number | null
  /** Post `layout` (the region's columns and rows) once per laid-out size, for the diag log. */
  report: boolean
}

export const RAIL: Rail = { x0: 43, step: 118.5, count: 5 }
export const SLIDER_BAND: Rect = { x: 30, y: 86, w: 500, h: 50 }
/** Grabbing within this many px of the knob's centre keeps the grab offset. */
export const GRAB_RADIUS = 16
/** Pointer travel above this is a drag (projection + bounce), else a tap. */
export const TAP_SLOP = 4
/** Release velocity is measured over the last this-many ms of samples. */
export const VELOCITY_WINDOW = 80
/** Apple's deceleration rate for momentum projection. */
export const DECELERATION = 0.99
export const FRAME_MS = 16

const num = (v: JsonValue | undefined, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const obj = (v: JsonValue | undefined): { readonly [key: string]: JsonValue } | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as { readonly [key: string]: JsonValue }) : null

function readRect(v: JsonValue | undefined): Rect | null {
  const o = obj(v)
  if (!o) return null
  const { x, y, w, h } = o
  if (typeof x !== 'number' || typeof y !== 'number' || typeof w !== 'number' || typeof h !== 'number') return null
  return { x, y, w, h }
}

/** Reads the Client's props tolerantly; anything missing takes the spec value. */
export function readGeometry(raw: JsonValue): Geometry {
  const p = obj(raw) ?? {}
  const railRaw = obj(p.rail)
  const rail: Rail = {
    x0: num(railRaw?.x0, RAIL.x0),
    step: Math.max(1, num(railRaw?.step, RAIL.step)),
    count: Math.max(1, Math.round(num(railRaw?.count, RAIL.count))),
  }
  const zones: Zone[] = []
  if (Array.isArray(p.zones)) {
    for (const z of p.zones as readonly JsonValue[]) {
      const r = readRect(z)
      const id = obj(z)?.id
      if (r && typeof id === 'string') zones.push({ id, ...r })
    }
  }
  const sliderRaw = p.slider
  const cols = p.columns
  const rows = p.rows
  const m = obj(p.measure)
  const mCols = num(m?.cols, 0), mCell = num(m?.cellPx, 0)
  return {
    level: clampLevel(num(p.level, 2), rail),
    svgWidth: num(p.svgWidth, 560),
    svgHeight: num(p.svgHeight, 208),
    cellW: num(p.cellW, 8),
    cellH: num(p.cellH, 16),
    slider: sliderRaw === null ? null : readRect(sliderRaw) ?? SLIDER_BAND,
    rail,
    zones,
    columns: typeof cols === 'number' && cols > 0 ? cols : null,
    rows: typeof rows === 'number' && rows > 0 ? rows : null,
    tag: p.tag ?? null,
    measure: mCols > 0 && mCell > 0 ? { cols: mCols, cellPx: mCell } : null,
    rowPx: typeof p.rowPx === 'number' && p.rowPx > 0 ? p.rowPx : null,
    askRows: typeof p.askRows === 'number' && p.askRows > 0 ? p.askRows : null,
    report: p.report === true,
  }
}

/** Columns of disagreement the region tolerates before it reports the cell it measures (one is rounding). */
export const MEASURE_SLACK = 2

/**
 * The cell the region measures over the drawn Svg, when its `columns` disagree with the width the hooks
 * module drew (svgWidth / measure.cellPx) by more than MEASURE_SLACK; null when they agree, before the
 * first layout, or when the hooks module asked for no measure.
 */
export function measureMessage(g: Geometry, columns: number): MeasureMessage | null {
  if (!g.measure || !(columns > 0) || !(g.svgWidth > 0)) return null
  const expected = g.svgWidth / g.measure.cellPx
  if (Math.abs(columns - expected) <= MEASURE_SLACK) return null
  return { kind: 'measure', cellPx: Math.round((g.svgWidth / columns) * 100) / 100, columns }
}

// ---------------------------------------------------------------------------
// Pure gesture math

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export const clampLevel = (level: number, rail: Rail = RAIL): number =>
  clamp(Math.round(level), 0, rail.count - 1)

/** The knob centre for a level. */
export const tickX = (level: number, rail: Rail = RAIL): number => rail.x0 + rail.step * level

/** Keeps a knob x on the rail, first tick to last. */
export const clampToRail = (x: number, rail: Rail = RAIL): number =>
  clamp(x, rail.x0, tickX(rail.count - 1, rail))

/** The nearest level to a knob x. */
export const levelFromX = (x: number, rail: Rail = RAIL): number => clampLevel((x - rail.x0) / rail.step, rail)

/**
 * Px per cell. The hooks module lays the region exactly over the drawn Svg and
 * passes no `columns`/`rows`: the measured region maps onto the layout size
 * (svgWidth x svgHeight), whatever the surface's cell metric; before the first
 * layout, the fallback cell size. Given `columns`/`rows` (a fixed-size region)
 * win over the measure.
 */
export function pxPerCell(g: Geometry, columns: number, rows: number): { w: number; h: number } {
  return {
    w: g.columns ? g.svgWidth / g.columns : columns > 0 ? g.svgWidth / columns : g.cellW,
    h:
      g.rowPx !== null && (g.askRows === null || rows <= 0 || rows === g.askRows)
        ? g.rowPx
        : g.rows
          ? g.svgHeight / g.rows
          : rows > 0
            ? g.svgHeight / rows
            : g.cellH,
  }
}

/** Below this span of samples (ms) a coarse (cell-only) release carries no velocity: a one-cell wobble is not a flick. */
export const MIN_COARSE_SPAN = 32

/** A pointer event's position in SVG px: the cell centre, or the sub-cell point when known. */
export function pointerPx(
  e: Pick<ClientPointerEvent, 'x' | 'y' | 'fine'>,
  cell: { w: number; h: number },
): { x: number; y: number } {
  return {
    x: (e.fine?.x ?? e.x + 0.5) * cell.w,
    y: (e.fine?.y ?? e.y + 0.5) * cell.h,
  }
}

export const inside = (r: Rect, x: number, y: number): boolean =>
  x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h

/** The first zone under the point, or null. */
export function zoneAt(zones: readonly Zone[], x: number, y: number): Zone | null {
  for (const z of zones) if (inside(z, x, y)) return z
  return null
}

/**
 * The grab offset at pointerdown: when the knob itself is grabbed (within
 * GRAB_RADIUS of its centre) the knob keeps its distance to the pointer;
 * anywhere else on the band the knob jumps to the point (offset 0).
 */
export const grabOffset = (px: number, knobX: number): number =>
  Math.abs(px - knobX) <= GRAB_RADIUS ? knobX - px : 0

/** Where the knob is drawn for a pointer x during a drag: 1:1 plus the offset, on the rail. */
export const dragX = (px: number, offset: number, rail: Rail = RAIL): number => clampToRail(px + offset, rail)

export type Sample = { t: number; x: number }

/**
 * Release velocity in px/s from the samples of the last VELOCITY_WINDOW ms
 * before `now`. A pointer held still for that long releases at 0.
 */
export function releaseVelocity(samples: readonly Sample[], now: number): number {
  const recent = samples.filter(s => s.t >= now - VELOCITY_WINDOW && s.t <= now)
  const first = recent[0]
  const last = recent[recent.length - 1]
  if (!first || !last || recent.length < 2) return 0
  const dt = last.t - first.t
  if (dt <= 0) return 0
  return ((last.x - first.x) / dt) * 1000
}

/** Apple's momentum projection: px travelled after release at `velocity` px/s. */
export const projection = (velocity: number, deceleration = DECELERATION): number =>
  ((velocity / 1000) * deceleration) / (1 - deceleration)

/** The level a drag settles on: `round(level + proj / step)`, on the rail. */
export const releaseLevel = (x: number, velocity: number, rail: Rail = RAIL): number =>
  clampLevel((x - rail.x0 + projection(velocity)) / rail.step, rail)

/** Arrow keys step one level; Home and End jump to the ends. Null for other keys. */
export function keyLevel(level: number, key: ClientKeyEvent['key'], rail: Rail = RAIL): number | null {
  switch (key) {
    case 'left':
    case 'down':
      return clampLevel(level - 1, rail)
    case 'right':
    case 'up':
      return clampLevel(level + 1, rail)
    case 'home':
      return 0
    case 'end':
      return rail.count - 1
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Messages and the per-frame outbox

export type EffortDragMessage = { kind: 'effort-drag'; x: number; phase: 'down' | 'move'; velocity: number }
export type EffortCommitMessage = {
  kind: 'effort-commit'
  level: number
  x: number
  velocity: number
  via: 'drag' | 'tap' | 'key'
}
export type ZoneMessage = { kind: 'zone'; id: string; phase: 'down'; at?: [number, number] } | { kind: 'zone'; id: string; phase: 'up'; inside: boolean }
/** The desktop's cell width (px) as this region measures it over the drawn Svg. */
export type MeasureMessage = { kind: 'measure'; cellPx: number; columns: number }
/** Diag and hover posts: a press on no zone, the pointer over the effort rail, the region's laid-out size. */
export type MissMessage = { kind: 'miss'; at: [number, number]; px: [number, number] }
export type HoverMessage = { kind: 'hover'; id: 'effort' }
export type LayoutMessage = { kind: 'layout'; columns: number; rows: number }
export type SliderMessage = EffortDragMessage | EffortCommitMessage | ZoneMessage | MeasureMessage | MissMessage | HoverMessage | LayoutMessage

/** Queues a message; a drag move replaces one still waiting at the tail. */
export function enqueue(queue: readonly SliderMessage[], msg: SliderMessage): SliderMessage[] {
  const tail = queue[queue.length - 1]
  if (msg.kind === 'effort-drag' && msg.phase === 'move' && tail?.kind === 'effort-drag' && tail.phase === 'move') {
    return [...queue.slice(0, -1), msg]
  }
  return [...queue, msg]
}

// ---------------------------------------------------------------------------
// The gesture state machine (pure: events in, messages out)

export type Gesture =
  | { kind: 'idle' }
  | { kind: 'drag'; offset: number; downPx: number; travel: number; x: number; samples: Sample[] }
  | { kind: 'zone'; zone: Zone }

export type Step = { gesture: Gesture; level: number; out: SliderMessage[] }

/**
 * One pointer event through the gesture machine. `level` is the level the
 * module last knew (props, or its own last commit); `now` the frame clock.
 */
export function pointerStep(
  gesture: Gesture,
  level: number,
  g: Geometry,
  e: Pick<ClientPointerEvent, 'type' | 'x' | 'y' | 'fine' | 'button'>,
  cell: { w: number; h: number },
  now: number,
): Step {
  const p = pointerPx(e, cell)
  const rail = g.rail

  if (e.type === 'down') {
    if (e.button !== undefined && e.button !== 'left') return { gesture, level, out: [] }
    // the band touches the chips at its edges: discrete zones win, the band is last
    const zone = zoneAt(g.zones, p.x, p.y)
    if (zone) return { gesture: { kind: 'zone', zone }, level, out: [{ kind: 'zone', id: zone.id, phase: 'down' }] }
    if (g.slider && inside(g.slider, p.x, p.y)) {
      const offset = grabOffset(p.x, tickX(level, rail))
      const x = dragX(p.x, offset, rail)
      return {
        gesture: { kind: 'drag', offset, downPx: p.x, travel: 0, x, samples: [{ t: now, x }] },
        level,
        out: [{ kind: 'effort-drag', x, phase: 'down', velocity: 0 }],
      }
    }
    return { gesture: { kind: 'idle' }, level, out: [] }
  }

  if (e.type === 'move' && gesture.kind === 'drag') {
    const x = dragX(p.x, gesture.offset, rail)
    const samples = [...gesture.samples.filter(s => s.t >= now - VELOCITY_WINDOW), { t: now, x }]
    const travel = Math.max(gesture.travel, Math.abs(p.x - gesture.downPx))
    const velocity = releaseVelocity(samples, now)
    const out: SliderMessage[] = x === gesture.x ? [] : [{ kind: 'effort-drag', x, phase: 'move', velocity }]
    return { gesture: { ...gesture, x, travel, samples }, level, out }
  }

  if (e.type === 'up') {
    // gestures start with the left button only, so only its release ends one
    if (e.button !== undefined && e.button !== 'left') return { gesture, level, out: [] }
    if (gesture.kind === 'drag') {
      const x = dragX(p.x, gesture.offset, rail)
      const samples = [...gesture.samples, { t: now, x }]
      const travel = Math.max(gesture.travel, Math.abs(p.x - gesture.downPx))
      // cell-only input moves in whole cells: scale the slop so a one-cell wobble stays a tap
      const slop = e.fine ? TAP_SLOP : Math.max(TAP_SLOP, cell.w * 1.5)
      const isDrag = travel > slop
      const recent = samples.filter(s => s.t >= now - VELOCITY_WINDOW)
      const span = recent.length ? now - (recent[0]?.t ?? now) : 0
      const velocity = isDrag && (e.fine || (recent.length >= 3 && span >= MIN_COARSE_SPAN)) ? releaseVelocity(samples, now) : 0
      const next = isDrag ? releaseLevel(x, velocity, rail) : levelFromX(x, rail)
      return {
        gesture: { kind: 'idle' },
        level: next,
        out: [{ kind: 'effort-commit', level: next, x, velocity, via: isDrag ? 'drag' : 'tap' }],
      }
    }
    if (gesture.kind === 'zone') {
      const z = gesture.zone
      return {
        gesture: { kind: 'idle' },
        level,
        out: [{ kind: 'zone', id: z.id, phase: 'up', inside: inside(z, p.x, p.y) }],
      }
    }
  }

  return { gesture, level, out: [] }
}

// ---------------------------------------------------------------------------
// The Client module

type Instance = {
  geometry: Geometry
  /** The props level last seen, to notice when the hooks module moves it. */
  propsLevel: number
  level: number
  gesture: Gesture
  queue: SliderMessage[]
  now: number
  /** The frame clock reading of the last post, or -1. */
  postedAt: number
  /** What the last measure check saw (width, band, columns): a measure is posted at most once for it. */
  measured: string
  /** The pointer is over the effort rail (a hover was posted for this entry). */
  overRail: boolean
  /** The size last reported (`layout`). */
  reported: string
}

/** Whether a (hover) point is over the effort rail band. */
export const overEffort = (g: Geometry, x: number, y: number): boolean => !!g.slider && inside(g.slider, x, y)

type State = { instance: Instance }

function start(surface: ClientSurface<State>, geometry: Geometry): Instance {
  const inst: Instance = {
    geometry,
    propsLevel: geometry.level,
    level: geometry.level,
    gesture: { kind: 'idle' },
    queue: [],
    now: 0,
    postedAt: -1,
    measured: '',
    overRail: false,
    reported: '',
  }

  // One post per frame, carrying everything queued: one message alone, several as one `batch` (in order). The surface
  // keeps one undelivered post per frame (a later one replaces it), so a press must never wait behind another post.
  const flush = () => {
    if (inst.queue.length === 0 || inst.postedAt === inst.now) return
    const out = inst.queue
    inst.queue = []
    inst.postedAt = inst.now
    const tagged = (m: SliderMessage): JsonValue => (inst.geometry.tag !== null ? { ...m, tag: inst.geometry.tag } : m)
    const first = out[0]
    surface.post(out.length === 1 && first ? tagged(first) : { kind: 'batch', items: out.map(tagged) })
  }

  const emit = (out: readonly SliderMessage[]) => {
    for (const m of out) inst.queue = enqueue(inst.queue, m)
    flush()
  }

  surface.onPointer(e => {
    const cell = pxPerCell(inst.geometry, surface.columns, surface.rows)
    // hover (no button held, no gesture): one post when the pointer comes over the effort rail
    if ((e.type === 'move' && e.button === undefined && inst.gesture.kind === 'idle') || e.type === 'leave') {
      const p = pointerPx(e, cell)
      const over = e.type === 'move' && overEffort(inst.geometry, p.x, p.y)
      if (over && !inst.overRail) emit([{ kind: 'hover', id: 'effort' }])
      inst.overRail = over
      return
    }
    const step = pointerStep(inst.gesture, inst.level, inst.geometry, e, cell, inst.now)
    inst.gesture = step.gesture
    inst.level = step.level
    if (e.type === 'down' && (e.button === undefined || e.button === 'left')) {
      const p = pointerPx(e, cell)
      // a press on nothing still tells the diag log where it landed; a zone press carries its cell
      if (step.out.length === 0) {
        emit([{ kind: 'miss', at: [e.x, e.y], px: [Math.round(p.x), Math.round(p.y)] }])
        return
      }
      emit(step.out.map(m => (m.kind === 'zone' && m.phase === 'down' ? { ...m, at: [e.x, e.y] as [number, number] } : m)))
      return
    }
    emit(step.out)
  })

  surface.onKey(e => {
    if (!inst.geometry.slider) return
    const next = keyLevel(inst.level, e.key, inst.geometry.rail)
    if (next === null || next === inst.level) return
    inst.level = next
    emit([{ kind: 'effort-commit', level: next, x: tickX(next, inst.geometry.rail), velocity: 0, via: 'key' }])
  })

  surface.every(FRAME_MS, () => {
    inst.now += FRAME_MS
    const g = inst.geometry
    // the region as laid out, once per size (the diag log's mount line); only into an empty queue after a quiet frame,
    // so a report never stands in for a press (the surface keeps one undelivered post per frame: a later one replaces it)
    if (g.report && surface.columns > 0 && inst.queue.length === 0 && inst.postedAt < inst.now - FRAME_MS) {
      const size = `${surface.columns}x${surface.rows}`
      if (size !== inst.reported) {
        inst.reported = size
        inst.queue = enqueue(inst.queue, { kind: 'layout', columns: surface.columns, rows: surface.rows })
      }
    }
    // the cell the region sees over the Svg, once per (width, band, columns) and only when it disagrees
    if (g.measure && surface.columns > 0) {
      const key = `${g.svgWidth}|${g.measure.cols}|${g.measure.cellPx}|${surface.columns}`
      if (key !== inst.measured) {
        inst.measured = key
        const m = measureMessage(g, surface.columns)
        if (m) inst.queue = enqueue(inst.queue, m)
      }
    }
    flush()
  })

  return inst
}

const EffortSlider: ClientModule<JsonValue, State> = (props, surface) => {
  const { Box } = surface.elements
  const geometry = readGeometry(props)

  let inst = surface.state?.instance
  if (!inst) {
    inst = start(surface, geometry)
    surface.setState({ instance: inst })
  } else {
    inst.geometry = geometry
    if (geometry.level !== inst.propsLevel) {
      inst.propsLevel = geometry.level
      if (inst.gesture.kind !== 'drag') inst.level = geometry.level
    }
  }

  // Transparent: an empty region the size of the card, nothing drawn in it.
  return Box({ width: geometry.columns ?? '100%', height: geometry.rows ?? '100%' })
}

export default EffortSlider
