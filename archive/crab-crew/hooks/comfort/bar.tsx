import type { ClientKeyEvent, ClientPointerEvent, ClientSurface } from 'claude-code'

import {
  INK,
  LEVELS,
  LEVEL_COLORS,
  PARTIALS,
  MODEL_COLORS,
  MUTED,
  type Action,
  type Region,
  type Seg,
  actionId,
  approach,
  isMoving,
  retarget,
  still,
  tweenValue,
  type Motion,
  cutLeft,
  effortAtX,
  exactRow,
  fitCells,
  graphemes,
  hitAt,
  levelIndex,
  mix,
  place,
  segWidth,
} from './look'

/** One usage reading: context, the 5-hour and weekly windows, or the session's cost off a subscription. */
export type Usage = { key: 'ctx' | '5h' | 'wk' | 'cost'; percent: number | null; reset: string; usd?: number }

export type BarProps = {
  isOpen: boolean
  /** The current model's alias, and every model on offer with its label (`opus 5.5`). */
  model: string
  models: { alias: string; label: string }[]
  effort: string
  ultra: boolean
  /** One useful line for the gap in the middle: a warning (amber) or a fact (dim). */
  message: { text: string; tone: 'warn' | 'dim' } | null
  /** Opened from cc: the row offers the way back to the card. */
  canBack: boolean
  /** A settings mark (≡) at the row's left end opens the mod's settings pane. */
  canSettings?: boolean
  /** The agents at work, each with its crab (name '' while its egg waits for a design). */
  crew?: readonly CrewProp[]
  /** The host's time when these props were made, so the crabs' timers survive a remount. */
  now?: number
}

export type CrewProp = {
  id: string
  label: string
  status: 'egg' | 'running' | 'done' | 'failed'
  durationMs: number
  name: string
  color: string
  accessory: string
  /** When its agent started and ended, on the host's clock (0 until it ends). */
  startedAt: number
  endedAt: number
}

type Row = 'model' | 'effort' | 'ultra'
type Mode = 'labels' | 'names' | 'compact' | 'tight'
const ROWS: readonly Row[] = ['model', 'effort', 'ultra']

type Ref = {
  props: BarProps
  open: number
  openM: Motion
  fillM: Motion
  clock: number
  hover: string
  focus: Row
  pending: { model: string; effort: string; since: number }
  changed: { id: string; at: number }
  isDragging: boolean
  regions: Region[]
  /** The model highlight: its two edges glide on their own, and where it started, for the colour blend. */
  pill: Pill
  /** The effort meter's fill, in cells (0..15), gliding toward the level's own cells. */
  fill: number
  /** Ultra as clicked, until the mod confirms it, and when it last changed (for the spark). */
  ultraPending: { value: boolean; since: number } | null
  /** Open or closed as clicked, until the mod confirms it: the row starts moving on the click itself. */
  openPending: { value: boolean; since: number } | null
  ultraAt: number
  /** Choices shown already, posted to the mod once their motion ends (the engine's work never lands mid-slide). */
  outbox: { model: Action | null; effort: Action | null; at: number }
  /** What the band has seen of each crab: when it came, hatched and finished (on this clock). */
  crewSeen: Record<string, { namedAt: number; status: string }>
  /** The host's time and this band's clock at the moment the props last brought it. */
  hostAt: { host: number; clock: number }
  /** The crew's animation step last drawn (legs, seconds, hatch and fade), so it redraws only on a change. */
  crewStep: string
  /** The open row's look for the current width (see fitFor), and that choice cached per width. */
  mode: Mode
  fit: { key: string; mode: Mode; back: boolean }
}

type Pill = { x0: number; x1: number; mx0: Motion; mx1: Motion; color: string; alias: string; from: { x0: number; x1: number; color: string } }
type Span = { alias: string; text: string; color: string; x0: number; x1: number }
type State = { ref: Ref; frame: number }

const FRAME_MS = 16
const SLIDE_MS = 140   // plus SLIDE_PER_CELL for each cell travelled, up to SLIDE_MAX
const SLIDE_PER_CELL = 10
const SLIDE_MAX = 260
const OPEN_MS = 220
const CLOSE_MS = 160
const FILL_MS = 260
const CHARGE_MS = 150
const PENDING_MS = 4000
const GLOW_MS = 180
const BG = '#0C0C0C'
const TEXT = '#E8E4DE'
const RULE = '#52525B'
const EMPTY = '#3F3F46'
const AMBER = '#F59E0B'
const GEM = '#A78BFA'   // amethyst: the crystal when ultra is on
const SEP = '  │  '

const METER = 15
const PER_LEVEL = 3
/** The cells a level fills: low 3 … max 15. */
const fillCells = (level: string): number => PER_LEVEL * Math.max(1, levelIndex(level) + 1)
const shownModel = (r: Ref): string => r.pending.model || r.props.model
const shownEffort = (r: Ref): string => r.pending.effort || r.props.effort
const shownUltra = (r: Ref): boolean => (r.ultraPending !== null ? r.ultraPending.value : r.props.ultra)
const shownOpen = (r: Ref): boolean => (r.openPending !== null ? r.openPending.value : r.props.isOpen)

