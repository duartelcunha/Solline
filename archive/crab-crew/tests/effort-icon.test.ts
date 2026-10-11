import { expect, test } from 'claude-code/testing'
import {
  DEFAULT_ICON,
  EFFORT_ICONS,
  ICON_EASE,
  ICON_MAX_ANIMATED,
  ICON_MS,
  iconEnd,
  iconMarkup,
  iconSnapshot,
  LIGHT_INK,
  startIconChange,
  startIconReaction,
  type EffortIconKind,
  type IconView,
} from '../hooks/card/effort-icon'

const view = (over: Partial<IconView> = {}): IconView => ({
  kind: 'star', level: 2, model: 'opus', change: null, reaction: null, now: 0, reduced: false, theme: 'dark', idPrefix: 'k_i', ...over,
})
const LEVELS = [0, 1, 2, 3, 4]
const anims = (s: string): number => (s.match(/<animate/g) ?? []).length
const durs = (s: string): number[] => [...s.matchAll(/\bdur="([\d.]+)s"/g)].map(m => Number(m[1]))
const nums = (s: string): number[] => (s.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)

/** Elements that carry an animation (parents of <animate>/<animateTransform>), by a tiny tag walk. */
function animatedElements(s: string): number {
  const stack: number[] = []
  const parents = new Set<number>()
  let id = 0
  for (const m of s.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
    const [, close, name, self] = m
    if (close) { stack.pop(); continue }
    if (name === 'animate' || name === 'animateTransform') {
      const p = stack[stack.length - 1]
      if (p !== undefined) parents.add(p)
      continue
    }
    if (!self) stack.push(id++)
    else id++
  }
  return parents.size
}

/** `kind` drawn at `to`, `ms` into a change from `from` (started at 0 from the rest pose). */
function changing(kind: EffortIconKind, from: number, to: number, ms: number, over: Partial<IconView> = {}): IconView {
  const prev = view({ kind, level: from, ...over })
  return view({ kind, level: to, change: startIconChange(prev, 0), now: ms, ...over })
}

test('every kind renders at every level, in both themes, with distinct markup per level', () => {
  expect(EFFORT_ICONS).toEqual(['star', 'pet', 'moon', 'dumbbell', 'wave'])
  for (const kind of EFFORT_ICONS) {
    for (const theme of ['dark', 'light'] as const) {
      const out = LEVELS.map(level => iconMarkup(view({ kind, level, theme })))
      for (const s of out) {
        expect(s.length).toBeGreaterThan(40)
        expect(s.length).toBeLessThan(4_000)
        expect(s).not.toContain('NaN')
        expect(s).not.toContain('undefined')
      }
      expect([kind, theme, new Set(out).size]).toEqual([kind, theme, 5])
    }
  }
})

test('nothing moves at rest: no animation without a record, nor after it ends', () => {
  for (const kind of EFFORT_ICONS) {
    for (const level of LEVELS) {
      expect([kind, level, anims(iconMarkup(view({ kind, level })))]).toEqual([kind, level, 0])
      expect(iconEnd(view({ kind, level }))).toBeNull()
    }
    /* settled = after the record's end */
    const done = changing(kind, 0, 4, (iconEnd(changing(kind, 0, 4, 0)) ?? 0) + 1)
    expect([kind, anims(iconMarkup(done))]).toEqual([kind, 0])
    expect(iconEnd(done)).toBeNull()
    /* the settled change draws exactly the target */
    expect(iconMarkup(done)).toBe(iconMarkup(view({ kind, level: 4 })))
    const beat = startIconReaction(view({ kind, level: 3 }), 0)
    const reacted = view({ kind, level: 3, reaction: beat, now: (iconEnd(view({ kind, level: 3, reaction: beat })) ?? 0) + 1 })
    expect([kind, anims(iconMarkup(reacted))]).toEqual([kind, 0])
  }
})

