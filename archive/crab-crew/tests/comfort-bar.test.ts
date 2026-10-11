import { expect, mock, test } from 'claude-code/testing'

import { LEVEL_COLORS, MODEL_COLORS, cellWidth, segWidth } from '../hooks/comfort/look'
import { barMessage, modelLabel, timeLeft, toUsage } from '../hooks/comfort/helpers'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 140,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

const MODEL_ROW = {
  key: 'model',
  label: 'Model',
  kind: 'choice',
  value: 'claude-opus-5-5',
  options: ['default', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
  provider: { plugin: 'engine', tier: 'core' },
  isLocked: false,
}

const NOW = Date.parse('2026-10-08T03:00:00Z')
const USAGE = (ctx: number, five: number, week: number) => ({
  startedAt: NOW,
  context: { percent: ctx, window: 200_000 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: five, resetsAt: '2026-10-08T05:10:00Z' },
    { kind: 'seven_day', percentUsed: week, resetsAt: '2026-10-11T10:00:00Z' },
  ],
  cost: { usd: 1.42 },
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the kit's test body types are not exported
async function start($: any, on: any, opts: { env?: Record<string, string>; usage?: unknown; settings?: unknown; files?: Record<string, string> } = {}) {
  const commands: string[] = []
  const envSets: string[] = []
  mock.env(on, { USERPROFILE: 'C:/Users/me', ...(opts.env ?? {}) })
  const clock = mock.clock(on, { now: NOW })
  on('session.start', async (_$: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'session-b' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', async () => ({ value: opts.usage ?? USAGE(42, 18, 61) }))
  on('session.messages', async () => ({ value: [] }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('command.register', async (_$: unknown, e: any) => ({ value: { command: e.name } }))
  on('command.run', async (_$: unknown, e: any) => {
    commands.push(`${e.command} ${e.args ?? ''}`.trim())
    return { text: '' }
  })
  on('config.list', async () => ({ value: [MODEL_ROW] }))
  const configSets: string[] = []
  on('config.set', async (_$: unknown, e: any) => {
    configSets.push(e.value)
    return { value: e.value }
  })
  on('env.set', async (_$: unknown, e: any) => {
    envSets.push(`${e.name}=${e.value}`)
    return { value: undefined }
  })
  on('settings.read', async () => ({ value: opts.settings ?? { modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } } }))
  on('tool.register', async (_$: unknown, e: any) => ({ value: { tool: `mcp__crab-crew__${e.name}` } }))
  const seen: string[] = []
  const files: Record<string, string> = {
    'C:/Users/me/.claude/settings.json': JSON.stringify({ model: 'opus' }, null, 2),
    ...(opts.files ?? {}),
  }
  // only settings.json exists here; every other file fails, as before (the window registry then skips its wait)
  const norm = (path: string) => path.replace(/\\/g, '/')
  on('fs.read', async (_$: unknown, e: any) => {
    seen.push(`read ${e.path}`)
    if (!(norm(e.path) in files)) {
      throw new Error('no such file')
    }
    return { value: files[norm(e.path)] }
  })
  on('fs.write', async (_$: unknown, e: any) => {
    seen.push(`write ${e.path}`)
    if (!(norm(e.path) in files)) {
      throw new Error('read-only in this test')
    }
    files[norm(e.path)] = e.text ?? ''
    return { value: undefined }
  })
  await $.session.start({ cwd: 'C:/projects/demo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'crab-crew', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.resize({ columns: 140, rows: 20, in: 'bar' })
  await ui.advance(2500)
  return { ui, clock, commands, envSets, files, seen, configSets }
}

/** Each drawn row as plain text. */
async function lines(ui: any): Promise<string[]> {
  const flat = (node: unknown): string =>
    typeof node === 'string' ? node : ((node as { children?: unknown[] }).children ?? []).map(flat).join('')
  return (((await ui.drawn({ in: 'bar' })) as { children?: unknown[] }).children ?? []).map(flat)
}

async function click(ui: any, text: string, nth = 0) {
  const rows = await lines(ui)
  let seen = 0
  for (let y = 0; y < rows.length; y += 1) {
    const at = (rows[y] ?? '').indexOf(text)
    if (at >= 0) {
      if (seen === nth) {
        const x = cellWidth((rows[y] ?? '').slice(0, at))   // by cells: the width in cells, not characters
        await ui.pointer({ type: 'down', x, y, button: 'left', in: 'bar' })
        await ui.pointer({ type: 'up', x, y, button: 'left', in: 'bar' })
        await ui.advance(800)
        return
      }
      seen += 1
    }
  }
  throw new Error(`"${text}" is not drawn: ${JSON.stringify(rows)}`)
}

/** A click on the nth crystal (whatever its phase shows: ◇ ◈ ◆). */
async function clickGem(ui: any, nth = 0) {
  const rows = await lines(ui)
  let seen = 0
  for (let y = 0; y < rows.length; y += 1) {
    const m = /[◇◈◆]/.exec(rows[y] ?? '')
    if (m !== null) {
      if (seen === nth) {
        const x = cellWidth((rows[y] ?? '').slice(0, m.index))
        await ui.pointer({ type: 'down', x, y, button: 'left', in: 'bar' })
        await ui.pointer({ type: 'up', x, y, button: 'left', in: 'bar' })
        await ui.advance(800)
        return
      }
      seen += 1
    }
  }
  throw new Error(`no crystal drawn: ${JSON.stringify(rows)}`)
}

test('pure pieces: model labels follow /config, resets read as time left, usage and messages', () => {
  expect(modelLabel('claude-opus-5-5', 'opus')).toBe('opus 5.5')
  expect(modelLabel('claude-haiku-4-5', 'haiku')).toBe('haiku 4.5')
  expect(modelLabel('', 'fable')).toBe('fable')
  expect(timeLeft('2026-10-08T05:10:00Z', NOW)).toBe('2h10')
  expect(timeLeft('2026-10-08T03:25:00Z', NOW)).toBe('25m')
  expect(timeLeft('2026-10-11T10:00:00Z', NOW)).toBe('sun')
  const u = toUsage(USAGE(42.4, 18, 61) as never, NOW)
  expect(u.map(one => `${one.key}:${one.percent}`)).toEqual(['ctx:42', '5h:18', 'wk:61'])
  // off a subscription: the cost replaces the windows
  const api = toUsage({ context: { percent: 10, window: 1 }, rateLimits: [], cost: { usd: 1.423 } } as never, NOW)
  expect(api.map(one => one.key)).toEqual(['ctx', 'cost'])
  expect(api[1]?.usd).toBe(1.42)
  expect(barMessage(toUsage(USAGE(82, 18, 61) as never, NOW), 0, '')?.text).toBe('⚠ context 82% · /compact soon')
  expect(barMessage(toUsage(USAGE(10, 91, 61) as never, NOW), 0, '')?.text).toContain('5-hour limit at 91% · resets 2h10')
  expect(barMessage(toUsage(USAGE(10, 18, 61) as never, NOW), 3, 'main')).toEqual({ text: '⎇ main  ·  ✎ 3 files this session', tone: 'dim' })
})

test('closed: one row, the controls on the right, each value once, no gauges (they live in the footer)', async ($, on) => {
  const { ui } = await start($, on)
  const rows = await lines(ui)
  expect(rows.length).toBe(2)
  const row = rows[1] ?? ''
  expect(row).not.toContain('ctx')
  expect(row).not.toContain('5h')
  expect(row).not.toContain('━')
  expect(row).toContain('opus 5.5')
  expect(row.trimEnd().endsWith('◀')).toBe(true)   // the toggle: unfold to the left
  expect(row.split('high').length - 1).toBe(1)
  expect(row).not.toContain('⇠ cc')
  expect(row).toContain('◇')   // hollow and dim while off
  expect(JSON.stringify(await ui.drawn({ in: 'bar' }))).toMatch(/"dimColor":true[^}]*\},"children":\[" ◇ "\]/)
})

/** The control row: closed or open, the band is this one row (after one blank row). */
const strip = (rows: string[]) => rows.slice(1, 2)

/** Where a glyph sits on the row, in cells (-1: not drawn). */
const cellOf = (row: string, glyph: string): number => (row.includes(glyph) ? cellWidth(row.slice(0, row.indexOf(glyph))) : -1)

test('open in place: the same row becomes the picker, nothing repeated, no frame, never past the width', async ($, on) => {
  const { ui } = await start($, on)
  await click(ui, '◀')
  const rows = await lines(ui)
  expect(rows.length).toBe(2)   // no rows added: the chat keeps its room
  const row = rows[1] ?? ''
  for (const gone of ['╭', '╰', '┬', 'model', 'effort', 'ultra', '◀', '▾', '●', '○', '❧', '▬', '▐', '▌']) {
    expect(row).not.toContain(gone)
  }
  for (const once of ['fable 5.1', 'opus 5.5', 'sonnet 5.5', 'haiku 4.5', 'high', '█████████░░░░░░']) {
    expect(row.split(once).length - 1).toBe(1)
  }
  expect(row.trimEnd().endsWith('▶')).toBe(true)   // the toggle folds it back
  expect(row).not.toContain('off')
  for (const columns of [30, 40, 58, 80, 120, 200]) {
    await ui.resize({ columns, rows: 20, in: 'bar' })
    await ui.advance(300)
    const now = await lines(ui)
    expect(now.length).toBe(2)
    for (const line of now) {
      expect(cellWidth(line)).toBeLessThanOrEqual(columns)
    }
    expect((now[1] ?? '').trimEnd().endsWith('▶')).toBe(true)   // the toggle is never cut
  }
})

test('the open row follows the room: every model, then short names, then one at a time (‹ opus 5.5 ›)', async ($, on) => {
  const { ui } = await start($, on)
  await click(ui, '◀')
  const at = async (columns: number) => {
    await ui.resize({ columns, rows: 20, in: 'bar' })
    await ui.advance(400)
    return (await lines(ui))[1] ?? ''
  }
  expect(await at(140)).toContain('sonnet 5.5')
  const names = await at(80)
  expect(names).toContain(' sonnet ')
  expect(names).not.toContain('sonnet 5.5')
  const compact = await at(58)
  expect(compact).toContain('‹')
  expect(compact).toContain('opus 5.5')
  expect(compact).not.toContain('sonnet')
  const tight = await at(40)
  expect(tight).toContain('‹')
  expect(tight).toContain(' opus ')
  expect(tight).not.toContain('opus 5.5')
})

test('it morphs in place: the gem and the toggle stay put, the row grows left, the meter stretches 5 → 15', async ($, on) => {
  const { ui } = await start($, on)
  const row0 = (await lines(ui))[1] ?? ''
  const gem0 = cellOf(row0, '◇')
  const x = cellOf(row0, '◀')
  await ui.pointer({ type: 'down', x, y: 1, button: 'left', in: 'bar' })
  await ui.pointer({ type: 'up', x, y: 1, button: 'left', in: 'bar' })
  const lefts: number[] = []
  const meters: number[] = []
  for (let i = 0; i < 16; i += 1) {
    await ui.advance(16)
    const rows = await lines(ui)
    expect(rows.length).toBe(2)
    const row = rows[1] ?? ''
    expect(cellOf(row, '◇')).toBe(gem0)   // the gem never moves
    expect(cellWidth(row)).toBe(cellWidth(row0))
    lefts.push(cellOf(row, '│'))
    meters.push([...row].filter(ch => /[█▏▎▍▌▋▊▉░]/.test(ch)).length)
  }
  expect(new Set(lefts).size).toBeGreaterThanOrEqual(6)   // many small steps: smooth
  for (let i = 1; i < lefts.length; i += 1) {
    expect(lefts[i] as number).toBeLessThanOrEqual(lefts[i - 1] as number)   // only ever growing left
    expect(meters[i] as number).toBeGreaterThanOrEqual(meters[i - 1] as number)
  }
  expect(meters[0] as number).toBeLessThan(15)
  expect(meters[meters.length - 1]).toBe(15)
  // and back: the same row folds to the closed look
  const open = (await lines(ui))[1] ?? ''
  await ui.pointer({ type: 'down', x: cellOf(open, '▶'), y: 1, button: 'left', in: 'bar' })
  await ui.pointer({ type: 'up', x: cellOf(open, '▶'), y: 1, button: 'left', in: 'bar' })
  await ui.advance(600)
  const closed = (await lines(ui))[1] ?? ''
  expect(closed.trimEnd().endsWith('◀')).toBe(true)
  expect(closed).not.toContain('sonnet')
})

test('ultra is one icon: ◇ dim off, ◆ amethyst on, no pulse, the row the same width either way', async ($, on) => {
  const { ui } = await start($, on)
  await click(ui, '◀')
  const before = strip(await lines(ui)).map(cellWidth)
  expect(JSON.stringify(await ui.drawn({ in: 'bar' }))).not.toContain('#A78BFA')
  await clickGem(ui, 0)   // the one gem: the row is the picker now
  await ui.advance(1200)
  const after = strip(await lines(ui))
  expect(after.map(cellWidth)).toEqual(before)
  expect(after.join(' ')).not.toMatch(/\bon\b|\boff\b/)
  const flat = JSON.stringify(await ui.drawn({ in: 'bar' }))
  expect(flat).toMatch(/"color":"#A78BFA"[^}]*\},"children":\[" ◆ "\]/)   // lit amethyst, solid
  expect(flat).not.toMatch(/"dimColor":true[^}]*\},"children":\[" [◇◆] "\]/)
  // it does not pulse: across 3 s the glyph and its colour never change, and nothing redraws for it
  for (let i = 0; i < 30; i += 1) {
    await ui.advance(100)
    expect(/[◇◈◆]/.exec((await lines(ui))[1] ?? '')?.[0]).toBe('◆')
    expect(JSON.stringify(await ui.drawn({ in: 'bar' }))).toMatch(/"color":"#A78BFA"[^}]*\},"children":\[" ◆ "\]/)
  }
  await clickGem(ui, 0)
  await ui.advance(600)
  expect(/[◇◈◆]/.exec((await lines(ui))[1] ?? '')?.[0]).toBe('◇')
  expect(JSON.stringify(await ui.drawn({ in: 'bar' }))).not.toContain('#A78BFA')
})

