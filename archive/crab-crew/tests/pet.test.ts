import { expect, test } from 'claude-code/testing'
import {
  BODY_ROWS, LEG_ROWS, MINI_ROWS, MODEL_TINT, PET_MAX_ANIMATED, PET_STYLES, REACTIONS,
  gridErrors, miniPet, petEnd, petMarkup, petSnapshot, pix, startChange, startGlance, startLift, startReaction,
} from '../hooks/card/pet'
import type { PetStyle, PetView } from '../hooks/card/pet'

const NOW = 100_000

function view(over: Partial<PetView> = {}): PetView {
  return {
    style: 'energy', level: 1, lifted: false, legFrame: 0,
    change: null, reaction: null, glance: null, lift: null,
    now: NOW, reduced: false, theme: 'dark', idPrefix: 'c1_', ...over,
  }
}

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length
const ANIM = /<animate(Transform)?\b/g
const BLINK = /<animate id="[^"]*blink"[^>]*\/>/g
const noBlink = (s: string): string => s.replace(BLINK, '')
/** elements carrying animation (each animated node has its <animate*> children first) */
const animatedEls = (s: string): number => count(noBlink(s), /<(g|ellipse)\b[^>]*>(?=<animate)/g)
const durs = (s: string): number[] => [...noBlink(s).matchAll(/\bdur="([\d.]+)s"/g)].map((m) => Number(m[1]))
/** every translate on the sprite: static attributes and animateTransform values */
function translates(s: string): number[] {
  const out: number[] = []
  for (const m of s.matchAll(/translate\(([^)]*)\)/g)) out.push(...(m[1] ?? '').split(/[\s,]+/).map(Number))
  for (const m of s.matchAll(/<animateTransform[^>]*type="translate"[^>]*values="([^"]*)"/g))
    out.push(...(m[1] ?? '').split(/[;\s]+/).map(Number))
  return out
}
const LEVELS = [0, 1, 2, 3, 4]

/** A busy sweep: every style, every level pair, sampled through the change, plus reactions, glance and lift. */
function* sweep(reduced = false): Generator<string> {
  for (const style of PET_STYLES) {
    for (const a of LEVELS) {
      for (const b of LEVELS) {
        if (a === b) continue
        for (const el of [0, 40, 90, 150, 220, 290]) {
          yield petMarkup(view({ style, level: b, change: { level: a, style, start: NOW - el }, reduced }))
        }
      }
      for (const sx of [1, 0.45]) {
        for (const el of [0, 30, 80, 140, 200, 260, 330, 390]) {
          yield petMarkup(view({ style, level: a, reaction: { level: a, start: NOW - el, sx }, reduced }))
        }
      }
      for (const el of [0, 50, 120, 250]) {
        yield petMarkup(view({ style, level: a, glance: { dir: -1, start: NOW - el }, reduced }))
        yield petMarkup(view({ style, level: a, lifted: true, legFrame: 1, lift: { start: NOW - el }, reduced }))
      }
    }
  }
}

test('grids are the right size and the load-time check is silent', () => {
  expect(gridErrors()).toEqual([])
  expect(BODY_ROWS).toHaveLength(12)
  for (const r of BODY_ROWS) expect(r).toMatch(/^[.X]{24}$/)
  for (const g of Object.values(LEG_ROWS)) {
    expect(g).toHaveLength(4)
    for (const r of g) expect(r).toMatch(/^[.X]{24}$/)
  }
  expect(MINI_ROWS).toHaveLength(8)
  for (const r of MINI_ROWS) expect(r).toMatch(/^[.X]{12}$/)
})

test('pix turns runs into 1px-high rects', () => {
  expect(pix(['.XX.', 'X..X'], -2, -1)).toBe('M-1 -1h2v1h-2zM-2 0h1v1h-1zM1 0h1v1h-1z')
})

