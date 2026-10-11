import { expect, test } from 'claude-code/testing'
import { FAMILIES, type NextStep } from '../hooks/card/parse'
import { CORAL, EFFORT_ICONS } from '../hooks/card/effort-icon'
import { MODE_ICON_SIZE, modeIcon, modeIconPaths } from '../hooks/card/mode-icons'
import { MODEL_TINT } from '../hooks/card/pet'
import { petHiresPlayMs } from '../hooks/card/pet-hires'
import {
  BAR_RAIL,
  CARD_MS,
  CURVE,
  GRID,
  LOOK_H,
  MAX_ANIMATED,
  RAIL,
  type AnimState,
  type CardView,
  type Rect,
  animEnd,
  effortOnRail,
  emptyAnim,
  hitMap,
  layout,
  matchesRecommendation,
  petPlaying,
  renderCard,
  retarget,
  sampleTrack,
  startPetHover,
  unitsAt,
  zoneAt,
} from '../hooks/card/svg'

/** the source budget (the Svg element itself allows 131072) */
const LIMIT = 40_000
const STEP: NextStep = { task: 'spike de capacidades no desktop', model: 'opus', modelLabel: 'Opus 5.5', effort: 'high', mode: 'auto' }

/** The layout and timing tests below were written against the star icon: it stays their fixture (the default is the pet since 0.7.0). */
function view(over: Partial<CardView> = {}): CardView {
  return {
    step: STEP,
    draft: { model: 'opus', effort: 2, mode: 'auto' },
    collapsed: false,
    dragging: false,
    icon: 'star',
    ...over,
  }
}
const bar = (over: Partial<CardView> = {}): CardView => view({ collapsed: true, ...over })
const hidden = (over: Partial<CardView> = {}): CardView => view({ collapsed: true, hidden: true, ...over })
const all = (s: string, re: RegExp): string[] => [...s.matchAll(re)].map(m => m[1] ?? '')
/** the knob group (expanded): translate, its discrete animateTransform, then (the effort words and) the thumb (r 13) */
const knob = (s: string): RegExpExecArray | null =>
  /<g transform="translate\(([-\d.]+ [-\d.]+)\)">(<animateTransform[^>]*\/>)?(?:<g transform="translate\(0 [-\d.]+\)"[^>]*>.*?<\/text><\/g>)*<g><circle r="13"/.exec(s)
/** the markup without the mode icon's group */
const noModeIcon = (s: string): string => s.replace(/<g [^>]*class="cc-mode">.*?<\/g>/g, '')
const r = (x: number): number => Math.round(x * 100) / 100
const ints = (s: string): number[] => s.split(/[;\s]+/).filter(Boolean).map(Number)
/** every duration (s) and keySpline an SVG string emits */
const durs = (s: string): number[] => all(s, /\bdur="([\d.]+)s"/g).map(Number)
const splines = (s: string): string[] => all(s, /keySplines="([^"]*)"/g).flatMap(x => x.split(';'))

test('every state stays under the Svg source limit: icons, looks, the recommendation chip, changes in flight', () => {
  const cases: [string, CardView, AnimState, number, boolean][] = []
  for (const style of EFFORT_ICONS) {
    for (const mapping of ['A', 'B'] as const) {
      const E = view({ icon: style, mapping }), C = bar({ icon: style, mapping })
      const D = bar({ icon: style, mapping, draft: { model: 'haiku', effort: 0, mode: 'plan' } })
      cases.push([`rest ${style} ${mapping}`, E, emptyAnim(), 0, false])
      cases.push([`bar ${style} ${mapping}`, C, emptyAnim(), 0, false])
      cases.push([`hidden ${style} ${mapping}`, hidden({ icon: style, mapping }), emptyAnim(), 0, false])
      cases.push([`bar with the chip ${style} ${mapping}`, D, emptyAnim(), 0, false])
      cases.push([`chip in ${style}`, D, retarget(emptyAnim(), C, D, 0, false), 100, false])
      for (let L = 0; L < 5; L++) {
        const a = view({ icon: style, mapping, draft: { model: 'opus', effort: L, mode: 'auto' } })
        cases.push([`level ${L} ${style}`, a, retarget(emptyAnim(), E, a, 0, false), 40, false])
      }
      const drag1 = view({ icon: style, mapping, dragging: true, draft: { model: 'opus', effort: 3.6, mode: 'auto' } })
      cases.push([`dragging ${style}`, drag1, retarget(emptyAnim(), E, drag1, 16, false), 30, false])
      const m = view({ icon: style, mapping, draft: { model: 'haiku', effort: 2, mode: 'plan' } })
      cases.push([`model + mode ${style}`, m, retarget(emptyAnim(), E, m, 0, false), 60, false])
    }
  }
  const lo = view({ draft: { model: 'opus', effort: 1, mode: 'auto' } })
  cases.push(['reduced change', lo, retarget(emptyAnim(), view(), lo, 0, true), 100, true])
  cases.push(['reduced no recommendation', bar({ hasRec: false }), retarget(emptyAnim(), view({ hasRec: false }), bar({ hasRec: false }), 0, true), 100, true])
  let peak = 0
  for (const [name, v, anim, now, red] of cases) {
    for (const theme of ['dark', 'light'] as const) {
      const out = renderCard(v, anim, now, theme, red)
      peak = Math.max(peak, out.svg.length)
      expect([name, out.svg.length < LIMIT]).toEqual([name, true])
      expect(out.svg).toStartWith('<svg ')
      expect(out.svg).toEndWith('</svg>')
      expect(out.width).toBe(560)
      /* scaled to a narrow band: same budget */
      expect(renderCard(v, anim, now, theme, red, 'k_', 280).svg.length).toBeLessThan(LIMIT)
    }
  }
  expect(peak).toBeGreaterThan(5_000)
  /* an icon change mid cross-fade, every pair */
  for (const a of EFFORT_ICONS) for (const b of EFFORT_ICONS) {
    if (a === b) continue
    const out = renderCard(view({ icon: b }), retarget(emptyAnim(), view({ icon: a }), view({ icon: b }), 0, false), 100, 'dark', false)
    expect([a, b, out.svg.length < LIMIT]).toEqual([a, b, true])
  }
  /* a model change really is in flight at its start */
  const hk = view({ draft: { model: 'haiku', effort: 2, mode: 'auto' } })
  expect(renderCard(hk, retarget(emptyAnim(), view(), hk, 1000, false), 1001, 'dark', false).svg).toContain('<animate')
})