test('Tab moves between model, effort and ultra; arrows change the focused one', async ($, on) => {
  const { ui, envSets, commands, files } = await start($, on)
  await ui.key({ key: 'tab', in: 'bar' })
  await ui.advance(600)
  expect(strip(await lines(ui)).join('\n')).not.toContain('━━━━')   // no heavy frame line marks the focus
  await ui.key({ key: 'right', in: 'bar' })
  await ui.advance(600)
  expect(envSets).toContain('CLAUDE_CODE_EFFORT_LEVEL=xhigh')
  await ui.key({ key: 'tab', in: 'bar' })
  await ui.advance(300)
  await ui.key({ key: 'return', in: 'bar' })
  await ui.advance(600)
  expect(commands).not.toContain('effort ultracode')   // no command: nothing lands in the chat
  expect(JSON.parse(files['C:/Users/me/.claude/settings.json'] ?? '{}')).toEqual({ model: 'opus', ultracode: true })
  expect((await lines(ui))[1]).toMatch(/[◇◈◆]/)
  await ui.key({ key: 'tab', in: 'bar' })
  await ui.advance(300)
  await ui.key({ key: 'right', in: 'bar' })
  await ui.advance(600)
  expect(strip(await lines(ui)).join('\n')).toContain('sonnet 5.5')   // Tab came back round to the model
})