test('every style x level renders distinct markup; medium is the shared reference pose', () => {
  const all = new Map<string, string>()
  for (const style of PET_STYLES) {
    const mine = new Set<string>()
    for (const L of LEVELS) {
      const s = petMarkup(view({ style, level: L }))
      expect(s).toContain('fill="#D97757"') // same coral on every level
      mine.add(s)
      all.set(`${style}${L}`, s)
    }
    expect(mine.size).toBe(5)
  }
  expect(new Set(all.values()).size).toBe(13) // 15 cells, the three mediums are one pose
  expect(all.get('mood1')).toBe(all.get('energy1'))
  expect(all.get('gear1')).toBe(all.get('energy1'))
  const g = (k: string): string => all.get(k) ?? ''
  // energy: silhouette
  expect(g('energy0')).toContain('<g transform="translate(0 4)">') // sitting
  expect(g('energy0')).toContain('M8 -14h4v1h-4z') // the z
  expect(g('energy2')).toContain('<g transform="translate(1 0)">') // leaning
  expect(g('energy3')).toContain('<g transform="translate(2 0)">')
  expect(g('energy3')).toContain('M-20 -5h3v1h-3z') // speed lines
  expect(g('energy4')).toContain('<g transform="translate(0 -3)">') // floating
  expect(g('energy4')).toContain('c1_cg') // aura
  expect(g('energy4')).toContain('rx="6"') // smaller shadow
  // mood: face
  expect(g('mood0')).toContain('#8A4026')
  expect(g('mood2')).toContain('M-7 -8h2v1h-2z')
  expect(g('mood3')).toContain('#DCEEFF')
  expect(g('mood4')).toContain('#FFF4E6')
  expect(g('mood4')).toContain('c1_eg')
  // gear: one accessory
  expect(g('gear0')).toContain('M4 -14h4v1h-4z')
  expect(g('gear2')).toContain('M-8 -8h16v1h-16z')
  expect(g('gear3')).toContain('M-7 -8h4v4h-4z')
  expect(g('gear3')).not.toContain('M-6 -7h2v2h-2zM4 -7h2v2h-2z" fill="#1A1A1C"') // eyes hidden by the goggles
  expect(g('gear4')).toContain('#B4482C')
  // fractional (dragging) levels round; out-of-range clamps
  expect(petMarkup(view({ level: 2.4 }))).toBe(g('energy2'))
  expect(petMarkup(view({ level: 9 }))).toBe(g('energy4'))
})

test('at rest the only animation is the self-referencing blink', () => {
  const s = petMarkup(view({ idPrefix: 'k7_' }))
  expect(count(s, ANIM)).toBe(1)
  expect(s).toContain('<animate id="k7_blink" attributeName="opacity" values="1;0;0;1" keyTimes="0;.07;.93;1" dur=".14s" begin="10s;k7_blink.end+13s"/>')
  // finished records leave no trace
  const done = petMarkup(view({ level: 4, change: { level: 0, style: 'energy', start: NOW - 1000 }, reaction: { level: 4, start: NOW - 1000 }, glance: { dir: 1, start: NOW - 1000 }, lift: { start: NOW - 1000 } }))
  expect(count(done, ANIM)).toBe(1)
  expect(petEnd(view({ change: { level: 0, style: 'energy', start: NOW - 1000 } }))).toBeNull()
  expect(petEnd(view({ reaction: { level: 4, start: NOW - 100 } }))).toBe(NOW + 300)
})

test('every id and reference carries the prefix, so cards never collide', () => {
  const busy = (prefix: string, style: PetStyle): string =>
    petMarkup(view({ idPrefix: prefix, style, level: 4, change: { level: 3, style, start: NOW - 50 }, reaction: { level: 4, start: NOW - 20 }, glance: { dir: 1, start: NOW - 100 } }))
  const ids = (s: string): string[] => [...s.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1] ?? '')
  const refs = (s: string): string[] => [
    ...[...s.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1] ?? ''),
    ...[...s.matchAll(/;([A-Za-z0-9_]+)\.end/g)].map((m) => m[1] ?? ''),
  ]
  for (const style of PET_STYLES) {
    const a = busy('cardA_', style)
    const b = busy('cardB_', style)
    expect(ids(a).length).toBeGreaterThan(1)
    for (const id of [...ids(a), ...refs(a)]) expect(id.startsWith('cardA_')).toBe(true)
    for (const id of [...ids(b), ...refs(b)]) expect(id.startsWith('cardB_')).toBe(true)
    for (const r of refs(a)) expect(ids(a)).toContain(r)
  }
  expect(petMarkup(view({ idPrefix: 'a.b-c:' }))).toContain('id="a_b_c_blink"')
})