/** Opens or closes the row at once and tells the mod (which flips its own state). */
function setOpen(surface: ClientSurface<State>, r: Ref, want: boolean) {
  if (want === shownOpen(r)) {
    return
  }
  r.openPending = { value: want, since: r.clock }
  surface.post({ kind: 'toggle' })
  redraw(surface)
}

function redraw(surface: ClientSurface<State>) {
  const state = surface.state
  if (state !== undefined) {
    surface.setState({ ref: state.ref, frame: state.frame + 1 })
  }
}

// Sends the action to the mod and shows it straight away (without waiting for the reply).
function act(surface: ClientSurface<State>, r: Ref, action: Action) {
  if (action.kind === 'model') {
    if (action.value === shownModel(r)) {
      return
    }
    r.pending = { ...r.pending, model: action.value, since: r.clock }
  }
  if (action.kind === 'effort') {
    if (action.value === shownEffort(r)) {
      return
    }
    r.pending = { ...r.pending, effort: action.value, since: r.clock }
  }
  if (action.kind === 'open') {
    r.focus = action.value as Row
    if (shownOpen(r)) {
      redraw(surface)
      return
    }
    setOpen(surface, r, true)
    return
  }
  if (action.kind === 'toggle') {
    setOpen(surface, r, !shownOpen(r))
    return
  }
  if (action.kind === 'ultra') {
    r.ultraPending = { value: !shownUltra(r), since: r.clock }
    r.ultraAt = r.clock
  }
  r.changed = { id: actionId(action), at: r.clock }
  if (action.kind === 'model' || action.kind === 'effort') {
    // shown now, sent when the slide or the fill has ended; rapid clicks send only the last one
    r.outbox[action.kind] = action
    r.outbox.at = r.clock + (action.kind === 'model' ? SLIDE_MAX : FILL_MS)
  } else {
    surface.post(action)
  }
  redraw(surface)
}

function flush(surface: ClientSurface<State>, r: Ref) {
  for (const kind of ['model', 'effort'] as const) {
    const action = r.outbox[kind]
    if (action !== null) {
      r.outbox[kind] = null
      surface.post(action)
    }
  }
}

function tick(surface: ClientSurface<State>) {
  const state = surface.state
  if (state === undefined) {
    return
  }
  const r = state.ref
  const p = r.props
  r.clock += FRAME_MS
  let isChanged = false

  if (r.pending.since > 0) {
    const isSettled =
      (r.pending.model === '' || r.pending.model === p.model) && (r.pending.effort === '' || r.pending.effort === p.effort)
    if (isSettled || r.clock - Math.max(r.pending.since, r.outbox.at) > PENDING_MS) {
      r.pending = { model: '', effort: '', since: 0 }
      isChanged = true
    }
  }
  // the panel unrolls (opening eases out, closing eases in and out)
  if (r.openPending !== null && (r.openPending.value === p.isOpen || r.clock - r.openPending.since > PENDING_MS)) {
    r.openPending = null
    isChanged = true
  }
  const isOpen = shownOpen(r)
  r.openM = retarget(r.openM, isOpen ? 1 : 0, r.clock, isOpen ? OPEN_MS : CLOSE_MS, isOpen ? 'out' : 'inout')
  const open = tweenValue(r.openM, r.clock)
  if (open !== r.open) {
    r.open = open
    isChanged = true
  }
  if (r.changed.id !== '' && r.clock - r.changed.at < GLOW_MS + FRAME_MS) {
    isChanged = true
  }
  if (r.ultraPending !== null && (r.ultraPending.value === p.ultra || r.clock - r.ultraPending.since > PENDING_MS)) {
    r.ultraPending = null
    isChanged = true
  }
  if (r.ultraAt >= 0 && r.clock - r.ultraAt < CHARGE_MS + FRAME_MS) {
    isChanged = true
  }
  if (glidePills(r)) {
    isChanged = true
  }
  if (crewTick(r)) {
    isChanged = true
  }
  if ((r.outbox.model !== null || r.outbox.effort !== null) && r.clock >= r.outbox.at) {
    flush(surface, r)
  }
  if (isChanged) {
    redraw(surface)
  }
}