test('the frame height is fixed per look (184, 48, 20), whatever the width, and a change of look is instant', () => {
  expect(LOOK_H).toEqual({ expanded: 184, bar: 48, hidden: 20 })
  for (const width of [280, 500, 560, 760, 1100]) {
    expect(renderCard(view({ width }), emptyAnim(), 0, 'dark', false).height).toBe(184)
    expect(renderCard(bar({ width }), emptyAnim(), 0, 'dark', false).height).toBe(48)
    expect(renderCard(hidden({ width }), emptyAnim(), 0, 'dark', false).height).toBe(20)
  }
  for (const [b, a] of [[view(), bar()], [bar(), view()], [bar(), hidden()], [hidden(), bar()], [view(), hidden()]] as const) {
    const anim = retarget(emptyAnim(), b, a, 0, false)
    expect(Object.keys(anim.tracks)).toEqual([])
    expect([anim.change, anim.at]).toEqual([null, null])
    for (const now of [0, 100, 300]) {
      const out = renderCard(a, anim, now, 'dark', false)
      expect(out.height).toBe(renderCard(a, emptyAnim(), 0, 'dark', false).height)
      expect(out.svg).not.toContain('<animate')
      expect(out.svg).not.toContain('@keyframes')
    }
  }
  /* a look change mid-way through a value change drops it: nothing in flight on the new look */
  const m = view({ draft: { model: 'haiku', effort: 2, mode: 'auto' } })
  const a = retarget(retarget(emptyAnim(), view(), m, 0, false), m, bar({ draft: m.draft }), 100, false)
  expect(animEnd(a)).toBeNull()
})

test('the card is laid out at the band width, never scaled: the root is W x H in its own px, the surface spans it edge to edge', () => {
  for (const width of [500, 760, 1100]) {
    for (const [look, v, H] of [['expanded', view({ width }), 184], ['bar', bar({ width }), 48], ['hidden', hidden({ width }), 20]] as const) {
      const out = renderCard(v, emptyAnim(), 0, 'dark', false)
      expect([look, out.width, out.height]).toEqual([look, width, H])
      expect(out.svg).toStartWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" `)
      expect(out.svg).not.toContain('preserveAspectRatio')
      /* no margin, no shadow: the surface (the band) runs from x 0 to W, 4 px of frame above it */
      expect(out.svg).toContain(`<rect x="0" y="4" width="${width}" height="${H - 8}" rx="`)
      expect(out.svg).not.toContain('feGaussianBlur')
    }
  }
  /* the width parameter stands in for view.width */
  expect(renderCard(bar(), emptyAnim(), 0, 'dark', false, 'k_', 760).svg).toBe(renderCard(bar({ width: 760 }), emptyAnim(), 0, 'dark', false).svg)
  /* out of bounds or junk: clamped, or the default */
  expect(renderCard(bar({ width: 100 }), emptyAnim(), 0, 'dark', false).width).toBe(280)
  expect(renderCard(bar({ width: Number.NaN }), emptyAnim(), 0, 'dark', false).width).toBe(560)
  /* a change of width is instant: nothing animates, and a stale record is dropped */
  const m = view({ draft: { model: 'haiku', effort: 2, mode: 'auto' } })
  const moving = retarget(emptyAnim(), view(), m, 0, false)
  const wide = { ...m, width: 900 }
  const a = retarget(moving, m, wide, 50, false)
  expect(Object.keys(a.tracks)).toEqual([])
  expect(renderCard(wide, a, 60, 'dark', false).svg).not.toContain('<animate')
})

test('width layout at 500, 760 and 1100 px: left content anchored left, hide / chevron / gear anchored to the right edge, wells and rail across', () => {
  for (const W of [500, 760, 1100]) {
    for (const v of [view({ width: W }), bar({ width: W })]) {
      const h = hitMap(v)
      /* three 28 px targets side by side, the gear's ending 8 px from the right edge */
      expect([W, h.hide.w, h.toggle.w, h.gear.w]).toEqual([W, 28, 28, 28])
      expect(h.hide.x + h.hide.w).toBe(h.toggle.x)
      expect(h.toggle.x + h.toggle.w).toBe(h.gear.x)
      expect(h.gear.x + h.gear.w).toBe(W - 8)
      expect(h.card).toMatchObject({ x: 0, w: W })
      const s = renderCard(v, emptyAnim(), 0, 'dark', false).svg
      /* the glyphs centred in their targets, on the controls' row */
      for (const [id, r] of [['hide', h.hide], ['chev', h.toggle], ['gear', h.gear]] as const) {
        const cx = r.x + r.w / 2
        expect([W, id, s.includes(`translate(${cx} 24)`)]).toEqual([W, id, true])
        expect([W, id, zoneAt(v, cx, 24)]).toEqual([W, id, id])
      }
      expect(zoneAt(v, W - 22, 30)).toBe('gear')
      expect(zoneAt(v, W - 50, 30)).toBe('chev')
      expect(zoneAt(v, W - 78, 30)).toBe('hide')
    }
    /* the bar: the rail's knob and the name at the same x at every width; the body is everything between the rail and the controls */
    const b = renderCard(bar({ width: W }), emptyAnim(), 0, 'dark', false).svg
    expect(b).toContain('<g class="cc-bar-knob" transform="translate(60 22)">')
    expect(b).toContain('<text x="114" y="28" font-size="13" font-weight="600"')
    const hb = hitMap(bar({ width: W }))
    expect(hb.zones.find(z => z.id === 'body')).toEqual({ id: 'body', x: 104, y: 4, w: hb.crew.x - 104, h: 40 })
    expect(zoneAt(bar({ width: W }), hb.crew.x - 1, 24)).toBe('body')
    expect(zoneAt(bar({ width: W }), 60, 24)).toBe('slider')
    /* expanded: the 4 columns tile the content column (16 .. W - 16); the rail spans it, the knob flush at both ends */
    const h = hitMap(view({ width: W })), L = layout(W)
    expect(h.models[0]?.x).toBe(16)
    expect(r((h.models[3]?.x ?? 0) + (h.models[3]?.w ?? 0))).toBe(W - 16)
    expect(h.modes.map(m => m.x)).toEqual(h.models.map(m => m.x))
    expect(h.slider).toEqual({ x: 16, y: 80, w: W - 32, h: 50 })
    expect(h.rail).toEqual(L.rail)
    expect(L.rail.x0 - 13).toBe(16)
    expect(r(L.rail.x0 + 4 * L.rail.step + 13)).toBe(W - 16)
    expect(h.native).toEqual({ rowLeft: 16, rowWidth: W - 32, rowHeight: 30 })
    const s = renderCard(view({ width: W }), emptyAnim(), 0, 'dark', false).svg
    expect(all(s, new RegExp(`<rect x="16" y="(\\d+)" width="${W - 32}" height="28" rx="8"`, 'g'))).toEqual(['46', '136'])
    expect(s).toContain(`<rect x="16" y="98" width="${W - 32}" height="4" rx="2"`)
    /* the pills grow with the band: a quarter of the column less 4 px */
    expect(s).toContain(`width="${r((W - 32) / 4 - 4)}" height="24" rx="6.5" fill="#3A3A3F"`)
    /* zone ids are the same at every width */
    expect(h.zones.map(z => z.id)).toEqual(['crew', 'hide', 'chev', 'gear', 'm0', 'm1', 'm2', 'm3', 'o0', 'o1', 'o2', 'o3'])
  }
  /* the hidden handle: the whole strip, edge to edge */
  for (const W of [500, 760, 1100]) expect(hitMap(hidden({ width: W })).zones).toEqual([{ id: 'show', x: 0, y: 0, w: W, h: 20 }])
})