test('pixel integrity: only whole-pixel translates, all sprite moves discrete, never a scale', () => {
  let n = 0
  for (const s of sweep()) {
    for (const v of translates(s)) expect(Number.isInteger(v)).toBe(true)
    expect(s).not.toMatch(/scale/)
    for (const m of s.matchAll(/<animateTransform[^>]*>/g)) expect(m[0]).toContain('calcMode="discrete"')
    n++
  }
  expect(n).toBeGreaterThan(500)
})

test('durations: transformation <= 300 ms, reaction <= 400 ms, glance 300 ms with a 2 px offset', () => {
  for (const style of PET_STYLES) {
    for (const a of LEVELS) {
      for (const b of LEVELS) {
        const s = petMarkup(view({ style, level: b, change: { level: a, style, start: NOW } }))
        for (const d of durs(s)) expect(d).toBeLessThanOrEqual(0.3)
      }
      for (const sx of [1, 0.45]) {
        const s = petMarkup(view({ style, level: a, reaction: { level: a, start: NOW, sx } }))
        expect(durs(s).length).toBeGreaterThan(0)
        for (const d of durs(s)) expect(d).toBeLessThanOrEqual(0.4)
      }
    }
  }
  for (const r of REACTIONS) {
    expect(r.dur).toBeLessThanOrEqual(400)
    expect(r.f.length).toBeLessThanOrEqual(9)
  }
  for (const dir of [-1, 1] as const) {
    const s = petMarkup(view({ glance: { dir, start: NOW } }))
    expect(s).toContain('dur="0.3s"')
    const vs = /type="translate" values="([^"]*)"/.exec(s)?.[1] ?? ''
    const xs = vs.split(';').map((p) => Number(p.split(' ')[0]))
    expect(Math.max(...xs.map(Math.abs))).toBe(2)
    expect(xs.every((x) => Math.sign(x) !== -dir)).toBe(true)
  }
  const lift = petMarkup(view({ lifted: true, lift: { start: NOW } }))
  for (const d of durs(lift)) expect(d).toBeLessThanOrEqual(0.3)
  expect(lift).toContain('values="0 0;0 -1;0 -2"')
})

test('level changes: no overshoot, at most 4 animated elements, exits ease out and are shorter', () => {
  for (const style of PET_STYLES) {
    for (const a of LEVELS) {
      for (const b of LEVELS) {
        if (a === b) continue
        const s = petMarkup(view({ style, level: b, change: { level: a, style, start: NOW } }))
        expect(animatedEls(s)).toBeLessThanOrEqual(PET_MAX_ANIMATED)
        // pose moves (sit, lean, float, gear drop) run monotonically from start to end: nothing goes past
        for (const m of s.matchAll(/type="translate" values="([^"]*)"/g)) {
          const pts = (m[1] ?? '').split(';').map((p) => p.split(' ').map(Number))
          if (style === 'mood' && pts.length === 3) continue // the 1 px bob is a kick, not a pose move
          const first = pts[0] ?? [], last = pts[pts.length - 1] ?? []
          for (let j = 0; j < 2; j++) {
            const lo = Math.min(first[j] ?? 0, last[j] ?? 0), hi = Math.max(first[j] ?? 0, last[j] ?? 0)
            for (const p of pts) {
              expect(p[j] ?? 0).toBeGreaterThanOrEqual(lo)
              expect(p[j] ?? 0).toBeLessThanOrEqual(hi)
            }
          }
        }
        for (const m of s.matchAll(/<animate attributeName="opacity" values="([\d.]+);([\d.]+)"[^>]*keySplines="([^"]*)" dur="([\d.]+)s"/g)) {
          if (m[0].includes('#')) continue
          const fadeIn = Number(m[2]) > Number(m[1])
          if (Number(m[1]) !== 0 && Number(m[1]) !== 1) continue // shadow opacity, an on-screen change
          expect(m[3]).toBe('.16 1 .3 1')
          expect(m[4]).toBe(fadeIn ? '0.225' : '0.18')
        }
      }
    }
  }
  // energy medium -> max: rise, aura in, shadow shrinks; legs swap at once (no fading sprite layer)
  const s = petMarkup(view({ level: 4, change: { level: 1, style: 'energy', start: NOW } }))
  expect(s).toContain('values="0 0;0 -1;0 -2;0 -3"')
  expect(s).toContain('attributeName="rx" values="10;6"')
  expect(s).toContain(pix(LEG_ROWS.dangle, -12, 3))
  expect(s).not.toContain(pix(LEG_ROWS.stand, -12, 3))
  // gear: the new accessory drops 4 px into place as it fades in
  expect(petMarkup(view({ style: 'gear', level: 2, change: { level: 1, style: 'gear', start: NOW } }))).toContain('values="0 -4;0 -3;0 -2;0 -1;0 0"')
  // lift and change in one swap share the budget
  const both = petMarkup(view({ level: 4, lifted: true, change: { level: 0, style: 'energy', start: NOW }, lift: { start: NOW } }))
  expect(animatedEls(both)).toBeLessThanOrEqual(PET_MAX_ANIMATED)
})