// A pill slides as one solid block to the chosen option: both edges move at one rate, so it keeps its width
// and eases into place; its colour blends from the old option's to the new one's on the way.
function glide(pill: Pill, spans: readonly Span[] | null, chosen: string, target: string, now: number): boolean {
  if (spans === null) {
    // one option at a time (the stepper): no travel, the pill simply takes the option's colour
    const isChanged = pill.alias !== chosen || pill.color !== target
    Object.assign(pill, { alias: chosen, color: target })
    return isChanged
  }
  const span = spans.find(s => s.alias === chosen)
  if (span === undefined) {
    return false
  }
  if (pill.x0 < 0) {
    Object.assign(pill, { x0: span.x0, x1: span.x1, mx0: still(span.x0), mx1: still(span.x1), color: target, alias: chosen })
    return true
  }
  if (pill.alias !== chosen) {
    pill.from = { x0: pill.x0, x1: pill.x1, color: pill.color }
    pill.alias = chosen
  }
  if (pill.x0 === span.x0 && pill.x1 === span.x1 && pill.color === target) {
    return false
  }
  // a solid slide, on the clock: both edges ease out together, so the pill keeps its width and moves on the
  // very first frame (an ease-in start reads as lag); a longer hop takes a little longer, at a calm pace
  const ms = Math.min(SLIDE_MAX, SLIDE_MS + SLIDE_PER_CELL * Math.abs(pill.x0 - span.x0))
  pill.mx0 = retarget(pill.mx0, span.x0, now, ms)
  pill.mx1 = retarget(pill.mx1, span.x1, now, ms)
  pill.x0 = tweenValue(pill.mx0, now)
  pill.x1 = tweenValue(pill.mx1, now)
  const total = Math.abs(pill.from.x0 - span.x0)
  const left = Math.abs(pill.x0 - span.x0)
  pill.color = total === 0 || left === 0 ? target : mix(pill.from.color, target, 1 - left / total)
  return true
}

function glidePills(r: Ref): boolean {
  const laidOut = r.mode === 'labels' || r.mode === 'names'
  const model = shownModel(r)
  const level = shownEffort(r)
  const a = glide(r.pill, laidOut ? modelSpans(r, r.mode) : null, model, MODEL_COLORS[model] ?? MUTED, r.clock)
  // the meter fills fluidly toward the level's cells, on the clock
  r.fillM = retarget(r.fillM, fillCells(level), r.clock, FILL_MS)
  const fill = tweenValue(r.fillM, r.clock)
  const b = fill !== r.fill
  r.fill = fill
  return a || b
}

function pointer(surface: ClientSurface<State>, e: ClientPointerEvent) {
  const r = surface.state?.ref
  if (r === undefined) {
    return
  }
  const hit = hitAt(r.regions, e.x, e.y)
  if (e.type === 'up') {
    r.isDragging = false
    return
  }
  if (e.type === 'down' && e.button === 'left' && hit !== undefined) {
    r.isDragging = hit.action.kind === 'effort'
    if (hit.action.kind === 'model' || hit.action.kind === 'effort' || hit.action.kind === 'ultra') {
      r.focus = hit.action.kind
    }
    act(surface, r, hit.action)
    return
  }
  if (e.type === 'move' && r.isDragging && e.button === 'left') {
    const value = effortAtX(r.regions, e.x)
    if (value !== undefined) {
      act(surface, r, { kind: 'effort', value })
    }
    return
  }
  const hover = e.type === 'leave' ? '' : (hit?.id ?? '')
  if (hover !== r.hover) {
    r.hover = hover
    redraw(surface)
  }
}

// Like /effort, made easy: Tab moves between the rows, ←/→ change the focused one, Enter toggles ultra, Esc closes.
function key(surface: ClientSurface<State>, e: ClientKeyEvent) {
  const r = surface.state?.ref
  if (r === undefined) {
    return
  }
  const step = (list: readonly string[], now: string, by: number) =>
    list[Math.min(list.length - 1, Math.max(0, list.indexOf(now) + by))] ?? now
  if (e.key === 'tab') {
    const at = ROWS.indexOf(r.focus)
    r.focus = ROWS[(at + (e.shift === true ? ROWS.length - 1 : 1)) % ROWS.length] ?? 'model'
    if (!shownOpen(r)) {
      setOpen(surface, r, true)
    }
    redraw(surface)
    return
  }
  if (e.key === 'escape') {
    setOpen(surface, r, false)
    return
  }
  const by = e.key === 'left' || e.key === 'up' ? -1 : e.key === 'right' || e.key === 'down' ? 1 : 0
  if (by !== 0) {
    if (r.focus === 'model') {
      act(surface, r, { kind: 'model', value: step(r.props.models.map(m => m.alias), shownModel(r), by) })
    } else if (r.focus === 'effort') {
      act(surface, r, { kind: 'effort', value: step(LEVELS, shownEffort(r), by) })
    } else if ((by > 0) !== shownUltra(r)) {
      act(surface, r, { kind: 'ultra' })
    }
    return
  }
  if (e.key === 'return') {
    act(surface, r, r.focus === 'ultra' ? { kind: 'ultra' } : { kind: 'toggle' })
  }
}

// ── pieces shared by the row and the panel ──
const glow = (r: Ref, id: string): number =>
  r.changed.id === id ? Math.min(1, (r.clock - r.changed.at) / GLOW_MS) : 1