test('alignment: the mode pills use exactly the model columns, the rail spans the same width, all on the content column', () => {
  const h = hitMap(view())
  expect(h.models).toHaveLength(4)
  expect(h.modes).toHaveLength(4)
  for (let i = 0; i < 4; i++) {
    const m = h.models[i], o = h.modes[i]
    expect([i, o?.x, o?.w, o?.h]).toEqual([i, m?.x, m?.w, m?.h])
  }
  /* the columns tile the content column exactly */
  expect(GRID).toEqual({ x: 16, w: 528 })
  expect(h.models[0]?.x).toBe(GRID.x)
  expect((h.models[3]?.x ?? 0) + (h.models[3]?.w ?? 0)).toBe(GRID.x + GRID.w)
  expect(h.slider).toEqual({ x: GRID.x, y: 80, w: GRID.w, h: 50 })
  expect((h.efforts[0]?.x ?? 0)).toBe(GRID.x)
  expect(r((h.efforts[4]?.x ?? 0) + (h.efforts[4]?.w ?? 0))).toBe(GRID.x + GRID.w)
  expect(h.rail).toEqual(RAIL)
  /* the knob is flush with the column at low and at max */
  expect(RAIL.x0 - 13).toBe(GRID.x)
  expect(RAIL.x0 + 4 * RAIL.step + 13).toBe(GRID.x + GRID.w)
  /* the fallback native row shares the column */
  expect(h.native).toEqual({ rowLeft: 16, rowWidth: 528, rowHeight: 30 })
  /* drawn: both wells, the rail and the task start at x 16 and end at 544; the pills are the same rect */
  for (const mode of ['plan', 'auto', 'default', 'acceptEdits'] as const) {
    for (const [mi, model] of FAMILIES.entries()) {
      const s = renderCard(view({ draft: { model, effort: 2, mode } }), emptyAnim(), 0, 'dark', false).svg
      expect(all(s, /<rect x="16" y="(\d+)" width="528" height="28" rx="8"/g)).toEqual(['46', '136'])
      expect(s).toContain('<rect x="16" y="98" width="528" height="4" rx="2"')
      expect(s).toContain('<text x="16" y="28.5"')
      const mPill = /<rect x="([\d.]+)" y="48" width="([\d.]+)" height="24" rx="6.5" fill="#3A3A3F"/.exec(s)
      const oPill = /<rect x="([\d.]+)" y="138" width="([\d.]+)" height="24" rx="6.5" fill="#3A3A3F"/.exec(s)
      expect([model, mPill?.[1], mPill?.[2]]).toEqual([model, String(18 + 132 * mi), '128'])
      const oi = ['plan', 'auto', 'default', 'acceptEdits'].indexOf(mode)
      expect([mode, oPill?.[1], oPill?.[2]]).toEqual([mode, String(18 + 132 * oi), '128'])
    }
  }
  /* hit test */
  expect(zoneAt(view(), 82, 60)).toBe('m0')
  expect(zoneAt(view(), 82, 150)).toBe('o0')
  expect(zoneAt(view(), 520, 150)).toBe('o3')
  expect(zoneAt(view(), 520, 60)).toBe('m3')
  expect(zoneAt(view(), 300, 100)).toBe('slider')
  expect(zoneAt(view(), 482, 24)).toBe('hide')
  expect(zoneAt(view(), 510, 24)).toBe('chev')
  expect(zoneAt(view(), 538, 24)).toBe('gear')
})

test('collapsed bar: [compact effort rail + knob] [Name ver] [mode icon] ... [crew] [hide] [chevron] [gear]; one baseline, no badge, a legible version, no Apply, no task', () => {
  for (const theme of ['dark', 'light'] as const) {
    const muted = theme === 'dark' ? '#939398' : '#6B6B70', seg = theme === 'dark' ? '#9C9CA1' : '#5F5F64'
    const s = renderCard(bar({ mapping: 'A' }), emptyAnim(), 0, theme, false).svg
    /* the name, then its version in one text: muted, regular, 11 px (legible), on the same baseline */
    expect(s).toContain(`>Opus<tspan dx="4" font-size="11" font-weight="400" letter-spacing="0" fill="${muted}">5.5</tspan></text>`)
    for (const other of ['Haiku', 'Sonnet', 'Fable']) expect(s).not.toContain(`>${other}<`)
    /* every text on the bar sits on one baseline */
    expect(new Set(all(s, /<text [^>]*\by="([\d.]+)"/g))).toEqual(new Set(['28']))
    /* the mode is only its icon in the row, vertically centred: a <title> tooltip names it, the text is gone */
    expect(s).toContain(modeIcon('auto', seg, { x: 175.7, y: 16, title: 'Auto', attrs: 'class="cc-mode"' }))
    expect(s).not.toContain('>Auto</text>')
    expect(s).not.toContain('r="1.1"') // no separator dot
    expect(s).not.toContain(`>${STEP.task}</text>`) // no task (the aria label still names it)
    expect(s).not.toContain('y="98"') // not the expanded rail: the compact one sits under the knob
    expect(s).toContain('<rect class="cc-bar-rail" x="16" y="33" width="88" height="2" rx="1"')
    expect(all(noModeIcon(s), /(stroke-width="1\.5")/g)).toHaveLength(2) // the hide bar and the chevron (the gear is 1.25)
    expect(s).toContain('class="cc-hide"')
    expect(s).toContain('class="cc-gear"')
    /* the effort icon is the compact rail's knob: no round badge (thumb) behind it */
    expect(s).toContain(`<g class="cc-bar-knob" transform="translate(60 22)"><path`)
    expect(s).not.toContain('<circle r="13"')
    expect(s).toContain(`stroke="${CORAL}" stroke-width="1.9"`) // the coral star (this fixture's icon)
    expect(s).toContain('class="cc-crew"')
    expect(s).not.toContain('Apply')
    expect(s).not.toContain('Ready')
    expect(s).toContain('translate(482 24)') // hide
    expect(s).toContain('translate(510 24)') // chevron
    expect(s).toContain('translate(538 24)') // gear
    expect(s).toContain('rotate(180)')
    expect(s).not.toContain('cc-rec-chip') // the session matches the recommendation: no chip
  }
  /* the bar: crew, hide, the chevron, the gear, and the rest (past the rail) is one target that expands */
  expect(hitMap(bar()).zones.map(z => z.id)).toEqual(['crew', 'hide', 'chev', 'gear', 'body'])
})

