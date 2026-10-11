import { expect, mock, test } from 'claude-code/testing'

import { cellWidth } from '../hooks/comfort/look'
import { type Item, gauge, lineHead, lineState, treeRows } from '../hooks/comfort/progress'

// ── the pure layout ──
const item = (id: string, status: Item['status'], text: string, subs: Item['status'][] = []): Item => ({
  id,
  text,
  active: status === 'in_progress' ? `${text}ing` : text,
  status,
  ...(subs.length > 0 ? { subtasks: subs.map((s, at) => ({ text: `step ${at + 1}`, status: s })) } : {}),
})
const LIST = [
  item('p0', 'completed', 'read how login works'),
  item('p1', 'in_progress', 'fix the login', ['completed', 'in_progress', 'pending']),
  item('p2', 'pending', 'explain the fix', ['pending', 'pending']),
  item('p3', 'pending', 'run the tests'),
]
const join = (pieces: { text: string }[]) => pieces.map(p => p.text).join('')
const AUTO = { id: '', active: '' }

test('the gauge only fills completely when everything is done', () => {
  expect(gauge(0, 4, 16)).toBe('─'.repeat(16))
  expect(gauge(2, 4, 16)).toBe('━'.repeat(8) + '─'.repeat(8))
  expect(gauge(3.99, 4, 16)).toBe('━'.repeat(15) + '─')
  expect(gauge(4, 4, 16)).toBe('━'.repeat(16))
})

test('the line says live, done or stopped', () => {
  expect(lineState(LIST, true)).toBe('live')
  expect(lineState(LIST, false)).toBe('stopped')
  const done = LIST.map(one => ({ ...one, status: 'completed' as const }))
  expect(lineState(done, false)).toBe('done')
  expect(join(lineHead(LIST, 'live', false))).toBe('▸ tasks  ' + gauge(1, 4, 16) + '  1/4 · now: fix the logining')
  expect(join(lineHead(LIST, 'stopped', true))).toContain('▾ tasks')
  expect(join(lineHead(LIST, 'stopped', true))).toContain('stopped at: fix the logining')
  expect(join(lineHead(done, 'done', false))).toContain('4/4 ✓ done')
})

test('the head never passes the width', () => {
  const long = [item('p0', 'in_progress', 'a very long task name that goes on and on and on and on and on and on')]
  for (const width of [30, 40, 52, 64, 80, 100]) {
    expect(cellWidth(join(lineHead(long, 'live', false, width)))).toBeLessThanOrEqual(width)
  }
})

test('the tree: step gauges in one column, the active task’s steps open, nothing past the width', () => {
  const rows = treeRows(LIST, AUTO, 'live', 100)
  const lines = rows.map(row => join(row.pieces))
  const fix = lines.find(line => line.includes('fix the login')) ?? ''
  const explain = lines.find(line => line.includes('explain the fix')) ?? ''
  expect(fix).toContain('●')
  expect(fix).toContain('1/3')
  expect(fix.indexOf('━')).toBe(explain.indexOf('─'))
  expect(lines.some(line => line.includes('├ ✓ step 1'))).toBe(true)
  expect(lines.some(line => line.includes('└ ○ step 3'))).toBe(true)
  // tasks without steps get no gauge
  expect(lines.find(line => line.includes('run the tests')) ?? '').not.toContain('─')
  for (const width of [30, 40, 52, 64, 80, 100, 140]) {
    for (const row of treeRows(LIST, AUTO, 'live', width)) {
      expect(cellWidth(join(row.pieces))).toBeLessThanOrEqual(Math.min(width, 100))
    }
  }
  // a stopped turn marks where it stopped
  expect(treeRows(LIST, AUTO, 'stopped').map(row => join(row.pieces)).join('\n')).toContain('◌  fix the login')
})

