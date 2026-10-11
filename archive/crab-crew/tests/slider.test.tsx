/**
 * Mapping A's Client module (hooks/card/slider.tsx).
 *
 * The kit only mounts a Client the plugin's own hooks module builds from a
 * literal path, and register.tsx is the integrator's, so these tests cover the
 * pure gesture math and drive the module through a tiny test-only surface that
 * keeps the ClientSurface contract (one setState at start, timers, post).
 */
import type { ClientElements, ClientKeyEvent, ClientPointerEvent, JsonValue, RenderElement } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import EffortSlider, {
  DECELERATION,
  RAIL,
  SLIDER_BAND,
  type Geometry,
  type Gesture,
  type SliderMessage,
  enqueue,
  grabOffset,
  keyLevel,
  levelFromX,
  measureMessage,
  pointerPx,
  pointerStep,
  projection,
  pxPerCell,
  readGeometry,
  releaseLevel,
  releaseVelocity,
  tickX,
  zoneAt,
} from '../hooks/card/slider'

const G: Geometry = readGeometry({ level: 2 })
const CELL = { w: 8, h: 16 }
const IDLE: Gesture = { kind: 'idle' }
/** A pointer event at SVG px (x, y), given as the cell holding it plus the fine point. */
const at = (type: ClientPointerEvent['type'], x: number, y = 106): ClientPointerEvent => ({
  type,
  x: Math.floor(x / CELL.w),
  y: Math.floor(y / CELL.h),
  fine: { x: x / CELL.w, y: y / CELL.h },
  ...(type === 'down' || type === 'move' || type === 'up' ? { button: 'left' as const } : {}),
})

test('readGeometry: spec defaults, tolerant of junk', () => {
  const g = readGeometry(null)
  expect(g.rail).toEqual(RAIL)
  expect(g.slider).toEqual(SLIDER_BAND)
  expect(g.level).toBe(2)
  expect(g.zones).toEqual([])
  expect(g.columns).toBeNull()
  const c = readGeometry({
    level: 9,
    slider: null,
    zones: [{ id: 'chev', x: 438, y: 0, w: 70, h: 60 }, { id: 'bad', x: 1 }, 'x'],
    columns: 70,
    rows: 5,
  })
  expect(c.level).toBe(4)
  expect(c.slider).toBeNull()
  expect(c.zones).toEqual([{ id: 'chev', x: 438, y: 0, w: 70, h: 60 }])
  expect(c.columns).toBe(70)
})

test('cells to px: cell centre, or the fine point; measured cell size wins', () => {
  expect(pointerPx({ x: 15, y: 6 }, CELL)).toEqual({ x: 124, y: 104 })
  expect(pointerPx({ x: 15, y: 6, fine: { x: 15.25, y: 6.5 } }, CELL)).toEqual({ x: 122, y: 104 })
  expect(pxPerCell(G, 0, 0)).toEqual({ w: 8, h: 16 })
  expect(pxPerCell(G, 70, 13)).toEqual({ w: 8, h: 16 })
})

test('level from x: nearest tick, clamped to the rail', () => {
  // the card's rail: the knob flush with the content column (x 30..530) at low and at max
  expect([0, 1, 2, 3, 4].map(l => tickX(l))).toEqual([43, 161.5, 280, 398.5, 517])
  expect(levelFromX(43)).toBe(0)
  expect(levelFromX(102)).toBe(0)
  expect(levelFromX(103)).toBe(1)
  expect(levelFromX(-50)).toBe(0)
  expect(levelFromX(900)).toBe(4)
})

test('grab offset: kept within 16px of the pet, else the knob jumps to the point', () => {
  expect(grabOffset(270, 266)).toBe(-4)
  expect(grabOffset(250, 266)).toBe(16)
  expect(grabOffset(249, 266)).toBe(0)
  expect(grabOffset(400, 266)).toBe(0)
})

test('release velocity: last 80 ms only; still pointer releases at 0', () => {
  expect(releaseVelocity([], 0)).toBe(0)
  expect(releaseVelocity([{ t: 0, x: 100 }], 0)).toBe(0)
  expect(releaseVelocity([{ t: 0, x: 100 }, { t: 50, x: 150 }], 50)).toBe(1000)
  // an old sample outside the window is ignored
  expect(releaseVelocity([{ t: 0, x: 0 }, { t: 100, x: 200 }, { t: 132, x: 232 }], 132)).toBe(1000)
  // held still for longer than the window
  expect(releaseVelocity([{ t: 0, x: 100 }, { t: 16, x: 140 }], 200)).toBe(0)
  expect(releaseVelocity([{ t: 10, x: 300 }, { t: 30, x: 280 }], 30)).toBe(-1000)
})