test('apply reactions: one beat, <= 2 px overshoot, <= 9 keyframe points, scaled travel in the bar', () => {
  for (const L of LEVELS) {
    for (const sx of [1, 0.45]) {
      const s = petMarkup(view({ level: L, reaction: { level: L, start: NOW, sx } }))
      const m = /type="translate" values="([^"]*)"/.exec(noBlink(s))
      expect(m).not.toBeNull()
      const pts = (m?.[1] ?? '').split(';').map((p) => p.split(' ').map(Number))
      expect(pts.length).toBeLessThanOrEqual(9)
      expect(pts[0]).toEqual([0, 0])
      expect(pts[pts.length - 1]).toEqual([0, 0])
      const xs = pts.map((p) => p[0] ?? 0), ys = pts.map((p) => p[1] ?? 0)
      if (L === 0) { expect(Math.max(...ys)).toBeLessThanOrEqual(2); expect(Math.min(...ys)).toBeGreaterThanOrEqual(-2) } // crouch-and-rise
      if (L === 1) expect(ys.every((y) => y >= 0 && y <= 2)).toBe(true) // one 2 px nod
      if (L === 2) { expect(Math.max(...xs)).toBe(sx === 1 ? 4 : 2); expect(Math.min(...xs)).toBe(0) } // short dash, no backswing
      if (L === 3) expect(Math.max(...ys)).toBe(0) // one hop, never below rest
      if (L === 4) expect(Math.max(...xs.map(Math.abs))).toBeLessThanOrEqual(sx === 1 ? 4 : 2) // small loop
    }
  }
})

test('kicks start from the value on screen: re-triggering never snaps', () => {
  const same = (a: Record<string, number[]>, b: Record<string, number[]>): void => {
    for (const k of Object.keys(a)) expect([k, b[k]]).toEqual([k, a[k]])
  }
  for (const L of LEVELS) {
    for (const el of [40, 110, 180, 260]) {
      const v1 = view({ level: L, reaction: { level: L, start: NOW - el, sx: 1 } })
      const v2 = { ...v1, reaction: startReaction(v1, NOW) }
      same(petSnapshot(v1, NOW), petSnapshot(v2, NOW))
      // and the emitted curve starts at the static value
      const s = noBlink(petMarkup(v2))
      const m = /<g transform="translate\(([-\d]+ [-\d]+)\)"><animateTransform[^>]*values="([^;"]*)/.exec(s)
      if (m) expect(m[2]).toBe(m[1])
    }
  }
  // a nod interrupted by a dash: the nod channel settles back, nothing jumps
  const nod = view({ level: 1, reaction: { level: 1, start: NOW - 80 } })
  const mid = petSnapshot(nod, NOW).rN ?? [0]
  expect(Math.abs(mid[0] ?? 0)).toBeGreaterThan(0)
  const dash = { ...nod, level: 2, reaction: { ...startReaction(nod, NOW), level: 2 } }
  same({ rN: mid }, { rN: petSnapshot(dash, NOW).rN ?? [] })
  // glance re-trigger the other way
  const g1 = view({ glance: { dir: 1, start: NOW - 120 } })
  const g2 = { ...g1, glance: startGlance(g1, -1, NOW) }
  same(petSnapshot(g1, NOW), petSnapshot(g2, NOW))
  // lift flipped back mid-way
  const l1 = view({ lifted: true, lift: { start: NOW - 90 } })
  const l2 = { ...l1, lifted: false, lift: startLift(l1, NOW) }
  same(petSnapshot(l1, NOW), petSnapshot(l2, NOW))
})