// ── in the chat ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the kit's test body types are not exported
async function start($: any, on: any, history: unknown[] = []) {
  mock.env(on, {})
  mock.clock(on, { now: 1_000_000 })
  on('session.start', async (_$: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'session-t' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', async () => ({ value: history }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('command.register', async (_$: unknown, e: any) => ({ value: { command: e.name } }))
  on('command.run', async () => ({ text: '' }))
  on('config.list', async () => ({ value: [] }))
  on('settings.read', async () => ({ value: {} }))
  on('tool.register', async (_$: unknown, e: any) => ({ value: { tool: `mcp__crab-crew__${e.name}` } }))
  on('tool.call', async () => ({ result: {} }))
  on('turn.start', async (_$: unknown, e: any) => ({ turnId: e.turnId, text: e.text }))
  on('turn.complete', async (_$: unknown, e: any) => ({ text: e.text ?? '' }))
  await $.session.start({ cwd: 'C:/projects/demo', surface: 'terminal', isInteractive: true })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const begin = ($: any, turnId: string) => $.turn.start({ turnId, text: 'do it' } as never)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const end = ($: any, turnId: string) =>
  $.turn.complete({ turnId, reason: 'answer', answer: 'ok', text: 'ok', durationMs: 10, isAborted: false } as never)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const progress = ($: any, id: string, tasks: unknown[]) => $.tool.call({ tool: 'mcp__crab-crew__progress', tool_use_id: id, tasks } as never)

const TASKS = (step: number) => [
  { text: 'read the code', status: step > 0 ? 'completed' : 'in_progress' },
  {
    text: 'fix the login',
    active: 'fixing the login',
    status: step > 1 ? 'completed' : step === 1 ? 'in_progress' : 'pending',
    subtasks: [
      { text: 'reproduce it', status: step >= 1 ? 'completed' : 'pending' },
      { text: 'write the fix', status: step > 1 ? 'completed' : step === 1 ? 'in_progress' : 'pending' },
    ],
  },
  { text: 'run the tests', status: step > 2 ? 'completed' : step === 2 ? 'in_progress' : 'pending' },
]

const row = (tool: string, id: string, input: unknown = {}) => ({
  plugin: 'crab-crew',
  surface: 'terminal' as const,
  component: 'ToolUse' as const,
  requestId: id,
  viewport: { columns: 100, rows: 40 },
  props: { tool_use_id: id, tool, input, isRunning: false, isErrored: false, isInterrupted: false, output: {} },
})
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const text = async (ui: any): Promise<string> => {
  // the drawn row as the screen reads it: every string child and every Button label, in order
  const flat = (node: any): string =>
    typeof node === 'string'
      ? node
      : node === null || typeof node !== 'object'
        ? ''
        : `${typeof node.props?.label === 'string' ? node.props.label : ''}${(node.children ?? []).map(flat).join('')}`
  return flat(await ui.drawn())
}

test('one line per turn: only the turn’s latest task call draws it, live while the turn runs', async ($, on) => {
  await start($, on)
  await begin($, 't1')
  await progress($, 'a1', TASKS(0))
  await progress($, 'a2', TASKS(1))
  const first = await $.ui.mount(row('mcp__crab-crew__progress', 'a1') as never)
  const latest = await $.ui.mount(row('mcp__crab-crew__progress', 'a2') as never)
  expect(await text(first)).not.toContain('tasks')
  const live = await text(latest)
  expect(live).toContain('▸ tasks')
  expect(live).toContain('1/3')
  expect(live).toContain('now: fixing the login')
})

test('after the turn the line freezes: stopped if unfinished, done if finished', async ($, on) => {
  await start($, on)
  await begin($, 't1')
  await progress($, 'b1', TASKS(1))
  await end($, 't1')
  const stopped = await $.ui.mount(row('mcp__crab-crew__progress', 'b1') as never)
  expect(await text(stopped)).toContain('stopped at: fixing the login')

  await begin($, 't2')
  await progress($, 'b2', TASKS(3))
  await end($, 't2')
  const done = await $.ui.mount(row('mcp__crab-crew__progress', 'b2') as never)
  expect(await text(done)).toContain('3/3 ✓ done')
  // and the first turn's line is still there, unchanged
  expect(await text(stopped)).toContain('stopped at: fixing the login')
})

test('a click unfolds the tree; a click on a task folds or opens its steps', async ($, on) => {
  await start($, on)
  await begin($, 't1')
  await progress($, 'c1', TASKS(1))
  const line = await $.ui.mount(row('mcp__crab-crew__progress', 'c1') as never)
  expect(await text(line)).not.toContain('read the code')
  await line.press({ key: 'tasks:c1' })
  let drawn = await text(line)
  expect(drawn).toContain('▾ tasks')
  expect(drawn).toContain('read the code')
  expect(drawn).toContain('write the fix')
  // fold the active task's steps
  await line.press({ key: 'task:c1:p1' })
  drawn = await text(line)
  expect(drawn).toContain('fixing the login')
  expect(drawn).not.toContain('write the fix')
  // and close the tree again
  await line.press({ key: 'tasks:c1' })
  expect(await text(line)).not.toContain('read the code')
})

test('TodoWrite draws the same line', async ($, on) => {
  await start($, on)
  await begin($, 't1')
  const todos = [
    { content: 'Read', status: 'completed', activeForm: 'Reading' },
    { content: 'Write', status: 'in_progress', activeForm: 'Writing' },
  ]
  await $.tool.call({ tool: 'TodoWrite', tool_use_id: 'd1', todos } as never)
  const line = await $.ui.mount(row('TodoWrite', 'd1', { todos }) as never)
  const drawn = await text(line)
  expect(drawn).toContain('1/2')
  expect(drawn).toContain('now: Writing')
})

test('a resumed chat: each past turn keeps one frozen line, read from its own input', async ($, on) => {
  const history = [
    { role: 'user', text: 'first request', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'h1', tool: 'mcp__crab-crew__progress', input: { tasks: TASKS(0) } }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'h2', tool: 'mcp__crab-crew__progress', input: { tasks: TASKS(3) } }] },
    { role: 'user', text: 'second request', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'h3', tool: 'mcp__crab-crew__progress', input: { tasks: TASKS(1) } }] },
  ]
  await start($, on, history)
  expect(await text(await $.ui.mount(row('mcp__crab-crew__progress', 'h1') as never))).not.toContain('tasks')
  expect(await text(await $.ui.mount(row('mcp__crab-crew__progress', 'h2') as never))).toContain('3/3 ✓ done')
  expect(await text(await $.ui.mount(row('mcp__crab-crew__progress', 'h3') as never))).toContain('stopped at')
})

test('the bar has no task rows any more', async ($, on) => {
  await start($, on)
  await begin($, 't1')
  await progress($, 'e1', TASKS(1))
  const band = {
    hasSurvey: false,
    isWorking: true,
    maxRows: 30,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  }
  const ui = await $.ui.mount({ plugin: 'crab-crew', surface: 'terminal', component: 'AbovePrompt', props: band })
  await ui.resize({ columns: 100, rows: 20, in: 'bar' })
  await ui.advance(300)
  const drawn = JSON.stringify(await ui.drawn({ in: 'bar' }))
  expect(drawn).not.toContain('fix the login')
  expect(drawn).not.toContain('task 2 of')
})
