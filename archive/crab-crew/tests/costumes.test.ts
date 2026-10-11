/**
 * Crew pets (hooks/crew/costumes.ts): the 12 role costumes, the status looks,
 * the only idle loop (working, not reduced), ids, theme contrast, and the
 * strict gate a model-made costume must pass before it is drawn.
 */
import { expect, test } from 'claude-code/testing'
import { BODY_ROWS, CORAL, LEG_ROWS } from '../hooks/card/pet'
import {
  BREATH_MS,
  COSTUMES,
  GROUND,
  PLAIN,
  breathBegin,
  costumeCells,
  costumeGridJson,
  costumeGridPrompt,
  costumeStoreKey,
  crewPetMarkup,
  crewPetSvg,
  modelTint,
  parseCostumeReply,
  renderGeneratedCostume,
  safeId,
  validateCostumeGrid,
  type CrewPetOpts,
} from '../hooks/crew/costumes'
import { ROLES, type CrewStatus } from '../hooks/crew/roles'

const base = (o: Partial<CrewPetOpts> = {}): CrewPetOpts => ({
  role: 'Explorer',
  model: 'haiku',
  status: 'done',
  theme: 'dark',
  reduced: false,
  idPrefix: 'row-1',
  ...o,
})

const GOOD = { rows: ['..aa..', '.abba.', '..aa..'], colors: { a: '#ff8800', b: '#222' }, anchor: 'head' }

test('all 12 roles draw distinct costumes for the same model, status and theme', () => {
  const marks = ROLES.map(role => crewPetMarkup(base({ role })))
  expect(new Set(marks).size).toBe(12)
  const plain = crewPetMarkup(base({ role: null }))
  for (const m of marks) expect(m).not.toBe(plain)
})

test('every id starts with the sanitised prefix; the mapping is injective and never empty', () => {
  for (const status of ['working', 'done', 'error', 'interrupted'] as CrewStatus[]) {
    const m = crewPetMarkup(base({ status, idPrefix: 'tool-use_1.x' }))
    const ids = [...m.matchAll(/id="([^"]+)"/g)].map(x => x[1] ?? '')
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(id.startsWith(safeId('tool-use_1.x'))).toBe(true)
    for (const id of ids) expect(/^[A-Za-z][A-Za-z0-9_]*$/.test(id)).toBe(true)
  }
  const keys = ['a-b', 'a.b', 'a_b', 'ab', '', 'c', '1']
  expect(new Set(keys.map(safeId)).size).toBe(keys.length)
  expect(safeId('')).toBe('c_')
})

test('the breathing loop appears only while working and not reduced', () => {
  const cases: [CrewStatus, boolean, boolean][] = [
    ['working', false, true],
    ['working', true, false],
    ['done', false, false],
    ['error', false, false],
    ['interrupted', false, false],
  ]
  for (const [status, reduced, loops] of cases) {
    const m = crewPetMarkup(base({ status, reduced }))
    expect(m.includes('<animateTransform')).toBe(loops)
    expect(m.includes('repeatCount')).toBe(loops)
  }
  const w = crewPetMarkup(base({ status: 'working' }))
  expect(w).toContain(`dur="${BREATH_MS / 1000}s"`)
  expect(w).toContain('calcMode="discrete"')
  expect(w).toContain('values="0 0;0 1;0 0"')
})

test('the loop keeps its phase across redraws (begin set back by the elapsed time)', () => {
  expect(breathBegin(undefined)).toBe('0s')
  expect(breathBegin(0)).toBe('0s')
  expect(breathBegin(1200)).toBe('-1.200s')
  expect(breathBegin(BREATH_MS * 3 + 600)).toBe('-0.600s')
  expect(breathBegin(Number.NaN)).toBe('0s')
  expect(crewPetMarkup(base({ status: 'working', phaseMs: 3_000 }))).toContain('begin="-0.600s"')
})

test('error adds the red mark; only error has it', () => {
  expect(crewPetMarkup(base({ status: 'error' }))).toContain('#E5484D')
  for (const status of ['working', 'done', 'interrupted'] as CrewStatus[]) expect(crewPetMarkup(base({ status }))).not.toContain('#E5484D')
})

test('interrupted greys the pet and its costume out (no coral, no costume colour)', () => {
  for (const role of ROLES) {
    const m = crewPetMarkup(base({ role, status: 'interrupted', model: 'opus' }))
    expect(m).not.toContain(CORAL)
    for (const [, hex] of m.matchAll(/fill="(#[0-9A-F]{6})"/g)) {
      const h = hex ?? ''
      if (h === '#1A1A1C') continue // the eyes stay as they are
      expect(h.slice(1, 3) === h.slice(3, 5) && h.slice(3, 5) === h.slice(5, 7)).toBe(true)
    }
  }
})

