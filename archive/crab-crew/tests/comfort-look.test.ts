import { expect, test } from 'claude-code/testing'

import {
  approach,
  blockCells,
  cellWidth,
  effortAtX,
  fillFor,
  hitAt,
  levelColorAt,
  mix,
  place,
  segWidth,
  fitCells,
  exactRow,
  framed,
  center,
  isSafeEmoji,
} from '../hooks/comfort/look'

test('cell width counts emoji as 2', () => {
  expect(cellWidth('opus')).toBe(4)
  expect(cellWidth('🤖')).toBe(2)
  expect(cellWidth('▐ opus ▌')).toBe(8)
  expect(cellWidth('✎')).toBe(1)
  // the symbols the bar draws are 1 cell; only emoji presentation and a VS16 make 2
  for (const narrow of ['✓', '✦', '✧', '✻', '★', '▸', '▾', '●', '○', '◂', '█', '░', '▒', '▓', '├', '└', '…', '✗']) {
    expect(cellWidth(narrow)).toBe(1)
  }
  for (const wide of ['⚡', '✅', '❌', '⭐', '✨', '☕', '🧙', '日']) {
    expect(cellWidth(wide)).toBe(2)
  }
  expect(cellWidth('☁️')).toBe(2)
  expect(cellWidth('🐻‍❄️')).toBe(2)
  expect(cellWidth('👩‍💻 ok')).toBe(5)
})

test('colour mix goes from one end to the other', () => {
  expect(mix('#000000', '#FFFFFF', 0)).toBe('#000000')
  expect(mix('#000000', '#FFFFFF', 1)).toBe('#FFFFFF')
  expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080')
})

test('the gradient matches at every level', () => {
  expect(levelColorAt(fillFor('low'))).toBe('#22D3EE')
  expect(levelColorAt(fillFor('high'))).toBe('#A3E635')
  expect(levelColorAt(fillFor('max'))).toBe('#F43F5E')
})

test('blocks fill up to the level and the half block shows mid-animation', () => {
  const high = blockCells(fillFor('high'))
  expect(high.filter(cell => cell.isFilled)).toHaveLength(15)
  expect(blockCells(2.5)[2]?.char).toBe('▌')
  expect(blockCells(0).every(cell => !cell.isFilled)).toBe(true)
})

test('the animation approaches its target and snaps', () => {
  let value = 0
  for (let frame = 0; frame < 40; frame += 1) {
    value = approach(value, 20)
  }
  expect(value).toBe(20)
  expect(approach(19.9, 20)).toBe(20)
})

test('clickable regions follow the real text width', () => {
  const regions = place([
    [{ text: '▸', action: { kind: 'toggle' } }, { text: ' ' }, { text: '🤖', action: { kind: 'settings' } }],
    [
      { text: 'effort ' },
      { text: '█████', action: { kind: 'effort', value: 'low' } },
      { text: ' ' },
      { text: '█████', action: { kind: 'effort', value: 'medium' } },
    ],
  ])
  expect(hitAt(regions, 0, 0)?.id).toBe('toggle')
  expect(hitAt(regions, 3, 0)?.id).toBe('settings')
  expect(hitAt(regions, 9, 1)?.id).toBe('effort:low')
  expect(hitAt(regions, 12, 1)).toBeUndefined()
  expect(effortAtX(regions, 14)).toBe('medium')
  expect(effortAtX(regions, 0)).toBe('low')
  expect(effortAtX(regions, 99)).toBe('medium')
})

test('the card always has the same width on every row', () => {
  for (const width of [40, 52, 64, 80]) {
    for (const name of ['dev8', 'a really very long terminal window name', '🤖🤖🤖']) {
      const rows = framed({
        width,
        title: [{ text: '🐯' }, { text: ' ' }, { text: name }, { text: ' ✎' }],
        corner: [{ text: '▾' }],
        rows: [[{ text: '   MODEL' }], [{ text: 'x'.repeat(200) }], []],
        color: '#3F3F46',
      })
      for (const row of rows) {
        expect(segWidth(row)).toBe(width)
      }
    }
  }
})

test('cutting by cells never splits an emoji and centres correctly', () => {
  expect(fitCells('ab🤖cd', 3)).toBe('ab…')
  expect(fitCells('ab🤖cd', 4)).toBe('ab…')
  expect(fitCells('ab🤖cd', 5)).toBe('ab🤖…')
  expect(cellWidth(fitCells('🤖🤖🤖', 5))).toBeLessThan(6)
  expect(center('low', 5)).toBe(' low ')
  expect(center('xhigh', 5)).toBe('xhigh')
  expect(exactRow([{ text: 'abc' }], 6).map(seg => seg.text).join('')).toBe('abc   ')
})

test('only truly wide emoji go in the frame', () => {
  expect(isSafeEmoji('🤖')).toBe(true)
  expect(isSafeEmoji('★')).toBe(false)
  expect(isSafeEmoji('ab')).toBe(false)
})

test('every glyph the bar and the strip draw has the width the layout counts on', () => {
  for (const one of ['⇠', '◀', '▶', '│', '✦', '▓', '▒', '░', '·', '‹', '›', '╭', '╮', '╰', '╯', '┬', '┴', '─', '━', '✎']) {
    expect(cellWidth(one)).toBe(1)
  }
  for (const gem of ['◇', '◈', '◆']) {
    expect(cellWidth(gem)).toBe(1)
  }
  expect(cellWidth('█▏▎▍▌▋▊▉░')).toBe(9)
})