test('level changes re-target from the pose on screen', () => {
  for (const style of PET_STYLES) {
    // low -> medium, then high while the first change runs
    const v1 = view({ style, level: 1, change: { level: 0, style, start: NOW - 120 } })
    const v2 = { ...v1, level: 2, change: startChange(v1, NOW) }
    const a = petSnapshot(v1, NOW), b = petSnapshot(v2, NOW)
    for (const k of Object.keys(a)) {
      // an accessory about to drop in waits 4 px up at opacity 0: invisible, so not a jump
      const hidden = k.startsWith('gY_') && (a['opX_' + k.slice(3)] ?? [0])[0] === 0
      if (!hidden) expect([k, b[k]]).toEqual([k, a[k]])
    }
    expect(petEnd(v2)).toBe(NOW + 300)
  }
  // a run of quick level changes, each from the one before mid-flight: always continuous
  for (const style of PET_STYLES) {
    let v = view({ style, level: 0 })
    for (const [i, L] of [1, 3, 4, 2, 0, 4].entries()) {
      const t = NOW + i * 90
      const before = petSnapshot(v, t)
      v = { ...v, now: t, level: L, change: startChange({ ...v, now: t }, t) }
      const after = petSnapshot(v, t)
      for (const k of ['pBY', 'pPX', 'pFY', 'rN']) expect([style, L, k, after[k]]).toEqual([style, L, k, before[k]])
    }
  }
})

test('reduced motion: nothing moves, the pose is drawn static', () => {
  for (const s of sweep(true)) {
    expect(count(s, ANIM)).toBe(0)
    expect(s.includes('blink')).toBe(false)
  }
  const max = petMarkup(view({ reduced: true, level: 4, change: { level: 0, style: 'energy', start: NOW - 50 }, lifted: true, lift: { start: NOW - 50 }, legFrame: 1 }))
  expect(max).toContain('<g transform="translate(0 -3)">') // float, static
  expect(max).toContain('<g transform="translate(0 -2)">') // lift, static
  expect(max).toContain('c1_cg') // aura present
  expect(max).toContain(pix(LEG_ROWS.dangle, -12, 3)) // no walk frame
  expect(petEnd(view({ reduced: true, reaction: { level: 1, start: NOW } }))).toBeNull()
})

test('mini pet: 12x8 at whole pixels in the model tint', () => {
  expect(MODEL_TINT).toEqual({ haiku: '#D9A441', sonnet: '#2FA38A', opus: '#D97757', fable: '#8B7CF6' })
  const s = miniPet(14.4, 13, MODEL_TINT.sonnet, '#1A1A1C')
  expect(s).toBe(`<g transform="translate(14 13)"><path d="${pix(MINI_ROWS, 0, 0)}" fill="#2FA38A" shape-rendering="crispEdges"/><path d="M3 1h1v2h-1zM8 1h1v2h-1z" fill="#1A1A1C" shape-rendering="crispEdges"/></g>`)
})