test('an unknown role is the plain pet, or wears its validated generated grid', () => {
  const plain = crewPetMarkup(base({ role: 'mystery' }))
  expect(plain).toBe(crewPetMarkup(base({ role: null })))
  expect(crewPetMarkup(base({ role: 'mystery', costumeGrid: PLAIN }))).toBe(plain)
  expect(crewPetMarkup(base({ role: 'mystery', costumeGrid: { rows: ['zz'], colors: { a: '#fff' } } }))).toBe(plain)
  const dressed = crewPetMarkup(base({ role: 'mystery', costumeGrid: GOOD }))
  expect(dressed).not.toBe(plain)
  expect(dressed).toContain('#FF8800')
  expect(dressed).toContain('#222222')
})

test('model tint: aliases and ids by family, unknown is the muted grey', () => {
  expect(modelTint('haiku')).toBe('#D9A441')
  expect(modelTint('claude-sonnet-5-5')).toBe('#2FA38A')
  expect(modelTint('inherit')).toBe('#939398')
  expect(modelTint('', 'light')).toBe('#6B6B70')
})

test('whole-pixel, crisp markup and a standalone svg sized by scale', () => {
  for (const role of ROLES) {
    const m = crewPetMarkup(base({ role, status: 'working' }))
    for (const [, d] of m.matchAll(/ d="([^"]+)"/g)) expect(/^[-0-9MhvzHV ]+$/.test(d ?? '')).toBe(true)
    for (const p of m.match(/<path [^>]*>/g) ?? []) expect(p).toContain('shape-rendering="crispEdges"')
  }
  const svg = crewPetSvg(base({ scale: 2 }))
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg).toContain('width="76" height="56"')
  expect(svg.length).toBeLessThan(131072)
})

/* ---------- contrast: every costume reads on both grounds and on the coral body ---------- */

const lum = (hex: string): number => {
  const v = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * (v[0] ?? 0) + 0.7152 * (v[1] ?? 0) + 0.0722 * (v[2] ?? 0)
}
const contrast = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const cellsOf = (rows: readonly string[], ox: number, oy: number): Set<string> => {
  const s = new Set<string>()
  rows.forEach((r, y) => [...r].forEach((c, x) => c === 'X' && s.add(`${ox + x},${oy + y}`)))
  return s
}
const BODY = new Set([...cellsOf(BODY_ROWS, -12, -9), ...cellsOf(LEG_ROWS.stand, -12, 3)])
const EYES = new Set(['-6,-7', '-5,-7', '-6,-6', '-5,-6', '4,-7', '5,-7', '4,-6', '5,-6'])
const TINTS = ['#D9A441', '#2FA38A', '#D97757', '#8B7CF6']

test('costume edges: >= 2.4:1 against bare coral on the body, >= 2:1 against the ground off it, both themes', () => {
  const bad: string[] = []
  for (const theme of ['dark', 'light'] as const) {
    for (const role of ROLES) {
      const cells = costumeCells(role, theme)
      const at = new Map(cells.map(c => [`${c.x},${c.y}`, c.color]))
      for (const c of cells) {
        const on = BODY.has(`${c.x},${c.y}`)
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const n = `${c.x + dx},${c.y + dy}`
          if (at.has(n) || EYES.has(n) || BODY.has(n) !== on) continue
          const bg = on ? CORAL : GROUND[theme]
          for (const col of c.color === 'tint' ? TINTS : [c.color]) {
            const r = contrast(col, bg)
            if (r < (on ? 2.4 : 2)) bad.push(`${role}/${theme} ${col} on ${bg}: ${r.toFixed(2)}`)
          }
        }
      }
    }
  }
  expect(bad).toEqual([])
})

test('the reviewer monocle and the coder mic stay visible on the coral body', () => {
  const rim = costumeCells('Reviewer', 'dark').filter(c => BODY.has(`${c.x},${c.y}`))
  expect(rim.length).toBeGreaterThan(0)
  for (const c of rim) expect(contrast(c.color, CORAL)).toBeGreaterThan(2.4)
  // the model-tinted mic tip is framed by dark pixels on every side that is body
  const mic = costumeCells('Coder', 'dark')
  const tip = mic.find(c => c.color === 'tint')
  expect(tip).toBeDefined()
  const at = new Set(mic.map(c => `${c.x},${c.y}`))
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) expect(at.has(`${(tip?.x ?? 0) + dx},${(tip?.y ?? 0) + dy}`)).toBe(true)
  expect(Object.keys(COSTUMES).sort()).toEqual([...ROLES].sort())
})

/* ---------- the gate a generated costume passes ---------- */

