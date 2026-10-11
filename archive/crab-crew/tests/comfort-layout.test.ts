import { expect, test } from 'claude-code/testing'

import { type BarProps, previewRows } from '../hooks/comfort/bar'
import { type Region, cellWidth, place } from '../hooks/comfort/look'

const PROPS = (isOpen: boolean, ultra = false): BarProps => ({
  isOpen,
  model: 'opus',
  models: [
    { alias: 'fable', label: 'fable 5.1' },
    { alias: 'opus', label: 'opus 5.5' },
    { alias: 'sonnet', label: 'sonnet 5.5' },
    { alias: 'haiku', label: 'haiku 4.5' },
  ],
  effort: 'high',
  ultra,
  message: { text: '⎇ main  ·  ✎ 3 files this session', tone: 'dim' },
  canBack: true,
})

/** Clickable things, merged per row and action, in drawing order. */
function zones(regions: readonly Region[]): Region[][] {
  const rows = new Map<number, Region[]>()
  for (const region of regions) {
    const list = rows.get(region.y) ?? []
    const last = list[list.length - 1]
    // the effort meter is one slider: its cells set different levels, but it is one target
    const same = last !== undefined && last.x1 === region.x0 && (last.id === region.id || (last.action.kind === region.action.kind && region.action.kind === 'effort'))
    if (same && last !== undefined) {
      last.x1 = region.x1
    } else {
      list.push({ ...region })
    }
    rows.set(region.y, list)
  }
  return [...rows.values()]
}

test('breathing room: every two clickable things on a row are at least 2 cells apart, never overlapping', () => {
  for (const columns of [30, 40, 50, 58, 80, 96, 120, 200]) {
    for (const isOpen of [false, true]) {
      for (const ultra of [false, true]) {
        const rows = previewRows(PROPS(isOpen, ultra), columns)
        for (const row of rows) {
          expect(cellWidth(row.map(s => s.text).join(''))).toBeLessThanOrEqual(columns - 1)
        }
        for (const list of zones(place(rows))) {
          for (let i = 1; i < list.length; i += 1) {
            const a = list[i - 1] as Region
            const b = list[i] as Region
            const gap = b.x0 - a.x1
            if (gap < 2) {
              throw new Error(`at ${columns} columns (open ${isOpen}, ultra ${ultra}), row ${b.y}: "${a.id}" [${a.x0},${a.x1}) and "${b.id}" [${b.x0},${b.x1}) are only ${gap} apart`)
            }
          }
        }
      }
    }
  }
})


test('the model slots never move when the current model changes (only the current one knows its version)', () => {
  const props = (model: string): BarProps => ({
    ...PROPS(true),
    model,
    models: PROPS(true).models.map(m => ({ alias: m.alias, label: m.alias === model ? `${m.alias} 5.5` : m.alias })),
  })
  for (const columns of [80, 120, 160]) {
    // each model's click slot (its pill's place), from the drawn row
    const at = (model: string) =>
      zones(place(previewRows(props(model), columns)))
        .flat()
        .filter(z => z.action.kind === 'model')
        .map(z => `${z.id}@${z.x0}-${z.x1}`)
    expect(at('sonnet')).toEqual(at('haiku'))
    expect(at('opus')).toEqual(at('fable'))
  }
})

test('the crew of crabs never pushes the controls, never passes the width, and adds no rows', () => {
  const crew = [
    { id: 'a', label: 'Find where the auth code lives', status: 'running' as const, durationMs: 0, name: 'scout', color: '#38BDF8', accessory: '🔎', startedAt: 0, endedAt: 0 },
    { id: 'b', label: 'Review the changes', status: 'done' as const, durationMs: 12_000, name: 'reviewer', color: '#34D399', accessory: '🔬', startedAt: 0, endedAt: 0 },
    { id: 'c', label: 'Translate the strings', status: 'egg' as const, durationMs: 0, name: '', color: '', accessory: '', startedAt: 0, endedAt: 0 },
  ]
  for (const columns of [40, 60, 80, 120, 200]) {
    for (const isOpen of [false, true]) {
      const plain = previewRows(PROPS(isOpen), columns)
      const withCrew = previewRows({ ...PROPS(isOpen), crew }, columns)
      expect(withCrew.length).toBe(plain.length)
      for (const row of withCrew) {
        expect(cellWidth(row.map(s => s.text).join(''))).toBeLessThanOrEqual(columns - 1)
      }
      // every clickable thing stays exactly where it was
      const spots = (rows: typeof plain) => place(rows).map(z => `${z.id}@${z.y}:${z.x0}-${z.x1}`).join(' ')
      expect(spots(withCrew)).toBe(spots(plain))
    }
  }
})