test('a click on a level sets it; a click on ultra switches it on and back off', async ($, on) => {
  const { ui, envSets, commands, files } = await start($, on)
  await click(ui, 'high')
  const rows = await lines(ui)
  const y = 1
  const x = cellWidth((rows[y] ?? '').slice(0, (rows[y] ?? '').lastIndexOf('░')))   // the meter's last cell: max
  await ui.pointer({ type: 'down', x, y, button: 'left', in: 'bar' })
  await ui.pointer({ type: 'up', x, y, button: 'left', in: 'bar' })
  await ui.advance(800)
  expect(envSets).toContain('CLAUDE_CODE_EFFORT_LEVEL=max')
  await clickGem(ui, 0)
  expect(JSON.parse(files['C:/Users/me/.claude/settings.json'] ?? '{}').ultracode).toBe(true)
  await ui.advance(1200)
  await clickGem(ui, 0)
  expect(JSON.parse(files['C:/Users/me/.claude/settings.json'] ?? '{}')).toEqual({ model: 'opus' })
  expect(commands.filter(c => c.startsWith('effort'))).toEqual([])
})

test('a rename cc left for this open window is applied (the tab title follows) and removed; others stay', async ($, on) => {
  const REQ = 'C:/Users/me/.claude/comfort/rename-requests.json'
  const requests = {
    requests: {
      'session-b': { title: '🦊 tidy ui', at: NOW },
      'session-z': { title: '🐳 not mine', at: NOW },
    },
  }
  const { clock, commands, files } = await start($, on, {
    files: { [REQ]: JSON.stringify(requests) },
  })
  await clock.advance(3000)
  const left = JSON.parse(files[REQ] ?? '{}') as { requests: Record<string, unknown> }
  expect(Object.keys(left.requests)).toEqual(['session-z'])
  await clock.advance(1000)
  expect(commands).toContain('rename 🦊 tidy ui')
})