test('projection and release level (Apple deceleration .99)', () => {
  expect(DECELERATION).toBe(0.99)
  expect(projection(0)).toBe(0)
  expect(Math.round(projection(1000) * 1e6) / 1e6).toBe(99)
  expect(Math.round(projection(-500) * 1e6) / 1e6).toBe(-49.5)
  // from medium's tick, a 1000 px/s flick lands on xhigh (266 + 99 = 365 -> 3.375)
  expect(releaseLevel(266, 1000)).toBe(3)
  expect(releaseLevel(266, 2000)).toBe(4)
  expect(releaseLevel(300, 0)).toBe(2)
  expect(releaseLevel(140, -3000)).toBe(0)
})

test('arrow keys step; Home/End jump; others ignored', () => {
  expect(keyLevel(2, 'right')).toBe(3)
  expect(keyLevel(2, 'up')).toBe(3)
  expect(keyLevel(2, 'left')).toBe(1)
  expect(keyLevel(0, 'left')).toBe(0)
  expect(keyLevel(4, 'right')).toBe(4)
  expect(keyLevel(2, 'home')).toBe(0)
  expect(keyLevel(2, 'end')).toBe(4)
  expect(keyLevel(2, 'a')).toBeNull()
})

test('outbox: consecutive drag moves coalesce, everything else keeps order', () => {
  let q: SliderMessage[] = []
  q = enqueue(q, { kind: 'effort-drag', x: 200, phase: 'down', velocity: 0 })
  q = enqueue(q, { kind: 'effort-drag', x: 210, phase: 'move', velocity: 1 })
  q = enqueue(q, { kind: 'effort-drag', x: 220, phase: 'move', velocity: 2 })
  q = enqueue(q, { kind: 'effort-commit', level: 1, x: 220, velocity: 2, via: 'drag' })
  expect(q.map(m => (m.kind === 'effort-drag' ? `${m.phase}@${m.x}` : m.kind))).toEqual([
    'down@200',
    'move@220',
    'effort-commit',
  ])
})

test('tap on the band jumps to the nearest tick, no projection', () => {
  const down = pointerStep(IDLE, 2, G, at('down', 160), CELL, 0)
  expect(down.out).toEqual([{ kind: 'effort-drag', x: 160, phase: 'down', velocity: 0 }])
  const up = pointerStep(down.gesture, down.level, G, at('up', 162), CELL, 48)
  expect(up.gesture).toEqual(IDLE)
  expect(up.out).toEqual([{ kind: 'effort-commit', level: 1, x: 162, velocity: 0, via: 'tap' }])
})

test('drag from the pet keeps the grab offset, tracks 1:1 and projects on release', () => {
  let s = pointerStep(IDLE, 2, G, at('down', 284), CELL, 0)
  expect(s.out).toEqual([{ kind: 'effort-drag', x: 280, phase: 'down', velocity: 0 }])
  s = pointerStep(s.gesture, s.level, G, at('move', 304), CELL, 16)
  expect(s.out).toEqual([{ kind: 'effort-drag', x: 300, phase: 'move', velocity: 1250 }])
  s = pointerStep(s.gesture, s.level, G, at('move', 324), CELL, 32)
  expect(s.out[0]).toMatchObject({ kind: 'effort-drag', x: 320, phase: 'move' })
  // same point again: nothing to post
  expect(pointerStep(s.gesture, s.level, G, at('move', 324), CELL, 40).out).toEqual([])
  s = pointerStep(s.gesture, s.level, G, at('up', 324), CELL, 48)
  const commit = s.out[0]
  expect(commit).toMatchObject({ kind: 'effort-commit', x: 320, via: 'drag' })
  // 320 + projection(v) with v = (320 - 280) / 48 ms = 833 px/s -> ~402.5 -> xhigh
  expect(commit?.kind === 'effort-commit' ? Math.round(commit.velocity) : null).toBe(833)
  expect(s.level).toBe(3)
})

test('drag past the ends stays on the rail', () => {
  let s = pointerStep(IDLE, 0, G, at('down', 124), CELL, 0)
  s = pointerStep(s.gesture, s.level, G, at('move', 200), CELL, 8)
  s = pointerStep(s.gesture, s.level, G, { type: 'move', x: -3, y: 6, button: 'left' }, CELL, 16)
  expect(s.out[0]).toMatchObject({ x: 43 })
  s = pointerStep(s.gesture, s.level, G, { type: 'move', x: 90, y: 6, button: 'left' }, CELL, 32)
  expect(s.out[0]).toMatchObject({ x: 517 })
})