test('the validator accepts a good grid, normalises colours, with or without a fence or prose', () => {
  const g = validateCostumeGrid(GOOD)
  expect(g).toEqual({ rows: GOOD.rows, colors: { a: '#FF8800', b: '#222222' }, anchor: 'head' })
  expect(validateCostumeGrid(JSON.stringify(GOOD))).toEqual(g)
  expect(validateCostumeGrid('```json\n' + JSON.stringify(GOOD) + '\n```')).toEqual(g)
  expect(validateCostumeGrid('Sure! Here it is: ' + JSON.stringify(GOOD) + ' Enjoy.')).toEqual(g)
  expect(parseCostumeReply('{"rows": [oops]} then ' + JSON.stringify(GOOD))).toEqual(g)
  const noAnchor = { rows: ['a'], colors: { a: '#f00' } }
  expect(validateCostumeGrid(noAnchor)?.anchor).toBe('head')
  expect(validateCostumeGrid({ ...noAnchor, anchor: 'face' })?.anchor).toBe('face')
  expect(validateCostumeGrid({ rows: Array(8).fill('a'.repeat(24)), colors: { a: '#123456' } })).not.toBeNull()
})

test('the validator rejects every malformed or hostile grid', () => {
  const bad: unknown[] = [
    { rows: Array(9).fill('a'), colors: { a: '#fff' } },
    { rows: ['a'.repeat(25)], colors: { a: '#fff' } },
    { rows: ['aa', 'a'], colors: { a: '#fff' } },
    { rows: ['abcd'], colors: { a: '#111', b: '#222', c: '#333', d: '#444' } },
    { rows: ['a'], colors: { a: 'red' } },
    { rows: ['a'], colors: { a: '#GGG' } },
    { rows: ['a'], colors: { a: '#f00"/><script>' } },
    { rows: ['"/><script>'], colors: { a: '#fff' } },
    { rows: ['ab'], colors: { a: '#fff' } },
    { rows: [''], colors: { a: '#fff' } },
    { rows: [], colors: { a: '#fff' } },
    { rows: ['....'], colors: { a: '#fff' } },
    { rows: ['a'], colors: { a: '#fff' }, extra: 1 },
    { rows: ['a'], colors: { a: '#fff' }, anchor: 'hat' },
    { rows: ['a'], colors: { a: '#fff' }, anchor: null },
    { rows: ['a'], colors: { a: '#fff' }, anchor: 3 },
    { rows: ['a'], colors: { aa: '#fff' } },
    JSON.parse('{"rows":["a"],"colors":{"__proto__":"#fff"}}'),
    { rows: ['a'], colors: {} },
    { rows: ['a'], colors: [] },
    { rows: 'a', colors: { a: '#fff' } },
    [GOOD],
    null,
    undefined,
    42,
    '',
    'I cannot draw that.',
    '{"rows":["a"],"colors":{"a":"#fff"}',
    JSON.stringify({ ...GOOD, pad: 'x'.repeat(5000) }),
    'x'.repeat(30_000) + JSON.stringify(GOOD),
  ]
  for (const b of bad) expect(validateCostumeGrid(b)).toBeNull()
  for (const b of bad) expect(renderGeneratedCostume(b)).toBe('')
})

test('rendered generated markup only ever carries integers and normalised hex', () => {
  const m = renderGeneratedCostume(GOOD)
  expect(m.length).toBeGreaterThan(0)
  for (const [, c] of m.matchAll(/fill="([^"]+)"/g)) expect(/^#[0-9A-F]{6}$/.test(c ?? '')).toBe(true)
  for (const [, d] of m.matchAll(/ d="([^"]+)"/g)) expect(/^[-0-9Mhvz ]+$/.test(d ?? '')).toBe(true)
  expect(renderGeneratedCostume(GOOD, { grey: true })).not.toContain('#FF8800')
})

test('store key, json form and the prompt (inputs quoted as data, the validator format)', () => {
  expect(costumeStoreKey(' DB-Migrator ')).toBe('costume:db-migrator')
  const g = validateCostumeGrid(GOOD)
  expect(g).not.toBeNull()
  if (g) expect(validateCostumeGrid(JSON.parse(JSON.stringify(costumeGridJson(g))))).toEqual(g)
  const p = costumeGridPrompt('db "migrator"', 'Migrate the\nusers table')
  expect(p).toContain(JSON.stringify('db "migrator"'))
  expect(p).toContain('"Migrate the users table"')
  expect(p).toContain('ONLY one JSON object')
  expect(p).toContain('"colors"')
  expect(p).toContain('"anchor"')
  expect(costumeGridPrompt('x'.repeat(500), 'y'.repeat(5000)).length).toBeLessThan(1500)
  expect(costumeGridPrompt('')).toContain('"unknown"')
})