test('⇠ cc only when the window came from cc; a click ends Claude so the card comes back', async ($, on) => {
  const { ui, commands } = await start($, on, { env: { CC_ACTIVE: '1' } })
  const row = (await lines(ui))[1] ?? ''
  expect(row).toContain('⇠ cc')
  expect(row.indexOf('⇠ cc')).toBeGreaterThan(row.indexOf('wk'))
  await click(ui, '⇠ cc')
  expect(commands).toContain('exit')
})

test('narrow windows drop detail in order and never pass the width', async ($, on) => {
  const { ui } = await start($, on)
  const at = async (columns: number) => {
    await ui.resize({ columns, rows: 20, in: 'bar' })
    await ui.advance(300)
    return (await lines(ui))[1] ?? ''
  }
  expect(await at(140)).toContain('opus 5.5')
  const mid = await at(64)
  expect(mid).toContain('opus 5.5')
  const narrow = await at(40)
  expect(narrow).toContain('◀')
  expect(cellWidth(narrow)).toBeLessThanOrEqual(40)
})

/** The footer site (SessionMode) as plain text, drawn at a given width. */
async function footer($: any, columns: number, modes: string[] = []): Promise<{ text: string; drawn: string }> {
  const site = await $.ui.mount({
    plugin: 'crab-crew',
    surface: 'terminal',
    component: 'SessionMode',
    props: { modes },
    viewport: { columns, rows: 30 },
  })
  const tree = await site.drawn()
  const flat = (node: unknown): string =>
    typeof node === 'string' ? node : ((node as { children?: unknown[] } | null)?.children ?? []).map(flat).join('')
  return { text: flat(tree), drawn: JSON.stringify(tree) }
}