test('zones: down then up inside or outside; collapsed card has no slider', () => {
  const zones = [
    { id: 'chev', x: 438, y: 0, w: 70, h: 60 },
    { id: 'bar', x: 10, y: 0, w: 540, h: 60 },
  ]
  const g = readGeometry({ level: 2, slider: null, zones })
  expect(zoneAt(g.zones, 450, 30)?.id).toBe('chev')
  expect(zoneAt(g.zones, 200, 30)?.id).toBe('bar')
  expect(zoneAt(g.zones, 5, 30)).toBeNull()

  const down = pointerStep(IDLE, 2, g, at('down', 460, 30), CELL, 0)
  expect(down.out).toEqual([{ kind: 'zone', id: 'chev', phase: 'down' }])
  const upIn = pointerStep(down.gesture, 2, g, at('up', 470, 30), CELL, 16)
  expect(upIn.out).toEqual([{ kind: 'zone', id: 'chev', phase: 'up', inside: true }])
  const upOut = pointerStep(down.gesture, 2, g, at('up', 300, 30), CELL, 16)
  expect(upOut.out).toEqual([{ kind: 'zone', id: 'chev', phase: 'up', inside: false }])

  expect(pointerStep(IDLE, 2, g, at('down', 200, 30), CELL, 0).out).toEqual([{ kind: 'zone', id: 'bar', phase: 'down' }])
})

test('only the left button starts a gesture; stray ups and moves do nothing', () => {
  expect(pointerStep(IDLE, 2, G, { ...at('down', 200), button: 'right' }, CELL, 0).out).toEqual([])
  expect(pointerStep(IDLE, 2, G, at('up', 200), CELL, 0).out).toEqual([])
  expect(pointerStep(IDLE, 2, G, at('move', 200), CELL, 0).out).toEqual([])
  expect(pointerStep(IDLE, 2, G, at('down', 200, 10), CELL, 0)).toEqual({ gesture: IDLE, level: 2, out: [] })
})

// ---------------------------------------------------------------------------
// A tiny test-only surface for the module itself

type Surface = Parameters<typeof EffortSlider>[1]

type Fake = {
  surface: Surface
  draw: (props: JsonValue) => RenderElement
  pointer: (e: ClientPointerEvent) => void
  key: (e: ClientKeyEvent) => void
  advance: (ms: number) => void
  posts: JsonValue[]
  setStates: () => number
  timers: () => number
}

function fakeSurface(columns: number, rows: number): Fake {
  let state: unknown
  let setStates = 0
  let pointerFn: ((e: ClientPointerEvent) => void) | null = null
  let keyFn: ((e: ClientKeyEvent) => void) | null = null
  const timers: { ms: number; fn: () => void; due: number }[] = []
  let clock = 0
  const posts: JsonValue[] = []
  const elements = {
    Box: (props: object) => ({ type: 'Box', props }),
  } as unknown as ClientElements
  const surface = {
    elements,
    get state() {
      return state
    },
    setState: (next: unknown) => {
      state = next
      setStates++
    },
    columns,
    rows,
    every: (ms: number, fn: () => void) => {
      const t = { ms, fn, due: clock + ms }
      timers.push(t)
      return () => timers.splice(timers.indexOf(t), 1)
    },
    onPointer: (fn: (e: ClientPointerEvent) => void) => {
      pointerFn = fn
      return () => (pointerFn = null)
    },
    onKey: (fn: (e: ClientKeyEvent) => void) => {
      keyFn = fn
      return () => (keyFn = null)
    },
    post: (data: JsonValue) => posts.push(data),
  } as unknown as Surface
  return {
    surface,
    draw: props => EffortSlider(props, surface),
    pointer: e => pointerFn?.(e),
    key: e => keyFn?.(e),
    advance: ms => {
      const end = clock + ms
      for (;;) {
        const t = timers.filter(x => x.due <= end).sort((a, b) => a.due - b.due)[0]
        if (!t) break
        clock = t.due
        t.due += t.ms
        t.fn()
      }
      clock = end
    },
    posts,
    setStates: () => setStates,
    timers: () => timers.length,
  }
}

test('module: starts once, never sets state on later draws, draws an empty region', () => {
  const f = fakeSurface(70, 12)
  const tree = f.draw({ level: 2, columns: 70, rows: 12 })
  expect(tree).toEqual({ type: 'Box', props: { width: 70, height: 12 } })
  expect(f.setStates()).toBe(1)
  expect(f.timers()).toBe(1)
  f.draw({ level: 2 })
  f.draw({ level: 3 })
  expect(f.setStates()).toBe(1)
  expect(f.timers()).toBe(1)
  expect(f.draw({ level: 3 })).toEqual({ type: 'Box', props: { width: '100%', height: '100%' } })
})