test('sitting down: the old legs hold until the body lands on the tucked feet, then the grid swaps (no floating feet)', () => {
  const stand = pix(LEG_ROWS.stand, -12, 3), tuck = pix(LEG_ROWS.tuck, -12, 3), dangle = pix(LEG_ROWS.dangle, -12, 3)
  for (const [from, oldD] of [[1, stand], [2, pix(LEG_ROWS.run, -12, 3)], [3, pix(LEG_ROWS.sprint, -12, 3)], [4, dangle]] as const) {
    const s0 = petMarkup(view({ level: 0, change: { level: from, style: 'energy', start: NOW } }))
    // the old legs are drawn, with one discrete swap to the tucked feet at the step where pBY lands on 4
    const m = /<path d="([^"]+)" fill="#D97757" shape-rendering="crispEdges"><animate attributeName="d" values="([^";]+);([^"]+)" keyTimes="0;([\d.]+)" calcMode="discrete"/.exec(s0)
    expect(m?.[1]).toBe(oldD)
    expect(m?.[3]).toBe(tuck)
    const swap = Number(m?.[4]) * 280
    const by = /values="0 0;0 1;0 2;0 3;0 4" keyTimes="([^"]+)"/.exec(s0)
    expect(by).not.toBeNull()
    expect(Math.abs(swap - Number((by?.[1] ?? '').split(';').at(-1)) * 280)).toBeLessThan(1)
    // mid-way (body not down yet): still the old legs; after the swap: the tucked feet, static
    const mid = petMarkup(view({ level: 0, change: { level: from, style: 'energy', start: NOW - 100 } }))
    expect(mid).toContain(`<path d="${oldD}"`)
    const late = petMarkup(view({ level: 0, change: { level: from, style: 'energy', start: NOW - 290 } }))
    expect(late).toContain(`<path d="${tuck}" fill="#D97757" shape-rendering="crispEdges"/>`)
  }
  // standing up and every other swap: the new legs at once
  const up = petMarkup(view({ level: 1, change: { level: 0, style: 'energy', start: NOW } }))
  expect(up).toContain(`<path d="${stand}" fill="#D97757" shape-rendering="crispEdges"/>`)
  expect(up).not.toContain('attributeName="d"')
})

test('the knob slide takes one element: a change with max 3 animates at most 3 inside the pet', () => {
  for (const style of PET_STYLES) {
    for (const a of LEVELS) {
      for (const b of LEVELS) {
        if (a === b) continue
        const s = petMarkup(view({ style, level: b, change: { level: a, style, start: NOW, max: PET_MAX_ANIMATED - 1 } }))
        const legSwap = s.includes('attributeName="d"') ? 1 : 0
        expect(animatedEls(s) + legSwap).toBeLessThanOrEqual(PET_MAX_ANIMATED - 1)
      }
    }
  }
})

test('the max loop never jumps more than 2 px per frame; a bob from a nod steps one pixel at a time; the brow follows the glance', () => {
  const loop = REACTIONS[4]?.f ?? []
  for (let i = 1; i < loop.length; i++) {
    const a = loop[i - 1] ?? [], b = loop[i] ?? []
    expect(Math.max(Math.abs((b[1] ?? 0) - (a[1] ?? 0)), Math.abs((b[2] ?? 0) - (a[2] ?? 0)))).toBeLessThanOrEqual(2)
  }
  // a nod 2 px down, then a mood level change: the bob walks 2, 1, 0
  const nod = view({ style: 'mood', level: 1, reaction: { level: 1, start: NOW - 80 } })
  expect(petSnapshot(nod, NOW).rN).toEqual([2])
  const ch = { ...nod, level: 2, change: startChange(nod, NOW) }
  const m = /type="translate" values="(0 2;[^"]*)"/.exec(petMarkup(ch))
  const ys = (m?.[1] ?? '').split(';').map((p) => Number(p.split(' ')[1]))
  for (let i = 1; i < ys.length; i++) expect(Math.abs((ys[i] ?? 0) - (ys[i - 1] ?? 0))).toBeLessThanOrEqual(1)
  // mood high glancing: the brow sits inside the glance group, so it moves with the eyes
  const g = petMarkup(view({ style: 'mood', level: 2, glance: { dir: -1, start: NOW } }))
  // glance translate -> blink group (eyes) -> brow, all inside the glance group
  expect(g).toMatch(/dur="0\.3s"[^>]*\/><g><animate id="[^"]*blink"[^>]*\/>(<path[^>]*\/>)+<\/g><path d="M-7 -8h2v1h-2z/)
})
