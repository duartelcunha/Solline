import { expect, test } from 'claude-code/testing'

import type { Usage } from '../hooks/comfort/bar'
import { GAUGE_AMBER, GAUGE_GREY, GAUGE_RED, STEPS, footerGauges, stepSegs } from '../hooks/comfort/footer'
import { segWidth } from '../hooks/comfort/look'

const U = (ctx: number | null, five: number | null, week: number | null): Usage[] => [
  { key: 'ctx', percent: ctx, reset: '' },
  { key: '5h', percent: five, reset: '2h10' },
  { key: 'wk', percent: week, reset: 'wed' },
]
const text = (segs: { text: string }[]) => segs.map(s => s.text).join('')

test('every step fits its room, at every width, and nothing shows a percentage', () => {
  for (const usage of [U(42, 18, 61), U(95, 75, 92), U(null, null, null)]) {
    for (let room = 0; room <= 160; room += 1) {
      const { segs } = footerGauges(usage, room, -1)
      expect(segWidth(segs)).toBeLessThanOrEqual(room)
      expect(text(segs)).not.toContain('%')
    }
  }
})

test('the ladder shrinks in order: bars, then wk, then 5h, then nothing', () => {
  const usage = U(42, 18, 61)
  const widths = STEPS.map(step => segWidth(stepSegs(usage, step)))
  for (let at = 1; at < widths.length; at += 1) {
    expect(widths[at] as number).toBeLessThanOrEqual(widths[at - 1] as number)
  }
  expect(text(footerGauges(usage, 200, -1).segs)).toContain('wk ━')
  const small = text(footerGauges(usage, 10, -1).segs)
  expect(small).toContain('ctx')
  expect(small).not.toContain('wk')
  expect(footerGauges(usage, 3, -1).segs).toEqual([])
})

test('a gauge at 70% or more never drops, and only a hot one shows its reset', () => {
  const usage = U(10, 20, 91)
  const tight = text(footerGauges(usage, 20, -1).segs)
  expect(tight).toContain('wk')
  const wide = text(footerGauges(usage, 200, -1).segs)
  expect(wide).toContain(' · wed ')
  expect(wide).not.toContain('2h10')
})

test('colours follow the state: grey, muted amber from 70%, soft red from 90%', () => {
  const colours = (p: number) => footerGauges(U(p, null, null), 200, -1).segs.map(s => s.color)
  expect(colours(50)).toContain(GAUGE_GREY)
  expect(colours(75)).toContain(GAUGE_AMBER)
  expect(colours(95)).toContain(GAUGE_RED)
})

test('hysteresis: a width right at an edge does not flip the row back and forth', () => {
  const usage = U(42, 18, 91)
  const edge = segWidth(stepSegs(usage, STEPS[0] as never))
  const shrunk = footerGauges(usage, edge - 1, 0)
  expect(shrunk.step).toBe(1)
  // one cell back is not enough to grow again; two spare cells are
  expect(footerGauges(usage, edge, shrunk.step).step).toBe(1)
  expect(footerGauges(usage, edge + 2, shrunk.step).step).toBe(0)
})