const labelOf = (r: Ref, alias: string): string => r.props.models.find(m => m.alias === alias)?.label ?? alias

// ── the pieces of the open row ──
const centre = (text: string, w: number): string => {
  const room = Math.max(0, w - segWidth([{ text }]))
  return ' '.repeat(Math.floor(room / 2)) + text + ' '.repeat(Math.ceil(room / 2))
}

/** Options laid out in a row, 2 cells apart, each ` text ` from x = 1; a pill covers [x0, x1). */
function spansFor(options: readonly { alias: string; text: string; color: string }[]): Span[] {
  const spans: Span[] = []
  let x = 1
  options.forEach((o, at) => {
    if (at > 0) {
      x += 2
    }
    const text = ` ${o.text} `
    const w = segWidth([{ text }])
    spans.push({ alias: o.alias, text, color: o.color, x0: x, x1: x + w })
    x += w
  })
  return spans
}

/**
 * Versions show only when every model's is known (Claude Code often knows just the current one's): otherwise
 * the names alone, so the row never changes shape when the current model changes.
 */
function modelTexts(r: Ref, mode: Mode): { alias: string; text: string; color: string }[] {
  const useLabels = mode === 'labels' && r.props.models.every(m => m.label !== m.alias)
  return r.props.models.map(m => ({ alias: m.alias, text: useLabels ? m.label : m.alias, color: MODEL_COLORS[m.alias] ?? MUTED }))
}

// The texts never depend on which model is current, so neither do the places: a change of model is a slide.
function modelSpans(r: Ref, mode: Mode): Span[] {
  return spansFor(modelTexts(r, mode))
}


/**
 * A row of options with one pill gliding under the chosen one: every word is a click target, the chosen one
 * sits on a solid block in its own colour with dark ink, the others show their colour dimmed (full on hover).
 */
function pillRow(r: Ref, spans: readonly Span[], pill: Pill, kind: 'model' | 'effort'): Seg[] {
  const end = (spans[spans.length - 1]?.x1 ?? 1) + 1
  const cells: Seg[] = Array.from({ length: end }, () => ({ text: ' ' }))
  const p0 = Math.round(pill.x0)
  const p1 = p0 + Math.max(1, Math.round(pill.x1 - pill.x0))
  for (const s of spans) {
    const action: Action = { kind, value: s.alias }
    const isHover = r.hover === actionId(action)
    ;[...s.text].forEach((ch, i) => {
      const x = s.x0 + i
      const under = x >= p0 && x < p1
      cells[x] = {
        text: ch,
        action,
        bold: under || isHover,
        color: under ? INK : mix(BG, s.color, isHover ? 1 : 0.55),
        bg: under ? pill.color : undefined,
      }
    })
  }
  // the pill is one solid block: while it crosses a gap, the gap cells carry its colour too
  for (let x = Math.max(0, p0); x < Math.min(cells.length, p1); x += 1) {
    if (cells[x]?.bg === undefined) {
      cells[x] = { text: ' ', bg: pill.color }
    }
  }
  return cells
}


/** One option at a time: ‹ and › step through them, the chosen one on its pill. */
function stepper(r: Ref, options: readonly { alias: string; text: string }[], chosen: string, pill: Pill, kind: 'model' | 'effort'): Seg[] {
  const at = Math.max(0, options.findIndex(o => o.alias === chosen))
  const w = Math.max(...options.map(o => segWidth([{ text: o.text }])), 1)
  const prev = options[Math.max(0, at - 1)]?.alias ?? chosen
  const next = options[Math.min(options.length - 1, at + 1)]?.alias ?? chosen
  const arrow = (text: string, value: string, isEdge: boolean): Seg => {
    const action: Action = { kind, value }
    return { text, action, bold: true, color: isEdge ? EMPTY : r.hover === actionId(action) ? TEXT : MUTED }
  }
  const label = options[at]?.text ?? chosen
  return [
    { text: ' ' },
    arrow('‹', prev, at === 0),
    { text: ' ' },
    { text: ` ${centre(label, w)} `, bold: true, color: INK, bg: pill.color },
    { text: ' ' },
    arrow('›', next, at === options.length - 1),
    { text: ' ' },
  ]
}

function modelCells(r: Ref, mode: Mode): Seg[] {
  if (mode === 'labels' || mode === 'names') {
    return pillRow(r, modelSpans(r, mode), r.pill, 'model')
  }
  const options = modelTexts(r, mode === 'compact' ? 'labels' : 'names')   // versions only when all are known
  return stepper(r, options, shownModel(r), r.pill, 'model')
}

/** The colour of the meter at a cell: a gradient through the levels' colours, low's cyan to max's rose. */
function meterColorAt(cell: number, cells: number): string {
  const pos = (cell / Math.max(1, cells - 1)) * (LEVELS.length - 1)
  const at = Math.min(LEVELS.length - 1, Math.floor(pos))
  const next = Math.min(LEVELS.length - 1, at + 1)
  return mix(LEVEL_COLORS[LEVELS[at] ?? 'low'] ?? MUTED, LEVEL_COLORS[LEVELS[next] ?? 'max'] ?? MUTED, pos - at)
}