test('hidden: a slim full-width handle, one zone (all of it) that brings the bar back, an honest label', () => {
  for (const theme of ['dark', 'light'] as const) {
    const out = renderCard(hidden({ draft: { model: 'sonnet', effort: 3, mode: 'plan' } }), emptyAnim(), 0, theme, false)
    expect([out.width, out.height]).toEqual([560, 20])
    expect(out.svg).toContain('<rect x="0" y="4" width="560" height="12" rx="6"')
    expect(out.svg).toContain('class="cc-show"')
    expect(out.svg).not.toContain('>Sonnet')
    expect(out.svg).not.toContain('<animate')
    expect(out.alt).toBe('Crab card hidden (Sonnet 5.5, xhigh effort, Plan mode): press to show it.')
  }
  expect(hitMap(hidden()).zones.map(z => z.id)).toEqual(['show'])
  expect(zoneAt(hidden(), 280, 10)).toBe('show')
  expect(zoneAt(hidden(), 4, 10)).toBe('show')
  expect(zoneAt(hidden(), 556, 10)).toBe('show')
  expect(zoneAt(hidden(), 100, 25)).toBeNull()
  expect(hitMap(hidden()).slider).toBeNull()
})

test("the bar shows the reply's recommendation as a quiet chip while the session differs from it (and it fits)", () => {
  const words = { haiku: 'Haiku · low', sonnet: 'Sonnet · medium', opus: 'Opus · high', fable: 'Fable · max' } as const
  const names = { haiku: 'Plan', sonnet: 'Ask', opus: 'Auto', fable: 'Edits' } as const
  const efforts = { haiku: 'low', sonnet: 'medium', opus: 'high', fable: 'max' } as const
  const modes = { haiku: 'plan', sonnet: 'default', opus: 'auto', fable: 'acceptEdits' } as const
  for (const f of FAMILIES) {
    /* the session runs Opus / high / Auto (the default draft); the chip is the recommendation when it differs */
    const rec = { ...STEP, model: f, effort: efforts[f], mode: modes[f] }
    const differs = f !== 'opus'
    const s = renderCard(bar({ step: rec }), emptyAnim(), 0, 'dark', false).svg
    expect([f, s.includes('class="cc-rec-chip"')]).toEqual([f, differs])
    if (!differs) continue
    expect(s).toContain(`>${words[f]}</text>`)
    expect(s).toContain(`<title>${names[f]}</title>${modeIconPaths(modes[f], '#939398')}</g>`)
    /* quiet: a faint capsule (no dashes, no border), muted text at lower opacity, no tint dot */
    expect(s).toMatch(/<rect class="cc-rec-chip"[^>]* rx="10" fill="#939398" fill-opacity="0\.12"\/>/)
    expect(s).toContain(`font-size="11" letter-spacing="-.02" fill="#939398" opacity="0.85">${words[f]}</text>`)
    expect(s).not.toContain('stroke-dasharray')
    expect(s).not.toContain(`fill="${MODEL_TINT[f]}"`)
    expect(s).toContain('>Opus<tspan') // the bar still names what the session runs
  }
  /* it follows the mode icon's slide (one translate on the same track) */
  const D = bar({ draft: { model: 'sonnet', effort: 2, mode: 'auto' } })
  const slide = retarget(emptyAnim(), bar(), D, 0, false)
  expect(slide.tracks.opRec?.to).toEqual([1])
  expect(slide.tracks.cmX).toBeDefined()
  expect(renderCard(D, slide, 100, 'dark', false).svg).toMatch(/<g transform="translate\([-\d.]+ 0\)"><animateTransform attributeName="transform" type="translate" values="[^"]*"/)
  /* not on the expanded card, and not before any reply recommended something */
  expect(renderCard(view({ step: { ...STEP, model: 'haiku' } }), emptyAnim(), 0, 'dark', false).svg).not.toContain('cc-rec-chip')
  expect(renderCard(bar({ hasRec: false }), emptyAnim(), 0, 'dark', false).svg).not.toContain('cc-rec-chip')
  /* a narrow band keeps the controls clear: no room, no chip */
  const far = { ...STEP, model: 'sonnet' as const, effort: 'medium' as const, mode: 'default' as const }
  expect(renderCard(bar({ step: far, width: 330 }), emptyAnim(), 0, 'dark', false).svg).not.toContain('cc-rec-chip')
  expect(renderCard(bar({ step: far, width: 500 }), emptyAnim(), 0, 'dark', false).svg).toContain('cc-rec-chip')
  expect(zoneAt(bar(), 150, 24)).toBe('body')
})

test('no recommendation yet: the card shows the session alone (no outline, no chip, no task, an honest label)', () => {
  const n = view({ hasRec: false, draft: { model: 'haiku', effort: 0, mode: 'plan' } })
  const out = renderCard(n, emptyAnim(), 0, 'dark', false)
  expect(out.alt).toBe('Session: Haiku 5.5, low effort, Plan mode.')
  expect(out.svg).not.toContain('class="cc-rec"')
  expect(out.svg).not.toContain(`>${STEP.task}<`)
  expect(matchesRecommendation(n)).toBe(true)
  expect(renderCard(bar({ hasRec: false, draft: { model: 'haiku', effort: 0, mode: 'plan' } }), emptyAnim(), 0, 'dark', false).svg).not.toContain('cc-rec-chip')
})

test('hide, chevron and gear: three zones side by side at the right edge, at the same spot on the bar and on the card', () => {
  for (const v of [view(), bar()]) {
    const h = hitMap(v)
    expect(h.hide.x + h.hide.w).toBe(h.toggle.x)
    expect(h.toggle.x + h.toggle.w).toBe(h.gear.x)
    expect(h.gear.x + h.gear.w).toBe(552)
    const s = renderCard(v, emptyAnim(), 0, 'dark', false).svg
    for (const x of [482, 510, 538]) expect(s).toContain(`translate(${x} 24)`)
  }
  expect(zoneAt(view(), 538, 20)).toBe('gear')
  expect(zoneAt(bar(), 538, 40)).toBe('gear')
  expect(zoneAt(bar(), 470, 40)).toBe('hide')
})