test('footer: the gauges sit on the mode row as bars only, calm colours, the engine modes kept', async ($, on) => {
  await start($, on, { usage: USAGE(40, 75, 20) })
  const wide = await footer($, 160)
  expect(wide.text).toContain('5h ')
  expect(wide.text).toContain('wk ')
  expect(wide.text).toContain('ctx ')
  expect(wide.text).not.toContain('%')
  expect(wide.text).toContain(' · 2h10')
  expect(wide.drawn).toContain('#71717A')
  expect(wide.drawn).toContain('#C9A24A')
  const withMode = await footer($, 160, ['focus'])
  expect(withMode.text.startsWith('focus  ')).toBe(true)
})

test('footer: a week at 92% stays, as a soft red bar, even when the row is narrow', async ($, on) => {
  await start($, on, { usage: USAGE(30, 20, 92) })
  const narrow = await footer($, 62)
  expect(narrow.text).toContain('wk')
  expect(narrow.text).not.toContain('5h')
  expect(narrow.drawn).toContain('#D9706A')
})

test('segWidth is available to measure rows', () => {
  expect(segWidth([{ text: '╭─ ' }, { text: '🤖' }])).toBe(5)
})

test('motion: the pill slides as one solid block, answers on the first frame, and settles on the new model', async ($, on) => {
  const { ui, configSets } = await start($, on)
  await click(ui, '◀')
  const sent = configSets.length
  await ui.key({ key: 'right', in: 'bar' })
  const widths: number[] = []
  const starts: number[] = []
  for (let i = 0; i < 18; i += 1) {
    await ui.advance(16)
    if (i === 8) {
      expect(configSets.length).toBe(sent)   // mid-slide: the engine has not been told yet
    }
    starts.push(((await lines(ui))[1] ?? '').indexOf('sonnet') >= 0 ? JSON.stringify(await ui.drawn({ in: 'bar' })).indexOf('"backgroundColor"') : -1)
    const flat = JSON.stringify(await ui.drawn({ in: 'bar' }))
    const pill = [...flat.matchAll(/"backgroundColor":"#[0-9A-F]{6}"[^}]*\},"children":\["([^"]*)"\]/gi)].map(m => m[1]).join('')
    widths.push(pill.length)
  }
  // a solid slide: the pill only grows from the old label's width to the new one's, never stretching past it
  for (let i = 1; i < widths.length; i += 1) {
    expect(widths[i] as number).toBeGreaterThanOrEqual(widths[i - 1] as number)
  }
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(2)
  expect(new Set(starts).size).toBeGreaterThanOrEqual(6)   // it travelled in many small steps, not a few jumps
  await ui.advance(1200)
  expect(configSets.slice(sent)).toEqual(['claude-sonnet-5-5'])   // told once, after the slide
  const end = (await lines(ui))[1] ?? ''
  expect(end).not.toContain('▬')
  expect(end).not.toContain('▐')
  // the highlighted cells are exactly the new name, on coral
  const flat = JSON.stringify(await ui.drawn({ in: 'bar' }))
  const highlighted = [...flat.matchAll(/"backgroundColor":"#[0-9A-F]{6}"[^}]*\},"children":\["([^"]*)"\]/gi)].map(m => m[1]).join('')
  expect(highlighted).toContain(' sonnet 5.5 ')
  expect(highlighted).not.toContain('opus')
  expect(flat).toContain('"backgroundColor":"#60A5FA"')   // sonnet's own colour
})

