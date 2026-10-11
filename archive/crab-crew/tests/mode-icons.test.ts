import { expect, test } from 'claude-code/testing'
import { MODE_ICON, MODE_ICON_SIZE, MODE_ICON_STROKE, modeIcon, modeIconPaths, renderModeIcon } from '../hooks/card/mode-icons'
import { MODES, MODE_NAME } from '../hooks/card/parse'

/** Absolute points a path visits (M/L/H/V/A/C/Z with their relative forms), to bound the drawing. */
function points(d: string): [number, number][] {
  const out: [number, number][] = []
  const toks = d.match(/[MLHVACZmlhvacz]|-?\d*\.?\d+/g) ?? []
  let i = 0, x = 0, y = 0, sx = 0, sy = 0, cmd = 'M'
  const num = (): number => Number(toks[i++])
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i] ?? '')) cmd = toks[i++] ?? 'M'
    const rel = cmd === cmd.toLowerCase()
    switch (cmd.toUpperCase()) {
      case 'M': case 'L': { const a = num(), b = num(); x = rel ? x + a : a; y = rel ? y + b : b; if (cmd.toUpperCase() === 'M') { sx = x; sy = y; cmd = rel ? 'l' : 'L' } break }
      case 'H': { const a = num(); x = rel ? x + a : a; break }
      case 'V': { const a = num(); y = rel ? y + a : a; break }
      case 'A': { num(); num(); num(); num(); num(); const a = num(), b = num(); x = rel ? x + a : a; y = rel ? y + b : b; break }
      case 'C': { num(); num(); num(); num(); const a = num(), b = num(); x = rel ? x + a : a; y = rel ? y + b : b; break }
      case 'Z': x = sx; y = sy; break
      default: i++
    }
    out.push([x, y])
  }
  return out
}

test('one icon per mode, in the 16 px box with a stroke margin', () => {
  expect(Object.keys(MODE_ICON).sort()).toEqual([...MODES].sort())
  expect(MODE_ICON_SIZE).toBe(16)
  expect(MODE_ICON_STROKE).toBe(1.5)
  for (const m of MODES) {
    expect(MODE_ICON[m].length).toBeGreaterThan(1)
    for (const d of MODE_ICON[m]) {
      for (const [x, y] of points(d)) {
        expect([m, x >= 0.75 && x <= 15.25, y >= 0.75 && y <= 15.25]).toEqual([m, true, true])
      }
    }
  }
  /* four different drawings */
  expect(new Set(MODES.map(m => MODE_ICON[m].join(' '))).size).toBe(4)
})

test('icons render: stroked paths in the given colour, 1.5 px, round caps and joins, no fill', () => {
  for (const m of MODES) {
    const s = modeIconPaths(m, '#123456')
    const paths = s.match(/<path [^>]*\/>/g) ?? []
    expect(paths).toHaveLength(MODE_ICON[m].length)
    for (const p of paths) {
      expect(p).toContain('fill="none"')
      expect(p).toContain('stroke="#123456"')
      expect(p).toContain('stroke-width="1.5"')
      expect(p).toContain('stroke-linecap="round"')
      expect(p).toContain('stroke-linejoin="round"')
    }
  }
})

test('the builder places the box, carries a <title> tooltip, extra attributes and SMIL children', () => {
  const g = modeIcon('default', '#fff', { x: 10.123, y: 4, title: 'Ask <&>', attrs: 'class="cc-mode"', anim: '<animate/>' })
  expect(g).toStartWith('<g transform="translate(10.12 4)" class="cc-mode"><title>Ask &lt;&amp;&gt;</title><animate/><path ')
  expect(g).toEndWith('</g>')
  expect(modeIcon('plan', '#000')).toStartWith('<g><path ')
  /* standalone preview names the mode by its visible name */
  for (const m of MODES) {
    const svg = renderModeIcon(m, '#000', 32)
    expect(svg).toContain('viewBox="0 0 16 16"')
    expect(svg).toContain('width="32"')
    expect(svg).toContain(`aria-label="${MODE_NAME[m]}"`)
  }
})

test('visible names: Plan, Auto, Ask, Edits (the values stay internal)', () => {
  expect(MODES).toEqual(['plan', 'auto', 'default', 'acceptEdits'])
  expect(MODES.map(m => MODE_NAME[m])).toEqual(['Plan', 'Auto', 'Ask', 'Edits'])
})