test('module: at most one post per frame, drag moves coalesce, commit arrives last', () => {
  // 70 x 12 cells over 560 x 208 px: 8 x 17.33 px per cell
  const f = fakeSurface(70, 12)
  f.draw({ level: 2 })
  f.pointer({ type: 'down', x: 35, y: 6, button: 'left' }) // 284 px: the knob, offset -4
  expect(f.posts).toEqual([{ kind: 'effort-drag', x: 280, phase: 'down', velocity: 0 }])
  f.pointer({ type: 'move', x: 38, y: 6, button: 'left' })
  f.pointer({ type: 'move', x: 40, y: 6, button: 'left' })
  expect(f.posts).toHaveLength(1)
  f.advance(16)
  expect(f.posts).toHaveLength(2)
  expect(f.posts[1]).toMatchObject({ kind: 'effort-drag', phase: 'move', x: 320 })
  f.pointer({ type: 'up', x: 40, y: 6, button: 'left' })
  expect(f.posts).toHaveLength(2)
  f.advance(16)
  expect(f.posts[2]).toMatchObject({ kind: 'effort-commit', via: 'drag', x: 320 })
  f.advance(64)
  expect(f.posts).toHaveLength(3)
})

test('module: arrow keys commit from the latest level; props moving the level are adopted', () => {
  const f = fakeSurface(70, 12)
  f.draw({ level: 2 })
  f.key({ key: 'right' })
  expect(f.posts).toEqual([{ kind: 'effort-commit', level: 3, x: 398.5, velocity: 0, via: 'key' }])
  f.advance(16)
  f.key({ key: 'right' })
  expect(f.posts[1]).toMatchObject({ level: 4 })
  f.advance(16)
  f.key({ key: 'right' }) // already at max: nothing
  expect(f.posts).toHaveLength(2)
  f.draw({ level: 0 }) // the hooks module moved it (a native button, a new session value)
  f.advance(16)
  f.key({ key: 'right' })
  expect(f.posts[2]).toMatchObject({ level: 1 })
  // collapsed: no slider, keys do nothing
  f.draw({ level: 1, slider: null })
  f.advance(16)
  f.key({ key: 'right' })
  expect(f.posts).toHaveLength(3)
})

const ZONED: Geometry = readGeometry({
  level: 2,
  zones: [
    { id: 'm1', x: 155, y: 46, w: 125, h: 44 },
    { id: 'o0', x: 30, y: 132, w: 125, h: 44 },
    { id: 'o3', x: 405, y: 132, w: 125, h: 44 },
  ],
})

test('zones win over the slider band where they overlap (model edge, mode edges)', () => {
  expect(pointerStep(IDLE, 2, ZONED, at('down', 250, 88), CELL, 0).out).toEqual([{ kind: 'zone', id: 'm1', phase: 'down' }])
  expect(pointerStep(IDLE, 2, ZONED, at('down', 100, 134), CELL, 0).out).toEqual([{ kind: 'zone', id: 'o0', phase: 'down' }])
  expect(pointerStep(IDLE, 2, ZONED, at('down', 440, 134), CELL, 0).out).toEqual([{ kind: 'zone', id: 'o3', phase: 'down' }])
  expect(pointerStep(IDLE, 2, ZONED, at('down', 250, 106), CELL, 0).out[0]).toMatchObject({ kind: 'effort-drag' })
})

test('coarse input: a one-cell wobble across a frame is still a tap on the nearest tick', () => {
  const coarse = (type: ClientPointerEvent['type'], cx: number): ClientPointerEvent => ({ type, x: cx, y: 6, button: 'left' })
  let s = pointerStep(IDLE, 2, G, coarse('down', 33), CELL, 0)
  s = pointerStep(s.gesture, s.level, G, coarse('move', 34), CELL, 16)
  s = pointerStep(s.gesture, s.level, G, coarse('up', 34), CELL, 16)
  expect(s.out[0]).toMatchObject({ kind: 'effort-commit', level: 2, velocity: 0, via: 'tap' })
})

test('a non-left button release does not end a left drag', () => {
  let s = pointerStep(IDLE, 2, G, at('down', 130), CELL, 0)
  s = pointerStep(s.gesture, s.level, G, at('move', 320), CELL, 16)
  const right = pointerStep(s.gesture, s.level, G, { ...at('up', 320), button: 'right' }, CELL, 32)
  expect(right.out).toEqual([])
  expect(right.gesture.kind).toBe('drag')
})

