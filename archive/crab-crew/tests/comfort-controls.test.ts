import { expect, mock, test } from 'claude-code/testing'

import { cellWidth } from '../hooks/comfort/look'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 100,
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

test('effort and model change without running any command (nothing written in the chat)', async ($, on) => {
  const envSets: string[] = []
  const configSets: { key: string; value: unknown }[] = []
  const commands: string[] = []
  mock.env(on, {})
  mock.clock(on, { now: 1_000_000 })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'session-1' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('command.run', async (_$, e) => {
    commands.push(`${e.command} ${e.args}`.trim())
    return { text: '' }
  })
  on('config.list', async () => ({ value: [MODEL_ROW] as never }))
  on('config.set', async (_$, e) => {
    configSets.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('env.set', async (_$, e) => {
    envSets.push(`${e.name}=${e.value}`)
    return { value: undefined }
  })
  on('settings.read', async () => ({ value: { effortLevel: 'high' } }))
  await $.session.start({ cwd: 'C:/projects/demo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'crab-crew', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.resize({ columns: 100, rows: 14, in: 'bar' })

  // opens the panel, then picks max and sonnet by clicking their text
  const lines = async (): Promise<string[]> => {
    const flat = (node: unknown): string =>
      typeof node === 'string' ? node : ((node as { children?: unknown[] }).children ?? []).map(flat).join('')
    return (((await ui.drawn({ in: 'bar' })) as { children?: unknown[] }).children ?? []).map(flat)
  }
  const click = async (text: string) => {
    const rows = await lines()
    const y = rows.findIndex(row => row.includes(text))
    const x = cellWidth((rows[y] ?? '').slice(0, (rows[y] ?? '').indexOf(text)))   // by cells: ⚡ is 2 wide
    await ui.pointer({ type: 'down', x, y, button: 'left', in: 'bar' })
    await ui.pointer({ type: 'up', x, y, button: 'left', in: 'bar' })
    await ui.advance(1500)
  }
  await click('◀')
  {
    const rows = await lines()
    const y = rows.findIndex((line, at) => at >= 1 && line.includes('░'))
    const x = (rows[y] ?? '').lastIndexOf('░')   // the meter's last cell: max
    await ui.pointer({ type: 'down', x, y, button: 'left', in: 'bar' })
    await ui.pointer({ type: 'up', x, y, button: 'left', in: 'bar' })
    await ui.advance(1500)
  }
  expect(envSets).toEqual(['CLAUDE_CODE_EFFORT_LEVEL=max'])
  expect(commands).toEqual([])

  await click('sonnet')
  expect(configSets).toEqual([{ key: 'model', value: 'claude-sonnet-5-5' }])
  expect(commands).toEqual([])
  const drawn = JSON.stringify(await ui.drawn({ in: 'bar' }))
  expect(drawn).toContain('sonnet 5.5')
  expect(drawn).toContain('max')
})

test('an /effort typed by the user aligns the environment variable', async ($, on) => {
  const envSets: string[] = []
  mock.env(on, {})
  mock.clock(on, { now: 1_000_000 })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'session-2' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('command.run', async () => ({ text: 'Set effort level to medium (saved as your default for new sessions)' }))
  on('config.list', async () => ({ value: [MODEL_ROW] as never }))
  on('env.set', async (_$, e) => {
    envSets.push(`${e.name}=${e.value}`)
    return { value: undefined }
  })
  on('settings.read', async () => ({ value: {} }))
  await $.session.start({ cwd: 'C:/projects/demo', surface: 'terminal', isInteractive: true })

  const ran = await $.command.run({ command: 'effort', args: 'medium' } as never)
  expect(envSets).toEqual(['CLAUDE_CODE_EFFORT_LEVEL=medium'])
  expect(ran.text).toContain('medium')
})

test('the session is never renamed on start (a rename only arrives from cc, see bar.test)', async ($, on) => {
  const commands: string[] = []
  mock.env(on, { USERPROFILE: 'C:/Users/me' })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'session-r' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('command.run', async (_$, e) => {
    commands.push(`${e.command} ${e.args}`.trim())
    return { text: '' }
  })
  on('config.list', async () => ({ value: [MODEL_ROW] as never }))
  on('settings.read', async () => ({ value: {} }))
  await $.session.start({ cwd: 'C:/projects/demo', surface: 'terminal', isInteractive: true })
  await clock.advance(5_000)
  expect(commands.filter(c => c.startsWith('rename'))).toEqual([])
})