test('reduced motion: the target at once, no animation', () => {
  for (const kind of EFFORT_ICONS) {
    const c = changing(kind, 0, 4, 50, { reduced: true })
    const r = { ...c, reaction: startIconReaction(view({ kind, level: 4 }), 40) }
    expect(anims(iconMarkup(c))).toBe(0)
    expect(anims(iconMarkup(r))).toBe(0)
    expect(iconMarkup(c)).toBe(iconMarkup(view({ kind, level: 4, reduced: true })))
    expect(iconEnd(r)).toBeNull()
    /* an icon change too */
    const sw = view({ kind, level: 2, reduced: true, change: startIconChange(view({ kind: kind === 'star' ? 'moon' : 'star' }), 0), now: 50 })
    expect(anims(iconMarkup(sw))).toBe(0)
  }
})

test('a level change lasts <= 280 ms, eases out, animates <= 4 elements (<= max when given)', () => {
  expect(ICON_MS.change).toBeLessThanOrEqual(280)
  for (const kind of EFFORT_ICONS) {
    if (kind === 'pet') continue /* pixel art: a level swaps the pose like a sprite frame, nothing tweens */
    for (const a of LEVELS) {
      for (const b of LEVELS) {
        if (a === b) continue
        const v = changing(kind, a, b, 1)
        const s = iconMarkup(v)
        expect([kind, a, b, anims(s) > 0]).toEqual([kind, a, b, true])
        for (const d of durs(s)) expect(d).toBeLessThanOrEqual(0.28)
        for (const ks of s.matchAll(/keySplines="([^"]*)"/g)) for (const c of (ks[1] ?? '').split(';')) expect(c).toBe(ICON_EASE.out)
        expect([kind, a, b, animatedElements(s) <= ICON_MAX_ANIMATED]).toEqual([kind, a, b, true])
        expect((iconEnd(v) ?? 0) - 0).toBeLessThanOrEqual(280)
        /* the card passes 3 when the knob slides too */
        const tight = { ...v, change: v.change ? { ...v.change, max: 3 } : null }
        expect([kind, a, b, animatedElements(iconMarkup(tight)) <= 3]).toEqual([kind, a, b, true])
      }
    }
  }
})

test('an icon change cross-fades: the old glyph out (shorter), the new one in; 2 elements', () => {
  for (const from of EFFORT_ICONS) {
    for (const to of EFFORT_ICONS) {
      if (from === to) continue
      const v = view({ kind: to, level: 1, change: startIconChange(view({ kind: from, level: 3 }), 0), now: 10 })
      const s = iconMarkup(v)
      expect([from, to, animatedElements(s)]).toEqual([from, to, 2])
      expect(s).toContain(`dur="${ICON_MS.exit / 1000}s"`)
      expect(s).toContain(`dur="${ICON_MS.change / 1000}s"`)
      /* after the exit only the new glyph remains (fading in to the end) */
      expect(iconMarkup({ ...v, now: ICON_MS.change + 1 })).toBe(iconMarkup(view({ kind: to, level: 1 })))
    }
  }
  expect(ICON_MS.exit).toBe(ICON_MS.change * 0.8)
})

test('a change caught mid-way starts from the values on screen', () => {
  for (const kind of EFFORT_ICONS) {
    const mid = changing(kind, 0, 4, 90)
    const shown = iconSnapshot(mid, 90)
    const next = startIconChange(mid, 90)
    expect(next.level).toBe(4)
    for (const [k, v] of Object.entries(next.from ?? {})) expect([kind, k, v]).toEqual([kind, k, shown[k]])
    /* the first keyframe of each new animate is what the old markup draws at that moment */
    const before = iconMarkup(mid)
    const after = iconMarkup(view({ kind, level: 1, change: next, now: 90 }))
    const firstD = /<animate attributeName="d" values="([^;"]*);/.exec(after)?.[1]
    if (firstD) {
      const drawn = [...before.matchAll(/ d="([^"]*)"/g)].map(m => m[1] ?? '')
      const close = drawn.some(d => {
        const a = nums(d), b = nums(firstD)
        return a.length === b.length && a.every((x, i) => Math.abs(x - (b[i] ?? 0)) <= 0.011)
      })
      expect([kind, close]).toEqual([kind, true])
    }
  }
})