/**
 * The meter: `cells` wide, filled to `fill` (in these cells) with an eighth-block edge, `░` beyond. Every cell
 * sets the level it belongs to when clicked (and while dragging); a hovered level's empty cells show faintly.
 */
function meterCells(r: Ref, fill: number, cells: number, action: (level: string) => Action): Seg[] {
  const per = cells / LEVELS.length
  const segs: Seg[] = []
  for (let i = 0; i < cells; i += 1) {
    const level = LEVELS[Math.min(LEVELS.length - 1, Math.floor(i / per))] ?? 'max'
    const amount = fill - i
    const own = meterColorAt(i, cells)
    const isHover = r.hover === actionId({ kind: 'effort', value: level })
    if (amount >= 1) {
      segs.push({ text: '█', color: own, action: action(level) })
    } else if (amount > 0) {
      const step = Math.min(PARTIALS.length - 1, Math.floor(amount * (PARTIALS.length + 1)) - 1)
      segs.push({ text: step >= 0 ? (PARTIALS[step] ?? '▏') : '░', color: step >= 0 ? own : EMPTY, action: action(level) })
    } else {
      segs.push({ text: '░', color: isHover ? mix(EMPTY, own, 0.5) : EMPTY, action: action(level) })
    }
  }
  return segs
}

// ── ultra: the crystal ──
// Off: ◇ hollow and dim, no colour. On: ◆ solid, amethyst, bold. Nothing pulses: the gem is either lit or not.
// A toggle crosses in CHARGE_MS: the glyph swaps at once, the colour fades between dim and amethyst.
function crystalLook(r: Ref): { text: string; color?: string; dim?: boolean; bold?: boolean } {
  const on = shownUltra(r)
  const t = r.ultraAt < 0 ? 1 : Math.min(1, (r.clock - r.ultraAt) / CHARGE_MS)
  if (on) {
    return { text: '◆', color: t < 1 ? mix(MUTED, GEM, t) : GEM, bold: true }
  }
  if (t < 1) {
    return { text: '◇', color: mix(GEM, MUTED, t) }
  }
  return r.hover === 'ultra' ? { text: '◇', color: TEXT } : { text: '◇', dim: true }
}

/** The whole ` ◆ ` is the target: 3 cells to click, in the strip and in the closed row. */
function crystalSeg(r: Ref, action: Action): Seg {
  const look = crystalLook(r)
  return { text: ` ${look.text} `, color: look.color, dim: look.dim, bold: look.bold, action }
}

// ── the row: closed it shows the choices; the toggle turns the same row into the picker, in place ──
// closed:                                 ⇠ cc  │  opus 5.5  │  ███░░  high     ◇    ◀
// open:   ⇠ cc  │   fable 5.1    opus 5.5    sonnet 5.5    haiku 4.5   │  █████████░░░░░░  high     ◆    ▶
// Right-anchored: the gem and the toggle never move. Opening morphs each section where it is: the model
// chip becomes the pill and the other names unfold around it; the meter stretches from 5 cells to 15.
// The band is always one row: nothing is repeated, nothing pushes the chat up.
const MODES: readonly Mode[] = ['labels', 'names', 'compact', 'tight']
const SMALL = 5

/** One seg per drawn character, so a window can be cut at any cell. */
const explode = (segs: readonly Seg[]): Seg[] => segs.flatMap(seg => graphemes(seg.text).map(ch => ({ ...seg, text: ch })))

/** The model section at `o` (0 closed … 1 open): a window on the pill row, centred on the pill, widening. */
function modelMorph(r: Ref, o: number, mode: Mode): Seg[] {
  const model = shownModel(r)
  const color = MODEL_COLORS[model] ?? MUTED
  if (o <= 0) {
    return [{ text: labelOf(r, model), bold: true, color: mix(BG, color, 0.35 + 0.65 * glow(r, `model:${model}`)), action: { kind: 'open', value: 'model' } }]
  }
  const full = explode(modelCells(r, mode)).slice(1, -1)   // without the outer blank cells: the separators pad it
  if (o >= 1) {
    return full
  }
  let p0 = full.findIndex(c => c.bg !== undefined)
  let p1 = full.length - [...full].reverse().findIndex(c => c.bg !== undefined)
  if (p0 < 0) {
    p0 = 0
    p1 = full.length
  }
  // the window starts as wide as the closed chip ("haiku 5.5"), so nothing jumps when the morph begins
  const lw = Math.min(full.length, Math.max(1, segWidth([{ text: labelOf(r, model) }]), p1 - p0 - 2))
  const w = Math.min(full.length, Math.round(lw + (full.length - lw) * o))
  const left = Math.max(0, Math.min(full.length - w, Math.round((p0 + p1 - w) / 2)))
  return full.slice(left, left + w).map(c =>
    c.bg !== undefined
      ? { ...c, bg: mix(BG, c.bg, o), color: mix(color, INK, o), bold: true }
      : { ...c, color: mix(BG, c.color ?? TEXT, o) },
  )
}

