import { expect, mock, test } from 'claude-code/testing'

import { activity, errorDetail } from '../hooks/comfort/compact'
import { editsLine, shortPath, withTeachRule } from '../hooks/comfort/helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the kit's test body types are not exported
async function start($: any, on: any) {
  mock.env(on, {})
  mock.clock(on, { now: 1_000_000 })
  on('session.start', async (_$: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'session-c' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('command.register', async (_$: unknown, e: any) => ({ value: { command: e.name } }))
  on('command.run', async () => ({ text: '' }))
  on('config.list', async () => ({ value: [] }))
  on('settings.read', async () => ({ value: {} }))
  on('tool.register', async (_$: unknown, e: any) => ({ value: { tool: `mcp__crab-crew__${e.name}` } }))
  // the tools themselves: `false` fails, everything else succeeds
  on('tool.call', async (_$: unknown, e: any) =>
    e.command === 'false' ? { result: 'Exit code 1\nnpm ERR! missing script: build', isError: true } : { result: {} },
  )
  on('turn.start', async (_$: unknown, e: any) => ({ turnId: e.turnId, text: e.text }))
  // the engine's own drawing, as a stand-in: a spinner shows its message (or its word), a row shows ENGINE
  on('ui.render', async (_$: unknown, e: any) => ({
    type: 'Box',
    props: {},
    children: [{ type: 'Text', props: {}, children: [e.component === 'Spinner' ? (e.props.message ?? e.props.word) : 'ENGINE'] }],
  }))
  on('turn.complete', async (_$: unknown, e: any) => ({ text: e.text ?? '' }))
  await $.session.start({ cwd: 'C:/projects/demo', surface: 'terminal', isInteractive: true })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const begin = ($: any, turnId: string) => $.turn.start({ turnId, text: 'do it' } as never)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const end = ($: any, turnId: string) =>
  $.turn.complete({ turnId, reason: 'answer', answer: 'ok', text: 'ok', durationMs: 10, isAborted: false } as never)

const row = (tool: string, id: string, input: unknown, extra: Record<string, unknown> = {}) => ({
  plugin: 'crab-crew',
  surface: 'terminal' as const,
  component: 'ToolUse' as const,
  requestId: id,
  props: { tool_use_id: id, tool, input, isRunning: false, isErrored: false, isInterrupted: false, output: {}, ...extra },
})

const FAILED = { isErrored: true, output: 'Exit code 1\nnpm ERR! missing script: build' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const text = async (ui: any): Promise<string> => JSON.stringify(await ui.drawn())

test('plain words for the spinner and the first line of an error', () => {
  expect(activity('Read', { file_path: 'C:/a/register.tsx' })).toBe('reading register.tsx')
  expect(activity('Bash', { command: 'npm test -- --watch=false\necho done' })).toBe('running npm test -- --watch=false')
  expect(activity('PowerShell', { command: 'Get-ChildItem', description: 'List the demo folder' })).toBe('list the demo folder')
  expect(activity('Grep', { pattern: 'TODO' })).toBe('searching for TODO')
  expect(activity('WebFetch', { url: 'https://code.claude.com/docs/en/env-vars' })).toBe('reading code.claude.com')
  expect(activity('mcp__crab-crew__progress', {})).toBe('using progress')
  expect(errorDetail('Exit code 1\nnpm ERR! missing script')).toBe('Exit code 1')
  expect(errorDetail('<tool_use_error>File does not exist.</tool_use_error>')).toBe('File does not exist.')
  expect(errorDetail({ stderr: '\nfatal: not a git repository' })).toBe('fatal: not a git repository')
})

test('the edits line names the files', () => {
  expect(editsLine(['C:/projects/demo/a.ts'])).toBe('✎ 1 file changed · a.ts')
  expect(editsLine(['a.ts', 'src/b.tsx', 'c.md', 'd.md'])).toBe('✎ 4 files changed · a.ts, b.tsx +2')
  expect(shortPath('C:\\projects\\demo\\src\\a.ts', 'C:/projects/demo')).toBe('src/a.ts')
  expect(shortPath('D:/other/a.ts', 'C:/projects/demo')).toBe('D:/other/a.ts')
})

test('the teaching rule is added once, last, and defers to the user’s own instructions', () => {
  const once = withTeachRule([{ id: 'core', text: 'You are Claude.' }])
  expect(once.map(s => s.id)).toEqual(['core', 'crab-crew:teach'])
  const rule = (once[1] as { text: string }).text
  expect(rule).toContain('"Did:"')
  expect(rule).toContain('"New term:"')
  expect(rule).toContain('always win over this')
  expect(withTeachRule(once).map(s => s.id)).toEqual(['core', 'crab-crew:teach'])
})

test('routine tool rows draw nothing, successful or not, while the turn goes on', async ($, on) => {
  await start($, on)
  const read = await $.ui.mount(row('Read', 'r1', { file_path: 'C:/projects/demo/a.ts' }) as never)
  expect(await text(read)).not.toContain('a.ts')
  const bash = await $.ui.mount(row('Bash', 'b1', { command: 'npm test' }) as never)
  expect(await text(bash)).not.toContain('npm test')
  const failed = await $.ui.mount(row('Bash', 'b2', { command: 'npm run build' }, FAILED) as never)
  expect(await text(failed)).not.toContain('✗')
})

test('a failure Claude fixed stays invisible; the call a turn ends broken on gets one ✗ line', async ($, on) => {
  await start($, on)
  await begin($, 't1')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'f1', command: 'false' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'ok1', command: 'true' } as never)
  await end($, 't1')
  const fixed = await $.ui.mount(row('Bash', 'f1', { command: 'npm run build' }, FAILED) as never)
  expect(await text(fixed)).not.toContain('✗')

  await begin($, 't2')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'f2', command: 'false' } as never)
  await end($, 't2')
  const broken = await $.ui.mount(row('Bash', 'f2', { command: 'npm run build' }, FAILED) as never)
  const drawn = await text(broken)
  expect(drawn).toContain('✗')
  expect(drawn).toContain('npm run build')
  expect(drawn).toContain('Exit code 1')
  expect(drawn).not.toContain('missing script')
})