test('the acknowledgement beat: one beat <= 280 ms, ease out, <= 2 elements, re-triggered from the screen', () => {
  expect(ICON_MS.reaction).toBeLessThanOrEqual(280)
  for (const kind of EFFORT_ICONS) {
    for (const level of LEVELS) {
      const v = view({ kind, level, reaction: startIconReaction(view({ kind, level }), 0), now: 1 })
      const s = iconMarkup(v)
      expect([kind, level, anims(s) > 0]).toEqual([kind, level, true])
      for (const d of durs(s)) expect(d).toBeLessThanOrEqual(0.28)
      for (const ks of s.matchAll(/keySplines="([^"]*)"/g)) for (const c of (ks[1] ?? '').split(';')) expect(c).toBe(ICON_EASE.out)
      expect([kind, level, animatedElements(s) <= 2]).toEqual([kind, level, true])
      expect((iconEnd(v) ?? 0)).toBeLessThanOrEqual(280)
      /* a level change and the reaction together stay within 4 */
      const both = { ...changing(kind, level === 0 ? 4 : 0, level, 1), reaction: startIconReaction(view({ kind, level }), 0) }
      both.change = both.change ? { ...both.change, start: 0 } : null
      expect([kind, level, animatedElements(iconMarkup(both)) <= ICON_MAX_ANIMATED]).toEqual([kind, level, true])
    }
    /* a second beat mid-way starts where the first one is */
    const first = view({ kind, level: 4, reaction: startIconReaction(view({ kind, level: 4 }), 0), now: 100 })
    const shown = iconSnapshot(first, 100)
    const again = startIconReaction(first, 100)
    for (const k of ['rs', 'ry', 'rf', 'rr']) if (again.from?.[k]) expect([kind, k, again.from[k]]).toEqual([kind, k, shown[k]])
  }
  /* the star pulses (scale), the dumbbell and the pet hop (translate) */
  const r = (kind: EffortIconKind): string => iconMarkup(view({ kind, level: 4, reaction: startIconReaction(view({ kind, level: 4 }), 0), now: 1 }))
  expect(r('star')).toContain('type="scale"')
  expect(r('dumbbell')).toContain('type="translate"')
  expect(r('pet')).toContain('type="translate"')
})