/** The effort section at `o`: the meter stretches from 5 cells to 15, the fill scaled with it; the word stays. */
function effortMorph(r: Ref, o: number, mode: Mode): Seg[] {
  const level = shownEffort(r)
  const big = mode === 'tight' ? SMALL : METER
  const n = Math.round(SMALL + (big - SMALL) * o)
  const isLive = o >= 0.5
  const act = (value: string): Action => (isLive ? { kind: 'effort', value } : { kind: 'open', value: 'effort' })
  const word: Seg = {
    text: mode === 'tight' ? level : level.padEnd(6),   // tight: no padding to spare
    bold: true,
    color: mix(BG, LEVEL_COLORS[level] ?? MUTED, 0.35 + 0.65 * glow(r, `effort:${level}`)),
  }
  if (!isLive) {
    word.action = { kind: 'open', value: 'effort' }
  }
  return [...meterCells(r, (r.fill * n) / METER, n, act), { text: '  ' }, word]
}

/** The controls at `o`, left to right: the way back to cc, model, effort, the gem, the toggle. */
function controls(r: Ref, o: number, mode: Mode, withBack: boolean): Seg[] {
  const segs: Seg[] = []
  if (withBack) {
    segs.push({ text: '⇠ cc', color: r.hover === 'back' ? TEXT : MUTED, bold: r.hover === 'back', action: { kind: 'back' } })
    segs.push({ text: SEP, color: RULE })
  }
  segs.push(...modelMorph(r, o, mode))
  if (levelIndex(shownEffort(r)) >= 0) {
    segs.push({ text: SEP, color: RULE }, ...effortMorph(r, o, mode))
  }
  segs.push({ text: '  ' }, crystalSeg(r, { kind: 'ultra' }))
  // the toggle points the way the row goes: ◀ unfolds the picker to the left, ▶ folds it back
  const arrow = shownOpen(r) ? '▶' : '◀'
  segs.push({ text: '  ' }, { text: ` ${arrow} `, color: r.hover === 'toggle' ? TEXT : MUTED, bold: true, action: { kind: 'toggle' } })
  return segs
}

/** The fullest open look that fits: the way back to cc goes first, then the models step down. */
function fitFor(r: Ref, width: number): { mode: Mode; back: boolean } {
  const key = `${width}|${r.props.canBack}|${r.props.models.map(m => m.label).join(',')}|${shownEffort(r)}`
  if (r.fit.key === key) {
    return r.fit
  }
  let found: { mode: Mode; back: boolean } = { mode: 'tight', back: false }
  search: for (const mode of MODES) {
    for (const back of r.props.canBack ? [true, false] : [false]) {
      if (segWidth(controls(r, 1, mode, back)) + 1 <= width) {
        found = { mode, back }
        break search
      }
    }
  }
  r.fit = { key, ...found }
  return r.fit
}

/** One line, full width: a message on the left while closed, the controls (or the picker) on the right. */

// ── the crew: agents at work, one quiet line where the message sits ──
//   ⠹ 🔎 scout · find the readme  0:07   🔬 reviewer  0:03          ⇠ cc │ opus 5.5 │ … ◀
// A spinner leads while any agent works; a finished one shows ✓ in green for a moment, then fades out.
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const SPIN_MS = 120
const SIT_MS = 1800
const FADE_MS = 500
const COLOR_MS = 300   // a role designed while it works takes its colour over this long
const GREEN = '#4ADE80'
const ROSE = '#FB7185'

/** The host's time now: the last `now` the props brought, plus how long this band has ticked since. */
const hostNow = (r: Ref): number => r.hostAt.host + (r.clock - r.hostAt.clock)

const isLive = (m: CrewProp): boolean => m.status === 'running' || m.status === 'egg'

/** The crabs still on the line: a finished one leaves once it has shown its ✓ and faded. */
const visibleCrew = (r: Ref): readonly CrewProp[] => {
  const now = hostNow(r)
  return (r.props.crew ?? []).filter(m => !(m.endedAt > 0 && now - m.endedAt > SIT_MS + FADE_MS))
}