test('every timing is <= 280 ms and every curve eases out', () => {
  for (const [k, ms] of Object.entries(CARD_MS)) expect([k, ms <= 280]).toEqual([k, true])
  expect(Object.values(CURVE)).toEqual([CURVE.out, CURVE.lin])
  const E = view({ mapping: 'A' })
  const pairs: [CardView, CardView][] = [
    [bar({ mapping: 'A' }), bar({ mapping: 'A', draft: { model: 'sonnet', effort: 2, mode: 'plan' } })],
    [E, view({ mapping: 'A', draft: { model: 'haiku', effort: 4, mode: 'plan' } })],
    [E, view({ mapping: 'A', icon: 'moon' })],
  ]
  for (const [b, a] of pairs) {
    const anim = retarget(emptyAnim(), b, a, 0, false)
    expect(Object.keys(anim.tracks).length + (anim.change ? 1 : 0)).toBeGreaterThan(0)
    for (const tr of Object.values(anim.tracks)) expect(tr.dur).toBeLessThanOrEqual(280)
    const s = renderCard(a, anim, 10, 'dark', false).svg
    for (const d of durs(s)) expect(d).toBeLessThanOrEqual(0.28)
    for (const c of splines(s)) expect([CURVE.out, CURVE.lin]).toContain(c)
  }
})

test('a drag is instant on whole pixels; the release eases onto the tick without overshoot', () => {
  const E = view()
  const d1 = view({ dragging: true, draft: { model: 'opus', effort: 2.37, mode: 'auto' } })
  const a1 = retarget(emptyAnim(), E, d1, 16, false)
  expect(Object.keys(a1.tracks)).toEqual([])
  expect(a1.change).toBeNull()
  const s1 = renderCard(d1, a1, 20, 'dark', false).svg
  expect(knob(s1)?.[1]).toBe('326 100') // round(29 + 125.5 * 2.37)
  expect(s1).not.toContain('<animate')
  const up = view({ draft: { model: 'opus', effort: 3, mode: 'auto' } })
  const rel = retarget(a1, d1, up, 40, false)
  const k = rel.tracks.kT
  expect(k?.from).toEqual([326, 100])
  expect(k?.via).toBeUndefined()
  expect(k?.spline).toBe(CURVE.out)
  expect(k?.dur).toBe(CARD_MS.release)
  expect(k?.to).toEqual([406, 100])
  if (k) for (let t = 40; t <= 40 + k.dur; t += 10) expect(sampleTrack(k, t)[0] ?? 0).toBeLessThanOrEqual(406.0001)
  for (const now of [41, 90, 200]) {
    const m = knob(renderCard(up, rel, now, 'dark', false).svg)
    expect(m?.[2] ?? '').toContain('calcMode="discrete"')
    for (const x of ints(`${m?.[1] ?? ''};${/values="([^"]*)"/.exec(m?.[2] ?? '')?.[1] ?? ''}`)) expect(Number.isInteger(x)).toBe(true)
  }
  /* a level click: the knob and the fill move together, ease out, no overshoot */
  const lv = view({ draft: { model: 'opus', effort: 4, mode: 'auto' } })
  const c = retarget(emptyAnim(), E, lv, 0, false)
  expect(c.tracks.kT?.via).toBeUndefined()
  expect(c.tracks.kT?.spline).toBe(CURVE.out)
  expect(c.tracks.kT?.to).toEqual([531, 100])
  expect(c.tracks.fillW?.dur).toBe(c.tracks.kT?.dur)
  expect(c.tracks.fillW?.to).toEqual([515])
})

test('a redraw returns the same string while a change is in flight, and once it ended; a re-target starts from the screen', () => {
  const E = view()
  const m2 = view({ draft: { model: 'sonnet', effort: 2, mode: 'auto' } })
  const b1 = retarget(emptyAnim(), E, m2, 0, false)
  expect(b1.at).toBe(0)
  /* in flight: drawn at the change's instant, whatever the redraw's clock */
  const s0 = renderCard(m2, b1, 0, 'dark', false).svg
  expect(s0).toContain('<animate')
  for (const now of [16, 50, 120, 279]) expect(renderCard(m2, b1, now, 'dark', false).svg).toBe(s0)
  /* ended: the view alone, the same at any later time */
  const end = animEnd(b1) ?? 0
  const rest = renderCard(m2, b1, end, 'dark', false).svg
  expect(rest).not.toContain('<animate')
  expect(renderCard(m2, b1, end + 5_000, 'dark', false).svg).toBe(rest)
  expect(rest).toBe(renderCard(m2, emptyAnim(), 0, 'dark', false).svg)
  /* a change that moves nothing (the recommendation's task) keeps the running record and its instant */
  const m2b = { ...m2, step: { ...STEP, task: 'outra' } }
  const same = retarget(b1, m2, m2b, 100, false)
  expect(same.tracks.mPill).toBe(b1.tracks.mPill)
  expect(same.at).toBe(0)
  /* rapid clicks across models re-target the pill mid-flight, from the value on screen */
  const hk = view({ draft: { model: 'haiku', effort: 2, mode: 'auto' } })
  const b2 = retarget(b1, m2, hk, 100, false)
  const x1 = b1.tracks.mPill, x2 = b2.tracks.mPill
  expect(x1 && x2).toBeTruthy()
  if (x1 && x2) {
    expect(x2.from[0]).toBe(sampleTrack(x1, 100)[0])
    expect(x2.to[0]).toBe(18) // Haiku is the first column
  }
  expect(b2.at).toBe(100)
  expect(b1.change).toBeNull() // a model change does not move the icon
  /* the knob continues from the whole pixel it shows */
  const lv = view({ draft: { model: 'opus', effort: 4, mode: 'auto' } })
  const k1 = retarget(emptyAnim(), E, lv, 0, false)
  const k2 = retarget(k1, lv, view({ draft: { model: 'opus', effort: 0, mode: 'auto' } }), 120, false)
  for (const x of k2.tracks.kT?.from ?? []) expect(Number.isInteger(x)).toBe(true)
})

test('the mode pill slides between pills like the model pill (ease out, <= 280 ms, from the value on screen)', () => {
  const a = view(), b = view({ draft: { model: 'opus', effort: 2, mode: 'acceptEdits' } })
  const anim = retarget(emptyAnim(), a, b, 0, false)
  expect(anim.tracks.oPill?.from).toEqual([150])
  expect(anim.tracks.oPill?.to).toEqual([414])
  expect(anim.tracks.oPill?.spline).toBe(CURVE.out)
  expect(anim.tracks.oPill?.dur).toBe(CARD_MS.select)
  expect(anim.tracks.oPill?.dur).toBe(retarget(emptyAnim(), a, view({ draft: { model: 'haiku', effort: 2, mode: 'auto' } }), 0, false).tracks.mPill?.dur)
  const mid = renderCard(b, anim, 80, 'dark', false).svg
  expect(mid).toContain('<animate attributeName="x" values="150;414"')
  /* the labels cross-fade with it */
  for (const k of ['opOB1', 'opOB3']) expect([k, anim.tracks[k]?.spline, (anim.tracks[k]?.dur ?? 999) <= 280]).toEqual([k, CURVE.out, true])
  expect(mid).toContain(modeIconPaths('acceptEdits', '#E6E6E6'))
  expect(mid).toContain(modeIconPaths('acceptEdits', '#9C9CA1'))
  /* re-targeted mid-flight from where it is */
  const c = view({ draft: { model: 'opus', effort: 2, mode: 'plan' } })
  const again = retarget(anim, b, c, 100, false)
  const o1 = anim.tracks.oPill
  if (o1) expect(again.tracks.oPill?.from[0]).toBe(sampleTrack(o1, 100)[0])
  /* at rest: no SMIL */
  expect(renderCard(b, emptyAnim(), 1000, 'dark', false).svg).not.toContain('<animate')
})