test('motion: ultra fades to amethyst in its own cell; the meter fills fluidly to the level, with an eighth-block edge', async ($, on) => {
  const { ui } = await start($, on)
  await click(ui, '◀')
  const rows0 = await lines(ui)
  const y = 1
  const width0 = cellWidth(rows0[y] ?? '')
  await clickGem(ui, 0)
  for (const ms of [33, 66, 300]) {
    await ui.advance(ms)
    expect(cellWidth((await lines(ui))[y] ?? '')).toBe(width0)
  }
  const meter = (line: string) => {
    const at = line.indexOf('█')
    return line.slice(at, at + 15)
  }
  expect(meter(rows0[y] ?? '')).toBe('█████████░░░░░░')
  // click the last cell: the fill glides to 15, passing through partial blocks, never changing width
  const x = cellWidth((rows0[y] ?? '').slice(0, (rows0[y] ?? '').lastIndexOf('░')))
  await ui.pointer({ type: 'down', x, y, button: 'left', in: 'bar' })
  await ui.pointer({ type: 'up', x, y, button: 'left', in: 'bar' })
  let sawPartial = false
  for (let i = 0; i < 12; i += 1) {
    await ui.advance(33)
    const m = meter((await lines(ui))[y] ?? '')
    expect(cellWidth(m)).toBe(15)
    if (/[▏▎▍▌▋▊▉]/.test(m)) {
      sawPartial = true
    }
  }
  expect(sawPartial).toBe(true)
  await ui.advance(1500)
  const end = (await lines(ui))[y] ?? ''
  expect(meter(end)).toBe('███████████████')
  expect(end).toContain('max')
  const flat = JSON.stringify(await ui.drawn({ in: 'bar' }))
  expect(flat).toContain('#F43F5E')   // max's rose at the end of the gradient
  expect(flat).toContain('#D97757')   // opus' coral
})

