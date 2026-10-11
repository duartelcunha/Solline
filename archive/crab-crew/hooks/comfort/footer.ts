// The usage gauges on the footer row, at the right end of the line that shows plan / auto mode.
// Bars only, no numbers: the colour says the state. Plain text (no animation): the footer cannot host a Client.

import type { Usage } from './bar'
import { type Seg, fitCells, segWidth } from './look'

export const GAUGE_GREY = '#71717A'
export const GAUGE_AMBER = '#C9A24A'
export const GAUGE_RED = '#D9706A'
export const GAUGE_TRACK = '#3F3F46'
const LABEL = '#71717A'
const GAP = '  '
/**
 * Cells kept free on the left: the widest mode text (`⏵⏵ accept edits on (shift+tab to cycle)`, 39),
 * the ` · ` the engine may put before this site, and a safe gap.
 */
export const LEFT_RESERVE = 46

/** Grey while fine, a muted amber from 70%, a soft red from 90%; an unknown value is just the track. */
export const toneOf = (percent: number | null): string =>
  percent === null ? GAUGE_TRACK : percent >= 90 ? GAUGE_RED : percent >= 70 ? GAUGE_AMBER : GAUGE_GREY

/** A reset time in a fixed 4 cells (`2h10`, `59m `, `wed `), so the row never shifts when it changes. */
export const resetCell = (reset: string): string => ` · ${fitCells(reset, 4, '').padEnd(4)}`

type Step = { cells: number; resets: boolean; week: boolean; five: boolean; ctx: boolean }
/** From the fullest row to nothing; a gauge at 70% or more stays at every step (as 3 cells at the last). */
export const STEPS: readonly Step[] = [
  { cells: 8, resets: true, week: true, five: true, ctx: true },
  { cells: 8, resets: false, week: true, five: true, ctx: true },
  { cells: 5, resets: false, week: true, five: true, ctx: true },
  { cells: 3, resets: false, week: true, five: true, ctx: true },
  { cells: 3, resets: false, week: false, five: true, ctx: true },
  { cells: 3, resets: false, week: false, five: false, ctx: true },
  { cells: 3, resets: false, week: false, five: false, ctx: false },
]

/** `━━━━━───`: the filled part in the state's colour, the rest as a dark track. */
export function bar(percent: number | null, cells: number): Seg[] {
  const value = percent ?? 0
  const filled = Math.max(0, Math.min(cells, Math.round((value / 100) * cells)))
  const segs: Seg[] = []
  if (filled > 0) {
    segs.push({ text: '━'.repeat(filled), color: toneOf(percent) })
  }
  if (cells - filled > 0) {
    segs.push({ text: '─'.repeat(cells - filled), color: GAUGE_TRACK })
  }
  return segs
}

export function stepSegs(usage: readonly Usage[], step: Step): Seg[] {
  const segs: Seg[] = []
  for (const one of usage) {
    if (one.key === 'cost') {
      if (step.ctx) {
        segs.push(...(segs.length > 0 ? [{ text: GAP }] : []), { text: `$${(one.usd ?? 0).toFixed(2)}`, color: LABEL })
      }
      continue
    }
    const isHot = (one.percent ?? -1) >= 70
    const shown = one.key === 'wk' ? step.week : one.key === '5h' ? step.five : step.ctx
    if (!shown && !isHot) {
      continue
    }
    if (segs.length > 0) {
      segs.push({ text: GAP })
    }
    segs.push({ text: `${one.key} `, color: LABEL }, ...bar(one.percent, step.cells))
    if (step.resets && isHot && one.reset !== '') {
      segs.push({ text: resetCell(one.reset), color: LABEL })
    }
  }
  return segs
}

/**
 * The fullest step that fits in `room` cells. Growing back needs 2 spare cells (hysteresis), so a width
 * right at an edge does not flip the row back and forth. `last` is the step drawn before (-1: none yet).
 */
export function footerGauges(usage: readonly Usage[], room: number, last: number): { segs: Seg[]; step: number } {
  const widths = STEPS.map(step => segWidth(stepSegs(usage, step)))
  const firstFitting = (space: number): number => {
    const at = widths.findIndex(w => w <= space)
    return at < 0 ? STEPS.length : at
  }
  let step = firstFitting(room)
  if (last >= 0 && step < last) {
    step = Math.min(last, firstFitting(room - 2))
  }
  if (step >= STEPS.length) {
    return { segs: [], step }
  }
  const segs = stepSegs(usage, STEPS[step] as Step)
  return { segs, step }
}