test('expanded mode pills: icon + name centred in their 128 px pill; selected in the text colour, others muted', () => {
  const MODES_ = ['plan', 'auto', 'default', 'acceptEdits'] as const
  const NAMES = ['Plan', 'Auto', 'Ask', 'Edits']
  const TW = [23.3, 26.3, 19.4, 25.9]
  for (const theme of ['dark', 'light'] as const) {
    const text = theme === 'dark' ? '#E6E6E6' : '#1D1D1F', muted = theme === 'dark' ? '#9C9CA1' : '#5F5F64'
    for (const [sel, mode] of MODES_.entries()) {
      const s = renderCard(view({ draft: { model: 'opus', effort: 2, mode } }), emptyAnim(), 0, theme, false).svg
      for (const [i, m] of MODES_.entries()) {
        const cx = 82 + 132 * i
        const at = s.indexOf(`<g transform="translate(${cx} 0)">`)
        expect([theme, m, at >= 0]).toEqual([theme, m, true])
        const pill = s.slice(at, s.indexOf('</text></g></g>', at))
        const ink = i === sel ? text : muted
        expect(pill).toContain(modeIconPaths(m, ink))
        expect(pill).toContain(`fill="${ink}">${NAMES[i]}`)
        expect(pill).not.toContain(i === sel ? muted : text)
        const ix = Number(/<g transform="translate\(([-\d.]+) 142\)">/.exec(pill)?.[1])
        const tx = Number(/<text x="([-\d.]+)" y="154.2"/.exec(pill)?.[1])
        expect(r(tx - ix)).toBe(MODE_ICON_SIZE + 5)
        expect(cx + ix).toBeGreaterThanOrEqual(18 + 132 * i + 6)
        expect(cx + tx + (TW[i] ?? 0)).toBeLessThanOrEqual(18 + 132 * i + 128 - 6)
        expect(Math.abs(ix + (tx - ix + (TW[i] ?? 0)) / 2)).toBeLessThan(0.1)
      }
      expect(s).toContain(`Opus 5.5, high effort, ${NAMES[sel]} mode.`)
    }
  }
})

test('no Apply, Ready or confirm anywhere; the recommendation is a faint dashed outline only where the selection differs', () => {
  for (const mapping of ['A', 'B'] as const) for (const v of [view({ mapping }), bar({ mapping }), hidden({ mapping })]) {
    const s = renderCard(v, emptyAnim(), 0, 'dark', false).svg
    for (const gone of ['Apply', 'Ready', 'stroke-dashoffset']) expect(s).not.toContain(gone)
  }
  /* matches: no outline drawn on the wells (the ring on the rail sits under the knob) */
  const same = renderCard(view(), emptyAnim(), 0, 'dark', false)
  expect(matchesRecommendation(view())).toBe(true)
  expect(all(same.svg, /<rect (class="cc-rec")/g)).toHaveLength(0)
  expect(same.alt).toContain('As recommended')
  /* the session runs Haiku / low / Plan: the outlines sit on Opus and Auto, the ring on the high tick */
  const v = view({ draft: { model: 'haiku', effort: 0, mode: 'plan' } })
  const d = renderCard(v, emptyAnim(), 0, 'dark', false)
  expect(matchesRecommendation(v)).toBe(false)
  expect(d.svg).toContain('<rect class="cc-rec" x="282.5" y="48.5" width="127" height="23" rx="6" fill="none" stroke="#939398" stroke-opacity="0.5" stroke-dasharray="3 2.5"/>')
  expect(d.svg).toContain('<rect class="cc-rec" x="150.5" y="138.5" width="127"')
  expect(d.svg).toContain('<circle class="cc-rec" cx="280" cy="100" r="4.5"')
  /* drawn under the selected pill (the pill hides it when they match) */
  expect(d.svg.indexOf('class="cc-rec" x="282.5"')).toBeLessThan(d.svg.indexOf('fill="#3A3A3F" filter'))
  expect(d.alt).toContain('Haiku 5.5, low effort, Plan mode. Recommended: Opus 5.5, high effort, Auto mode.')
})

test('at most 4 animated elements start in any change; a look change and a drag start none', () => {
  const E = view({ mapping: 'A' }), C = bar({ mapping: 'A' })
  const lv = view({ mapping: 'A', draft: { model: 'haiku', effort: 4, mode: 'plan' } })
  const d0 = view({ mapping: 'A', dragging: true }), d1 = view({ mapping: 'A', dragging: true, draft: { model: 'opus', effort: 3.4, mode: 'auto' } })
  const pairs: [string, CardView, CardView, boolean][] = [
    ['collapse', E, C, false], ['expand', C, E, false], ['hide', C, hidden({ mapping: 'A' }), false],
    ['everything at once', E, lv, true],
    ['grab', E, d0, false], ['drag', d0, d1, false], ['release', d1, view({ mapping: 'A', draft: { model: 'opus', effort: 3, mode: 'auto' } }), true],
    ['icon', E, view({ mapping: 'A', icon: 'pet' }), true],
    ['the session leaves the recommendation (bar)', C, bar({ mapping: 'A', draft: { model: 'haiku', effort: 0, mode: 'plan' } }), true],
  ]
  for (const [name, b, a, moves] of pairs) {
    const u = unitsAt(retarget(emptyAnim(), b, a, 500, false), 500)
    expect([name, moves ? u.length > 0 && u.length <= MAX_ANIMATED : u.length === 0]).toEqual([name, true])
  }
  /* five would start: the lowest priority (the effort word) snaps */
  const many = retarget(emptyAnim(), E, lv, 0, false)
  expect(unitsAt(many, 0).sort()).toEqual(['fill', 'knob', 'mode', 'model'])
  expect(many.tracks.opW4).toBeUndefined()
})