test('idle means still: once settled, nothing is redrawn and nothing changes, open or closed', async ($, on) => {
  const { ui } = await start($, on)
  const closed = JSON.stringify(await ui.drawn({ in: 'bar' }))
  await ui.advance(3000)
  expect(JSON.stringify(await ui.drawn({ in: 'bar' }))).toBe(closed)
  await click(ui, '◀')
  await ui.advance(1500)
  const open = JSON.stringify(await ui.drawn({ in: 'bar' }))
  await ui.advance(3000)
  expect(JSON.stringify(await ui.drawn({ in: 'bar' }))).toBe(open)
})

test('every model and every effort level has its own colour, and the two sets never share one', async () => {
  const models = Object.values(MODEL_COLORS)
  const levels = Object.values(LEVEL_COLORS)
  expect(new Set(models).size).toBe(models.length)
  expect(new Set(levels).size).toBe(levels.length)
  expect(models.filter(c => levels.includes(c))).toEqual([])
})


// ── the merged mod: one band per surface, everything clickable

test('the terminal bar has a ≡ that opens the settings pane (where the clean chat and the rest are switched)', async ($, on) => {
  const opens: string[] = []
  on('ui.open', async (_$: unknown, e: any) => {
    opens.push(e.id)
    return { value: { isPlaced: true } }
  })
  const { ui } = await start($, on)
  const row = (await lines(ui))[1] ?? ''
  expect(row.startsWith('≡')).toBe(true)
  expect(row.trimEnd().endsWith('◀')).toBe(true)   // the toggle keeps the right end
  await click(ui, '≡')
  expect(opens).toEqual(['crab-settings'])
})

test('on the desktop the band is the crab card, never the comfort rows, even once the window has its identity', async ($, on) => {
  await start($, on)
  const desk = await $.ui.mount({ plugin: 'crab-crew', surface: 'desktop', component: 'AbovePrompt', props: { ...BAND, bodyColumns: 70 }, requestId: 'band-d' } as never)
  const flat = JSON.stringify(await desk.drawn())
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  expect(flat).toContain('card/slider.tsx')
  expect(flat).not.toContain('comfort/bar.tsx')
  expect(flat).not.toContain('demo')   // the identity row (emoji + folder name) is not drawn here
  expect(flat).not.toContain('○ ')     // nor the model / effort rows
  await desk.unmount()
})

test('"Chat limpo" in the settings pane switches the clean chat, as /clean does', async ($, on) => {
  const store: Record<string, unknown> = {}
  on('store.get', async (_$: unknown, e: any) => ({ value: store[e.key] }))
  on('store.set', async (_$: unknown, e: any) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('ui.render', { component: 'ToolUse' }, async ($e: any, e: any) => {
    const { Text } = $e.ui.resolve(e)
    return h(Text, {}, 'engine row') as never
  })
  await start($, on)
  const row = () =>
    $.ui.mount({
      plugin: 'crab-crew',
      surface: 'terminal',
      component: 'ToolUse',
      requestId: 'tu-ls',
      props: { tool_use_id: 'tu-ls', tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false, output: {} },
    } as never)
  const before = await row()
  expect(JSON.stringify(await before.drawn())).not.toContain('engine row')
  await before.unmount()
  const pane = await $.ui.mount({
    plugin: 'crab-crew',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'crab-settings',
    props: { title: 'Crab Crew', isFocused: false, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 24 }, view: {} } as const,
  })
  expect((await pane.find({ key: 'cs-clean' }))?.props.value).toBe('on')
  await pane.select({ key: 'cs-clean', value: 'off' })
  expect(store.clean).toBe(false)
  expect((await pane.find({ key: 'cs-clean' }))?.props.value).toBe('off')
  const after = await row()
  expect(JSON.stringify(await after.drawn())).toContain('engine row')
  await after.unmount()
  await pane.unmount()
})