/** Keeps when each role got its colour, and says whether the line's picture changed since the last frame. */
function crewTick(r: Ref): boolean {
  const crew = r.props.crew ?? []
  const seen = r.crewSeen
  for (const m of crew) {
    const s = seen[m.id] ?? { namedAt: m.name === '' ? -1 : -2, status: m.status }
    if (s.namedAt === -1 && m.name !== '') {
      s.namedAt = r.clock
    }
    s.status = m.status
    seen[m.id] = s
  }
  for (const id of Object.keys(seen)) {
    if (!crew.some(m => m.id === id)) {
      delete seen[id]
    }
  }
  const now = hostNow(r)
  const visible = visibleCrew(r)
  const spin = visible.some(isLive) ? Math.floor(r.clock / SPIN_MS) % SPIN.length : -1
  const step = visible
    .map(m => {
      const s = seen[m.id]!
      const named = s.namedAt >= 0 && r.clock - s.namedAt < COLOR_MS ? Math.floor((r.clock - s.namedAt) / 50) : -1
      const since = m.endedAt > 0 ? now - m.endedAt : -1
      const fade = since >= 0 ? Math.min(11, Math.max(0, Math.floor((since - SIT_MS) / (FADE_MS / 10)))) : 0
      const secs = isLive(m) ? Math.floor(Math.max(0, now - m.startedAt) / 1000) : 0
      return `${m.id}:${m.status}:${m.name}:${named}:${fade}:${secs}`
    })
    .join('|')
  const key = `${spin}|${step}`
  if (key === r.crewStep) {
    return false
  }
  r.crewStep = key
  return true
}

const clockTime = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** One agent on the line, at a level of detail: 2 the role and the task, 1 the role, 0 the emoji alone. */
function agentSegs(r: Ref, m: CrewProp, detail: number): Seg[] {
  const s = r.crewSeen[m.id]
  const now = hostNow(r)
  const since = m.endedAt > 0 ? now - m.endedAt : -1
  const fade = since >= 0 ? 1 - Math.min(1, Math.max(0, (since - SIT_MS) / FADE_MS)) : 1
  const tone = (color: string) => mix(BG, color, fade)
  const naming = s !== undefined && s.namedAt >= 0 && r.clock - s.namedAt < COLOR_MS ? (r.clock - s.namedAt) / COLOR_MS : 1
  const color = m.name === '' ? MUTED : mix(MUTED, m.color, naming)
  const segs: Seg[] = []
  if (m.accessory !== '' && fade > 0.4) {
    segs.push({ text: m.accessory }, { text: ' ' })
  }
  if (detail >= 1) {
    segs.push({ text: m.name === '' ? '…' : m.name, color: tone(color), bold: true })
  }
  if (detail >= 2) {
    segs.push({ text: ` · ${fitCells(m.label, 28)}`, color: tone(MUTED) })
  }
  const tail: Seg =
    m.status === 'done'
      ? { text: '✓', color: tone(GREEN), bold: true }
      : m.status === 'failed'
        ? { text: '✗', color: tone(ROSE), bold: true }
        : { text: clockTime(now - m.startedAt), color: tone(MUTED) }
  segs.push({ text: '  ' }, tail)
  return segs
}

/** The crew's line, `room` cells: the spinner, then each agent at the most detail that lets all of them fit. */
function crewLine(r: Ref, room: number): Seg[] | null {
  const crew = visibleCrew(r)
  if (crew.length === 0 || room < 8) {
    return null
  }
  const live = crew.filter(isLive)
  const lead: Seg[] =
    live.length > 0
      ? [{ text: SPIN[Math.floor(r.clock / SPIN_MS) % SPIN.length]!, color: live[0]!.color || MUTED, bold: true }, { text: ' ' }]
      : []   // all finished: each shows its own ✓ or ✗ until it fades
  const GAP = '   '
  for (const detail of [2, 1, 0]) {
    for (let shown = crew.length; shown >= 1; shown -= 1) {
      const parts: Seg[] = [...lead]
      crew.slice(0, shown).forEach((m, i) => {
        if (i > 0) {
          parts.push({ text: GAP })
        }
        parts.push(...agentSegs(r, m, detail))
      })
      if (shown < crew.length) {
        parts.push({ text: `${GAP}+${crew.length - shown}`, color: MUTED })
      }
      // detail first: the role and task of every agent, else drop detail before dropping agents
      if (segWidth(parts) <= room && (shown === crew.length || detail === 0)) {
        return exactRow(parts, room)
      }
    }
  }
  return exactRow([...lead, { text: `${crew.length}`, color: MUTED }], room)
}