test('ids are prefixed (sanitised) and every reference resolves inside the fragment', () => {
  for (const kind of EFFORT_ICONS) {
    for (const level of LEVELS) {
      const cases = [
        view({ kind, level, idPrefix: 'card-7:x' }),
        view({ kind, level, idPrefix: 'card-7:x', reaction: startIconReaction(view({ kind, level }), 0), now: 1 }),
      ]
      for (const v of cases) {
        const s = iconMarkup(v)
        const ids = [...s.matchAll(/\bid="([^"]*)"/g)].map(m => m[1] ?? '')
        for (const id of ids) expect(id.startsWith('card_7_x')).toBe(true)
        for (const m of s.matchAll(/url\(#([^)]*)\)/g)) expect(ids).toContain(m[1] ?? '')
      }
    }
  }
})

test('the star is coral; the max level glows; a model tint reaches the neutral icons only', () => {
  const star = iconMarkup(view({ kind: 'star', level: 4 }))
  expect(star).toContain('stroke="#D97757"')
  expect(star).toContain('feGaussianBlur')
  expect(iconMarkup(view({ kind: 'star', level: 3 }))).not.toContain('feGaussianBlur')
  expect(iconMarkup(view({ kind: 'star', model: 'haiku' }))).toBe(iconMarkup(view({ kind: 'star', model: 'fable' })))
  expect(iconMarkup(view({ kind: 'wave', model: 'haiku' }))).not.toBe(iconMarkup(view({ kind: 'wave', model: 'fable' })))
  /* the light theme uses each model's own clean ink, not a neutral mixed with the tint */
  for (const [model, ink] of Object.entries(LIGHT_INK)) expect(iconMarkup(view({ kind: 'wave', model: model as never, theme: 'light' }))).toContain(`stroke="${ink}"`)
  /* removed kinds fall back to the default, the pet (since 0.7.0) */
  expect(DEFAULT_ICON).toBe('pet')
  for (const gone of ['flame', 'rings', 'dots']) expect(iconMarkup(view({ kind: gone as never }))).toBe(iconMarkup(view({ kind: 'pet' })))
  /* an unknown kind or level falls back */
  expect(iconMarkup(view({ kind: 'sparkly' as never }))).toBe(iconMarkup(view({ kind: 'pet' })))
  expect(iconMarkup(view({ level: 9 }))).toBe(iconMarkup(view({ level: 4 })))
  expect(iconMarkup(view({ level: Number.NaN }))).toBe(iconMarkup(view({ level: 0 })))
})

/* ---- contrast: every icon at every level reads on its knob (WCAG non-text 3:1) ---- */

/** the knob's thumb (svg.ts THEMES pill) */
const KNOB_BG = { dark: '#3A3A3F', light: '#FFFFFF' } as const
const lum = (h: string): number => {
  const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0)
}
const contrast = (a: string, b: string): number => {
  const [x = 0, y = 0] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
/**
 * The edge ink of every solid mark (a shape with no opacity below 1 and no
 * blur): its stroke when stroked, else its fill. Glows, halos and the faint
 * moon outline are decoration and are skipped.
 */
function solidInks(s: string): string[] {
  const inks: string[] = []
  for (const m of s.matchAll(/<(path|circle|ellipse|rect)\b([^>]*)>/g)) {
    const a = m[2] ?? ''
    const num = (name: string): number => Number(new RegExp(`\\s${name}="([\\d.]+)"`).exec(a)?.[1] ?? 1)
    if (a.includes('filter=') || num('opacity') < 1) continue
    const stroke = /\bstroke="(#[0-9A-Fa-f]{6})"/.exec(a)?.[1]
    const fill = /\bfill="(#[0-9A-Fa-f]{6})"/.exec(a)?.[1]
    if (stroke) {
      if (num('stroke-opacity') >= 1) inks.push(stroke)
    } else if (fill) inks.push(fill)
  }
  return inks
}

test('contrast: every icon x level x model has >= 3:1 against its knob in both themes', () => {
  const report: string[] = []
  for (const theme of ['dark', 'light'] as const) {
    for (const model of ['haiku', 'sonnet', 'opus', 'fable'] as const) {
      for (const kind of EFFORT_ICONS) {
        if (kind === 'pet') continue /* pixel art in its own palette (tests/pet.test.ts) */
        for (const level of LEVELS) {
          const inks = solidInks(iconMarkup(view({ kind, level, model, theme })))
          expect([theme, model, kind, level, inks.length > 0]).toEqual([theme, model, kind, level, true])
          for (const ink of inks) {
            const c = contrast(ink, KNOB_BG[theme])
            if (c < 3) report.push(`${theme} ${model} ${kind} L${level} ${ink} ${c.toFixed(2)}:1`)
          }
        }
      }
    }
  }
  expect(report).toEqual([])
})

test('the light full moon is a pale disc with a thin ink outline, never a dark disc', () => {
  for (const model of ['haiku', 'sonnet', 'opus', 'fable'] as const) {
    const s = iconMarkup(view({ kind: 'moon', level: 4, model, theme: 'light' }))
    const lit = /<path d="[^"]*" fill="(#[0-9A-F]{6})" stroke="(#[0-9A-F]{6})" stroke-width="([\d.]+)"/.exec(s)
    expect(lit).not.toBeNull()
    expect(lum(lit?.[1] ?? '#000000')).toBeGreaterThan(0.6) // a light disc
    expect(lit?.[2]).toBe(LIGHT_INK[model])
    expect(Number(lit?.[3])).toBeLessThanOrEqual(1.2)
  }
})