test('measure: the region reports the cell it sees over the Svg once, only when its columns disagree with the drawn width', () => {
  const g = readGeometry({ svgWidth: 560, svgHeight: 48, measure: { cols: 70, cellPx: 8 } })
  expect(g.measure).toEqual({ cols: 70, cellPx: 8 })
  expect(measureMessage(g, 0)).toBeNull() // not laid out yet
  expect(measureMessage(g, 70)).toBeNull() // agrees
  expect(measureMessage(g, 68)).toBeNull() // two columns of rounding
  expect(measureMessage(g, 60)).toEqual({ kind: 'measure', cellPx: 9.33, columns: 60 })
  expect(measureMessage(readGeometry({ svgWidth: 560 }), 60)).toBeNull() // no measure asked
  // the module: one post for those props, none on later frames
  const f = fakeSurface(60, 3)
  f.draw({ level: 2, svgWidth: 560, svgHeight: 48, measure: { cols: 70, cellPx: 8 } })
  f.advance(16)
  expect(f.posts).toEqual([{ kind: 'measure', cellPx: 9.33, columns: 60 }])
  f.advance(160)
  expect(f.posts).toHaveLength(1)
  // a region that agrees posts nothing
  const ok = fakeSurface(70, 3)
  ok.draw({ level: 2, svgWidth: 560, svgHeight: 48, measure: { cols: 70, cellPx: 8 } })
  ok.advance(160)
  expect(ok.posts).toEqual([])
})

test('module (0.7.0): one post per frame carries every queued message (a batch), so a press never waits behind another post', () => {
  const f = fakeSurface(70, 3)
  f.draw({ level: 2, svgWidth: 560, svgHeight: 48, zones: [{ id: 'chev', x: 496, y: 4, w: 28, h: 40 }, { id: 'gear', x: 524, y: 4, w: 28, h: 40 }], slider: null })
  f.pointer({ type: 'down', x: 63, y: 1, button: 'left' })
  expect(f.posts).toEqual([{ kind: 'zone', id: 'chev', phase: 'down', at: [63, 1] }])
  // two presses in the same frame: both reach the hooks module in one post, in order
  f.pointer({ type: 'up', x: 63, y: 1, button: 'left' })
  f.pointer({ type: 'down', x: 67, y: 1, button: 'left' })
  expect(f.posts).toHaveLength(1)
  f.advance(16)
  expect(f.posts[1]).toEqual({
    kind: 'batch',
    items: [
      { kind: 'zone', id: 'chev', phase: 'up', inside: true },
      { kind: 'zone', id: 'gear', phase: 'down', at: [67, 1] },
    ],
  })
})

test('module (0.7.0): a press on nothing posts a miss (the diag log); hover over the effort rail posts once per entry; layout is reported after a quiet frame', () => {
  const f = fakeSurface(70, 3)
  const props = { level: 2, svgWidth: 560, svgHeight: 48, rowPx: 16, askRows: 3, report: true, zones: [{ id: 'gear', x: 524, y: 4, w: 28, h: 40 }], slider: { x: 16, y: 4, w: 88, h: 40 }, rail: { x0: 28, step: 16, count: 5 } }
  f.draw(props)
  f.advance(32)
  expect(f.posts).toEqual([{ kind: 'layout', columns: 70, rows: 3 }])
  f.pointer({ type: 'down', x: 30, y: 1, button: 'left' }) // x 244: no zone, off the rail
  expect(f.posts[1]).toEqual({ kind: 'miss', at: [30, 1], px: [244, 24] })
  f.pointer({ type: 'up', x: 30, y: 1, button: 'left' })
  f.advance(16)
  // hover: over the rail (x 4 -> 36 px) once, moving on it nothing more, leaving and coming back once more
  f.pointer({ type: 'move', x: 4, y: 1 })
  f.advance(16)
  f.pointer({ type: 'move', x: 6, y: 1 })
  f.advance(16)
  f.pointer({ type: 'move', x: 40, y: 1 })
  f.advance(16)
  f.pointer({ type: 'move', x: 5, y: 1 })
  f.advance(16)
  expect(f.posts.filter(p => (p as { kind?: string }).kind === 'hover')).toHaveLength(2)
  // rows map at the cell height asked for while the region is laid out at those rows: row 2 -> 40 px (inside the gear's zone)
  const g = readGeometry(props)
  expect(pxPerCell(g, 70, 3)).toEqual({ w: 8, h: 16 })
  // laid out at other rows (the surface did not take the size): proportional over the drawing, as before
  expect(pxPerCell(g, 70, 4)).toEqual({ w: 8, h: 12 })
})