test('an interrupted call always says so', async ($, on) => {
  await start($, on)
  const cut = await $.ui.mount(row('Bash', 'i1', { command: 'npm run dev' }, { isInterrupted: true }) as never)
  const drawn = await text(cut)
  expect(drawn).toContain('✗')
  expect(drawn).toContain('interrupted')
})

test('a subagent’s calls never decide how the main turn ended', async ($, on) => {
  await start($, on)
  await begin($, 't1')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'm1', command: 'true' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 's1', command: 'false', agentId: 'agent-1' } as never)
  await end($, 't1')
  const sub = await $.ui.mount(row('Bash', 's1', { command: 'npm run build' }, FAILED) as never)
  expect(await text(sub)).not.toContain('✗')
})

test('the spinner says what Claude is doing, and stops when the turn ends', async ($, on) => {
  await start($, on)
  await begin($, 't1')
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: 'C:/projects/demo/src/login.ts' } as never)
  const spin = { plugin: 'crab-crew', surface: 'terminal' as const, component: 'Spinner' as const }
  const props = { word: 'Baking', message: null, suffix: '…', mode: 'tool-use' }
  const busy = await $.ui.mount({ ...spin, props } as never)
  expect(await text(busy)).toContain('reading login.ts')
  // an engine state (compacting, retrying) keeps its own words
  const engine = await $.ui.mount({ ...spin, props: { ...props, message: 'Compacting conversation' } } as never)
  expect(await text(engine)).not.toContain('reading login.ts')
  await end($, 't1')
  const idle = await $.ui.mount({ ...spin, props } as never)
  expect(await text(idle)).not.toContain('reading login.ts')
})

test('a turn with edits draws one line, on its first edit, that unfolds into the file list', async ($, on) => {
  await start($, on)
  await begin($, 't1')
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: 'C:/projects/demo/src/a.ts', old_string: 'x', new_string: 'y' } as never)
  await $.tool.call({ tool: 'Write', tool_use_id: 'e2', file_path: 'C:/projects/demo/b.md', content: 'hi' } as never)
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e3', file_path: 'C:/projects/demo/src/a.ts', old_string: 'y', new_string: 'z' } as never)

  const first = await $.ui.mount(row('Edit', 'e1', { file_path: 'C:/projects/demo/src/a.ts' }) as never)
  expect(await text(first)).toContain('✎ 2 files changed · a.ts, b.md')
  const second = await $.ui.mount(row('Write', 'e2', { file_path: 'C:/projects/demo/b.md' }) as never)
  expect(await text(second)).not.toContain('b.md')

  await first.press({ key: 'edits:e1' })
  const open = await text(first)
  expect(open).toContain('src/a.ts')
  expect(open).toContain('    b.md')
  await first.press({ key: 'edits:e1' })
  expect(await text(first)).not.toContain('src/a.ts')

  // the next prompt starts its own line
  await end($, 't1')
  await begin($, 't2')
  await $.tool.call({ tool: 'Write', tool_use_id: 'e4', file_path: 'C:/projects/demo/c.md', content: 'hi' } as never)
  const next = await $.ui.mount(row('Write', 'e4', { file_path: 'C:/projects/demo/c.md' }) as never)
  expect(await text(next)).toContain('✎ 1 file changed · c.md')
})

test('an edit from before this session (a resumed chat) draws nothing', async ($, on) => {
  await start($, on)
  const old = await $.ui.mount(row('Edit', 'old-1', { file_path: 'C:/projects/demo/a.ts' }) as never)
  expect(await text(old)).not.toContain('a.ts')
})

test('/clean off: every row draws as the engine draws it', async ($, on) => {
  await start($, on)
  await $.command.run({ command: 'clean', args: '' } as never)
  const read = await $.ui.mount(row('Read', 'r9', { file_path: 'C:/projects/demo/a.ts' }) as never)
  expect(await text(read)).toContain('ENGINE')
})
