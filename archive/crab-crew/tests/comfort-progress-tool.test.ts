import { expect, mock, test } from 'claude-code/testing'

import { withProgressRule } from '../hooks/comfort/helpers'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 30,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the kit's test body types are not exported
async function start($: any, on: any, registered: string[]) {
  mock.env(on, {})
  mock.clock(on, { now: 1_000_000 })
  on('session.start', async (_$: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'session-p' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('command.register', async (_$: unknown, e: any) => ({ value: { command: e.name } }))
  on('command.run', async () => ({ text: '' }))
  on('config.list', async () => ({ value: [] }))
  on('settings.read', async () => ({ value: {} }))
  on('tool.register', async (_$: unknown, e: any) => {
    registered.push(e.name)
    return { value: { tool: `mcp__crab-crew__${e.name}` } }
  })
  await $.session.start({ cwd: 'C:/projects/demo', surface: 'terminal', isInteractive: true })
}

test('the progress tool is registered and answers with the count', async ($, on) => {
  const registered: string[] = []
  await start($, on, registered)
  expect(registered).toContain('progress')

  const ran = await $.tool.call({
    tool: 'mcp__crab-crew__progress',
    tasks: [
      { text: 'Read the code', status: 'completed' },
      { text: 'Fix the bug', active: 'Fixing the bug', status: 'in_progress' },
      { text: 'Run the tests', status: 'pending' },
    ],
  } as never)
  expect(JSON.stringify(ran)).toContain('1/3')
})

test('the progress rule is added once, last, in the session scope', () => {
  const base = [{ id: 'core', text: 'You are Claude.', scope: 'shared' as const }]
  const once = withProgressRule(base)
  expect(once.map(s => s.id)).toEqual(['core', 'crab-crew:progress'])
  expect(once[1]).toMatchObject({ scope: 'session' })
  expect(withProgressRule(once).map(s => s.id)).toEqual(['core', 'crab-crew:progress'])
})