test('exits ease out and are ~20% shorter than entrances; the effort word rides under the knob', () => {
  expect(CARD_MS.fadeOut).toBe(CARD_MS.fadeIn * 0.8)
  const b = view({ draft: { model: 'opus', effort: 3, mode: 'auto' } })
  const a = retarget(emptyAnim(), view(), b, 0, false)
  expect([a.tracks.opW2?.spline, a.tracks.opW2?.dur]).toEqual([CURVE.out, CARD_MS.fadeOut])
  expect([a.tracks.opW3?.spline, a.tracks.opW3?.dur]).toEqual([CURVE.out, CARD_MS.fadeIn])
  /* the word is inside the knob's group, centred, 26 px under its centre */
  const s = renderCard(b, emptyAnim(), 0, 'dark', false).svg
  expect(s).toMatch(/<g transform="translate\(406 100\)"><g transform="translate\(0 0\)" opacity="0\.55"><text y="26" text-anchor="middle" font-size="10" font-weight="500" fill="#939398">xhigh<\/text>/)
  /* collapsed: no word */
  expect(renderCard(bar(), emptyAnim(), 0, 'dark', false).svg).not.toContain('>high</text>')
})

test('reduced motion is instant: no tracks, no records, no animation element, ever', () => {
  const E = view(), C = bar()
  const lo = view({ draft: { model: 'haiku', effort: 1, mode: 'plan' } })
  const pairs: [CardView, CardView][] = [[E, C], [C, E], [E, lo], [C, bar({ draft: lo.draft })], [E, view({ icon: 'moon' })]]
  for (const [b, a] of pairs) {
    const anim = retarget(emptyAnim(), b, a, 0, true)
    expect(Object.keys(anim.tracks)).toHaveLength(0)
    expect(anim.change).toBeNull()
    for (const now of [0, 80, 400]) {
      const svg = renderCard(a, anim, now, 'dark', true).svg
      expect(svg).not.toContain('<animate')
      expect(svg).not.toContain('@keyframes')
    }
  }
})

test('the icon comes from the view; an icon change cross-fades the knob only', () => {
  const PET = 'shape-rendering="crispEdges"' // the pet's pixel sprite
  const STAR = `stroke="${CORAL}" stroke-width="1.9"` // the star's rays
  const f0 = view({ icon: 'pet', draft: { model: 'opus', effort: 0, mode: 'auto' } })
  expect(renderCard(f0, emptyAnim(), 0, 'dark', false).svg).toContain(PET)
  const s0 = view({ draft: { model: 'opus', effort: 0, mode: 'auto' } })
  const a = retarget(emptyAnim(), s0, f0, 0, false)
  expect(a.change).toMatchObject({ level: 0, kind: 'star', start: 0 })
  expect(Object.keys(a.tracks)).toHaveLength(0)
  expect(unitsAt(a, 0)).toEqual(['knob'])
  const mid = renderCard(f0, a, 100, 'dark', false).svg
  expect(mid).toContain(STAR)
  expect(mid).toContain(PET)
  const rest = renderCard(f0, a, 400, 'dark', false).svg
  expect(rest).not.toContain(STAR)
  expect(rest).not.toContain('<animate')
  /* an unknown kind is the default: the pet */
  expect(renderCard(view({ icon: 'sparkly' as never }), emptyAnim(), 0, 'dark', false).svg).toContain(PET)
  /* on the bar the pet is the hi-res sprite, the compact rail's knob (no badge) */
  const pb = renderCard(bar({ icon: 'pet' }), emptyAnim(), 0, 'dark', false).svg
  expect(pb).toContain(`<g class="cc-bar-knob" transform="translate(60 22)"><svg `)
  expect(pb).toContain(PET)
})

test('a mapping change is instant', () => {
  const C = bar({ mapping: 'A' })
  expect(Object.keys(retarget(emptyAnim(), C, { ...C, mapping: 'B' }, 0, false).tracks)).toEqual([])
})

test('an anim record from an older version (ghost, hop, pet, reaction records) still renders and retargets', () => {
  const legacy = { tracks: {}, hop: 5, glance: null, wdir: 1, reaction: { level: 2, kind: 'star', start: 0 }, ghost: { view: view(), wdir: 1, start: 0 } } as unknown as AnimState
  expect(renderCard(view(), legacy, 10, 'dark', false).svg).toStartWith('<svg ')
  expect(retarget(legacy, view(), bar(), 10, false).change).toBeNull()
  expect(animEnd(legacy)).toBeNull()
  expect('ghost' in retarget(legacy, view(), bar(), 10, false)).toBe(false)
})

test('hitMap rectangles lie inside the card', () => {
  const inside = (q: Rect, c: Rect): boolean => q.x >= c.x && q.y >= c.y && q.x + q.w <= c.x + c.w && q.y + q.h <= c.y + c.h
  for (const v of [view(), bar()]) {
    const h = hitMap(v)
    const rects: Rect[] = [h.hide, h.toggle, h.gear, ...h.models, ...h.efforts, ...h.modes]
    if (h.slider) rects.push(h.slider)
    for (const q of rects) expect(inside(q, h.card)).toBe(true)
  }
  expect(hitMap(view()).card.h).toBe(176)
  expect(hitMap(bar()).card.h).toBe(40)
  const h = hitMap(view())
  expect(h.efforts).toHaveLength(5)
  expect(h.zones.map(z => z.id)).toEqual(['crew', 'hide', 'chev', 'gear', 'm0', 'm1', 'm2', 'm3', 'o0', 'o1', 'o2', 'o3'])
  expect(hitMap(bar()).models).toHaveLength(0)
  expect(hitMap(bar()).rail).toEqual(BAR_RAIL)
  /* the tick columns split halfway between ticks */
  for (let i = 0; i < 5; i++) {
    const c = h.efforts[i]
    const t = RAIL.x0 + RAIL.step * i
    expect(t >= (c?.x ?? 0) && t < (c?.x ?? 0) + (c?.w ?? 0)).toBe(true)
  }
  expect(zoneAt(bar(), 200, 24)).toBe('body')
  expect(zoneAt(bar(), 430, 24)).toBe('body')
  expect(zoneAt(bar(), 460, 24)).toBe('crew')
  expect(zoneAt(bar(), 500, 24)).toBe('chev')
  expect(zoneAt(bar(), 530, 24)).toBe('gear')
})