function rowFor(r: Ref, width: number): Seg[] {
  const fit = fitFor(r, width)
  if (fit.mode !== r.mode) {
    r.mode = fit.mode
    r.pill.x0 = -1   // the pill snaps into the new layout instead of gliding across it
    glidePills(r)
  }
  const o = r.open
  const isClosed = o <= 0 && !shownOpen(r)
  const closedBack = r.props.canBack && segWidth(controls(r, 0, fit.mode, true)) + 1 <= width
  let right = controls(r, o, fit.mode, o > 0 ? fit.back : closedBack)
  if (segWidth(right) > width - 1) {
    right = cutLeft(right, width - 1)   // too narrow: the left end goes, never the toggle
  }
  const gap = Math.max(0, width - segWidth(right) - 1)
  const middle: Seg[] = [{ text: ' '.repeat(gap) }]
  const msg = r.props.message
  // the agents' line sits where the message sits; the message waits until they leave
  let crewRoom = gap - 3
  if (isMoving(r.openM, r.clock)) {
    const wide = (k: number) => width - segWidth(controls(r, k, fit.mode, k > 0 ? fit.back : closedBack)) - 1 - 3
    crewRoom = Math.max(0, Math.min(crewRoom, wide(0), wide(1)))
  }
  const crewAt = crewLine(r, crewRoom - 2)
  if (crewAt !== null) {
    middle.splice(0, 1, { text: '  ' }, ...crewAt, { text: ' '.repeat(Math.max(0, gap - crewRoom)) })
  } else if (isClosed && msg !== null && gap >= 14) {
    const text = fitCells(msg.text, gap - 6)
    const pad = Math.max(1, gap - 3 - segWidth([{ text }]))
    middle.splice(0, 1, { text: '   ' }, { text, color: msg.tone === 'warn' ? AMBER : MUTED }, { text: ' '.repeat(pad) })
  }
  // the settings mark takes the row's leading cell (width-neutral), only with room before the controls
  const lead: Seg =
    r.props.canSettings === true && gap >= 2
      ? { text: '≡', color: r.hover === 'settings' ? TEXT : MUTED, bold: r.hover === 'settings', action: { kind: 'settings' } }
      : { text: ' ' }
  return exactRow([lead, ...middle, ...right], width)
}

function layout(r: Ref, columns: number): Seg[][] {
  const width = Math.max(20, (columns > 0 ? columns : 80) - 1)
  // one blank row above: the bar never sticks to the chat's last line
  const rows = [[{ text: ' ' }], rowFor(r, width)]
  return rows.map(row => exactRow(row, Math.min(Math.max(1, segWidth(row)), width)))
}

/** Neighbouring segs that look the same become one (clicks are placed from the rows before this). */
function merged(row: readonly Seg[]): Seg[] {
  const out: Seg[] = []
  for (const seg of row) {
    const last = out[out.length - 1]
    if (last !== undefined && last.color === seg.color && last.bg === seg.bg && (last.bold === true) === (seg.bold === true) && (last.dim === true) === (seg.dim === true)) {
      out[out.length - 1] = { ...last, text: last.text + seg.text }
    } else {
      out.push({ text: seg.text, color: seg.color, bg: seg.bg, bold: seg.bold, dim: seg.dim })
    }
  }
  return out
}

/** A fresh drawing state for these props (also what the tests lay out without a screen). */
function newRef(props: BarProps): Ref {
  const ref: Ref = {
    props,
    open: props.isOpen ? 1 : 0,
    openM: still(props.isOpen ? 1 : 0),
    fillM: still(fillCells(props.effort)),
    clock: 0,
    hover: '',
    focus: 'model',
    pending: { model: '', effort: '', since: 0 },
    changed: { id: '', at: 0 },
    isDragging: false,
    regions: [],
    pill: { x0: -1, x1: -1, mx0: still(-1), mx1: still(-1), color: MODEL_COLORS[props.model] ?? MUTED, alias: '', from: { x0: 0, x1: 0, color: MUTED } },
    fill: fillCells(props.effort),
    ultraPending: null,
    openPending: null,
    ultraAt: -1,
    outbox: { model: null, effort: null, at: 0 },
    crewSeen: {},
    hostAt: { host: props.now ?? 0, clock: 0 },
    crewStep: '',
    mode: 'labels',
    fit: { key: '', mode: 'labels', back: false },
  }

  return ref
}

/** The rows the bar would draw for these props at this width, settled (no motion): for the layout tests. */
export function previewRows(props: BarProps, columns: number): Seg[][] {
  const r = newRef(props)
  r.open = props.isOpen ? 1 : 0
  r.openM = still(r.open)
  glidePills(r)
  return layout(r, columns)
}

export default function Bar(props: BarProps, surface: ClientSurface<State>) {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    const ref = newRef(props)
    state = { ref, frame: 0 }
    surface.setState(state)
    surface.every(FRAME_MS, () => tick(surface))
    surface.onPointer(e => pointer(surface, e))
    surface.onKey(e => key(surface, e))
  }
  const r = state.ref
  if (props !== r.props && props.now !== undefined) {
    r.hostAt = { host: props.now, clock: r.clock }   // fresh props: the host's time is exactly this, now
  }
  r.props = props
  const rows = layout(r, surface.columns)
  r.regions = place(rows)
  const drawn = rows.map(merged)

  return (
    <Box flexDirection="column">
      {drawn.map((row, y) => (
        <Box key={`row-${y}`}>
          {row.map((seg, x) => (
            <Text key={`s-${x}`} color={seg.color} backgroundColor={seg.bg} bold={seg.bold === true} dimColor={seg.dim === true} wrap="truncate">
              {seg.text}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}