test('the bar\'s effort zones: the compact rail is a slider band of 5 tick columns left of the body; a tap or a drag maps onto its ticks', () => {
  const h = hitMap(bar())
  expect(h.rail).toEqual({ x0: 28, step: 16, count: 5 })
  expect(h.slider).toEqual({ x: 16, y: 4, w: 88, h: 40 })
  expect(h.efforts).toHaveLength(5)
  /* the columns tile the band and each holds its tick */
  expect(h.efforts[0]?.x).toBe(16)
  expect(r((h.efforts[4]?.x ?? 0) + (h.efforts[4]?.w ?? 0))).toBe(104)
  for (let i = 0; i < 5; i++) {
    const c = h.efforts[i], t = 28 + 16 * i
    expect([i, t >= (c?.x ?? 0) && t < (c?.x ?? 0) + (c?.w ?? 0)]).toEqual([i, true])
    expect(zoneAt(bar(), t, 24)).toBe('slider')
    expect(effortOnRail(t, BAR_RAIL)).toBe(i)
  }
  /* the band never overlaps a zone: the body starts where it ends */
  expect(h.zones.find(z => z.id === 'body')?.x).toBe(104)
  /* the knob follows the level (whole pixels), the fill runs to it */
  for (let L = 0; L < 5; L++) {
    const s = renderCard(bar({ draft: { model: 'opus', effort: L, mode: 'auto' } }), emptyAnim(), 0, 'dark', false).svg
    expect(s).toContain(`<g class="cc-bar-knob" transform="translate(${28 + 16 * L} 22)">`)
    expect(s).toContain(`<rect x="16" y="33" width="${12 + 16 * L}" height="2" rx="1"`)
  }
  /* a level change slides the knob in whole-pixel discrete steps */
  const a = retarget(emptyAnim(), bar(), bar({ draft: { model: 'opus', effort: 4, mode: 'auto' } }), 0, false)
  expect(a.tracks.bk?.to).toEqual([92, 22])
  expect(renderCard(bar({ draft: { model: 'opus', effort: 4, mode: 'auto' } }), a, 50, 'dark', false).svg).toMatch(/class="cc-bar-knob" transform="translate\(92 22\)"><animateTransform attributeName="transform" type="translate" values="[^"]*" keyTimes="[^"]*" calcMode="discrete"/)
})

test('the pet knob plays its level\'s sequence once on a change and once on hover, whole-pixel frames, then rests still; reduced is static', () => {
  const P = (over: Partial<CardView> = {}): CardView => view({ icon: 'pet', ...over })
  const PB = (over: Partial<CardView> = {}): CardView => bar({ icon: 'pet', ...over })
  for (const mk of [P, PB]) {
    const b = mk(), a = mk({ draft: { model: 'opus', effort: 4, mode: 'auto' } })
    const anim = retarget(emptyAnim(), b, a, 1_000, false)
    expect(anim.pet).toEqual({ level: 4, start: 1_000 })
    const end = 1_000 + petHiresPlayMs(4)
    expect(animEnd(anim)).toBeGreaterThanOrEqual(end)
    /* mid-play: the strip moves by whole frames (discrete), the redraw is the same string */
    const mid = renderCard(a, anim, 1_200, 'dark', false).svg
    expect(mid).toMatch(/type="translate" calcMode="discrete" values="-64 0;/)
    expect(renderCard(a, anim, 1_230, 'dark', false).svg).toBe(mid)
    /* past the end: the rest frame alone, no animation markup, and an idle redraw is byte-identical */
    const rest = renderCard(a, anim, end + 1, 'dark', false).svg
    expect(rest).not.toContain('<animate')
    expect(renderCard(a, anim, end + 500, 'dark', false).svg).toBe(rest)
    expect(rest).toBe(renderCard(a, emptyAnim(), 0, 'dark', false).svg)
    /* the frame height never changes with the play */
    expect(renderCard(a, anim, 1_200, 'dark', false).height).toBe(renderCard(a, emptyAnim(), 0, 'dark', false).height)
    /* hover: one play of the level on screen, not restarted while it runs */
    const h1 = startPetHover(emptyAnim(), a, 50_000, false)
    expect(h1.pet).toEqual({ level: 4, start: 50_000 })
    expect(h1.at).toBe(50_000)
    expect(startPetHover(h1, a, 50_100, false)).toEqual(h1)
    expect(petPlaying(h1, 50_100)).toBe(true)
    expect(petPlaying(h1, 50_000 + petHiresPlayMs(4))).toBe(false)
    expect(startPetHover(h1, a, 50_000 + petHiresPlayMs(4), false).pet?.start).toBe(50_000 + petHiresPlayMs(4))
    /* reduced, another icon, hidden or a drag: no play */
    expect(startPetHover(emptyAnim(), a, 50_000, true).pet ?? null).toBeNull()
    expect(startPetHover(emptyAnim(), { ...a, icon: 'star' }, 50_000, false).pet ?? null).toBeNull()
    expect(startPetHover(emptyAnim(), { ...a, hidden: true }, 50_000, false).pet ?? null).toBeNull()
    expect(retarget(emptyAnim(), b, a, 1_000, true).pet ?? null).toBeNull()
    expect(renderCard(a, retarget(emptyAnim(), b, a, 1_000, true), 1_100, 'dark', true).svg).not.toContain('<animate')
  }
  /* each level plays its own designed sequence (the approved durations), a single animated element */
  for (let L = 0; L < 5; L++) {
    const a = P({ draft: { model: 'opus', effort: L, mode: 'auto' } })
    const h = startPetHover(emptyAnim(), a, 0, false)
    const s = renderCard(a, h, 10, 'dark', false).svg
    expect([L, all(s, /calcMode="(discrete)"/g).length]).toEqual([L, 1])
    expect(s).toContain(`dur="${Math.round(petHiresPlayMs(L)) / 1000}s"`)
  }
})

test('task text: XML-invalid characters dropped, long text capped under the Svg limit', () => {
  const bad = view({ step: { ...STEP, task: 'fix \u001b[31m bug \u0008 \uD800 ok' } })
  const s = renderCard(bad, emptyAnim(), 0, 'dark', false).svg
  expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s)).toBe(false)
  expect(s).toContain('ok')
  const long = 'x'.repeat(60_000)
  const E = view({ step: { ...STEP, task: long } }), L = view({ step: { ...STEP, task: long }, draft: { model: 'opus', effort: 1, mode: 'auto' } })
  expect(renderCard(L, retarget(emptyAnim(), E, L, 0, false), 100, 'dark', false).svg.length).toBeLessThan(LIMIT)
  expect(renderCard(E, emptyAnim(), 0, 'dark', false, 'k9_').svg).toContain('k9_cp')
})

test('a level change on the rail leaves the icon 3 elements (the knob slide is the 4th); an icon change keeps 4', () => {
  const a = retarget(emptyAnim(), view(), view({ draft: { model: 'opus', effort: 4, mode: 'auto' } }), 0, false)
  expect(a.tracks.kT?.start).toBe(0)
  expect(a.change?.max).toBe(3)
  const s = retarget(emptyAnim(), view(), view({ icon: 'moon' }), 0, false)
  expect(s.tracks.kT).toBeUndefined()
  expect(s.change?.max).toBeUndefined()
})
