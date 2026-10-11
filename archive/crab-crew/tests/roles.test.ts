import { expect, test } from 'claude-code/testing'
import {
  ROLES, ROUTING, addEntry, durationOf, effortForRole, exactRole, formatDuration, patchEntry, roleOf, routeModel, setStatus, subagentEffort, tokens,
  type CrewEntry,
} from '../hooks/crew/roles'

test('exact subagent_type map', () => {
  expect(roleOf('Explore', '')).toBe('Explorer')
  expect(roleOf('Plan', 'write the plan')).toBe('Architect') // exact wins over description keywords
  expect(roleOf('general-purpose', 'review the code')).toBe('Builder')
  expect(roleOf('claude', '')).toBe('Builder')
  expect(roleOf('claude-code-guide', 'docs lookup')).toBe('Guide')
  expect(roleOf('  EXPLORE ', '')).toBe('Explorer')
})

test('keywords in the type', () => {
  expect(roleOf('ui-designer', '')).toBe('Designer')
  expect(roleOf('code-reviewer', '')).toBe('Reviewer') // review before code
  expect(roleOf('test-runner', '')).toBe('Tester')
  expect(roleOf('security-auditor', '')).toBe('Security')
  expect(roleOf('deployer', '')).toBe('Deployer')
  expect(roleOf('web-researcher', '')).toBe('Researcher')
  expect(roleOf('docs-bot', '')).toBe('Writer')
  expect(roleOf('tech-writer', '')).toBe('Writer')
  expect(roleOf('coder', '')).toBe('Coder')
  expect(roleOf('implementer', '')).toBe('Coder')
})

test('keywords in the description when the type says nothing', () => {
  expect(roleOf('helper', 'Implement the parser')).toBe('Coder')
  expect(roleOf('', 'Run the TESTS')).toBe('Tester')
  expect(roleOf(undefined, 'Deploy to staging')).toBe('Deployer')
  expect(roleOf('worker', 'Write release notes')).toBe('Writer')
})

test('keywords match whole words only (no substrings of other words)', () => {
  expect(tokens('fetchLatest-Docker_build')).toEqual(['fetch', 'latest', 'docker', 'build'])
  expect(roleOf('my-agent', 'Investigate the latest Docker build failure')).toBe(null)
  expect(roleOf('fetch-latest', '')).toBe(null)
  expect(roleOf('docker-helper', '')).toBe(null)
  expect(roleOf('decoder', '')).toBe(null)
  expect(roleOf('contest', '')).toBe(null)
  expect(roleOf('protester', '')).toBe(null)
  expect(roleOf('unicode-fixer', '')).toBe(null)
  expect(roleOf('codex', '')).toBe(null)
  expect(roleOf('doctor', '')).toBe(null)
  // camelCase types still split
  expect(roleOf('codeReviewer', '')).toBe('Reviewer')
  expect(roleOf('apiTester', '')).toBe('Tester')
})

test('security wins over review; prototype keys are no role', () => {
  expect(roleOf('security-reviewer', '')).toBe('Security')
  expect(roleOf('constructor', '')).toBe(null)
  expect(roleOf('__proto__', '')).toBe(null)
  expect(roleOf('toString', '')).toBe(null)
  expect(exactRole('hasOwnProperty')).toBe(null)
  expect(exactRole(' Plan ')).toBe('Architect')
})

test('the resolved type of an Agent call without subagent_type is general-purpose (Builder)', () => {
  expect(roleOf('general-purpose', 'Review the auth code')).toBe('Builder')
})

test('type keywords win over description keywords', () => {
  expect(roleOf('reviewer', 'Implement fixes')).toBe('Reviewer')
})

test('unknown role', () => {
  expect(roleOf('helper', 'Fetch the logs')).toBe(null)
  expect(roleOf('', '')).toBe(null)
  expect(roleOf(null, null)).toBe(null)
  expect(roleOf(undefined)).toBe(null)
})

test('routing table covers every role with the decided model and effort', () => {
  for (const r of ['Explorer', 'Researcher', 'Guide', 'Tester'] as const) expect(ROUTING[r]).toEqual({ model: 'haiku', effort: 'low' })
  for (const r of ['Builder', 'Coder', 'Designer', 'Writer', 'Deployer'] as const) expect(ROUTING[r]).toEqual({ model: 'sonnet', effort: 'medium' })
  for (const r of ['Architect', 'Reviewer', 'Security'] as const) expect(ROUTING[r]).toEqual({ model: 'opus', effort: 'high' })
  expect(ROLES.every(r => ROUTING[r] !== undefined)).toBe(true)
})

const BUILT_IN = { builtIn: true } as const

test('routeModel sets the role model when none was given, for a built-in type', () => {
  expect(routeModel('Explorer', { ...BUILT_IN })).toBe('haiku')
  expect(routeModel('Coder', { ...BUILT_IN, model: '' })).toBe('sonnet')
  expect(routeModel('Security', { ...BUILT_IN, model: '   ' })).toBe('opus')
  expect(routeModel('Architect', { ...BUILT_IN, model: null })).toBe('opus')
})

test("main agent's explicit model wins", () => {
  expect(routeModel('Explorer', { ...BUILT_IN, model: 'opus' })).toBe(null)
  expect(routeModel('Architect', { ...BUILT_IN, model: 'haiku' })).toBe(null)
  expect(routeModel('Coder', { ...BUILT_IN, model: 'inherit' })).toBe(null)
  expect(routeModel('Coder', { ...BUILT_IN, model: 'claude-sonnet-5-5' })).toBe(null)
})

test('forks, workflow agents, teammates and non built-in agents are never routed', () => {
  expect(routeModel('Builder', { ...BUILT_IN, fork: true })).toBe(null)
  expect(routeModel('Builder', { ...BUILT_IN, workflow: { runId: 'wf_1', agentIndex: 1 } })).toBe(null)
  expect(routeModel('Builder', { ...BUILT_IN, isTeammate: true })).toBe(null)
  // a user's or plugin's agent definition may pin its own model in frontmatter
  expect(routeModel('Reviewer', { builtIn: false })).toBe(null)
  expect(routeModel('Reviewer', {})).toBe(null)
})

test('unknown role is left untouched', () => {
  expect(routeModel(null, { ...BUILT_IN })).toBe(null)
  expect(routeModel(undefined, { ...BUILT_IN, model: '' })).toBe(null)
  expect(effortForRole(null)).toBe(null)
})

test('effortForRole', () => {
  expect(effortForRole('Tester')).toBe('low')
  expect(effortForRole('Builder')).toBe('medium')
  expect(effortForRole('Reviewer')).toBe('high')
})

test('subagentEffort follows the model actually used, and leaves an explicit effort', () => {
  expect(subagentEffort('Explorer', 'haiku')).toBe('low')
  expect(subagentEffort('Builder', 'sonnet')).toBe('medium')
  expect(subagentEffort('Reviewer', 'opus')).toBe('high')
  // the main agent put an Explorer on opus: it runs at opus's effort, not at low
  expect(subagentEffort('Explorer', 'opus')).toBe('high')
  expect(subagentEffort('Explorer', 'haiku', true)).toBe(null)
  expect(subagentEffort(null, 'haiku')).toBe(null)
  expect(subagentEffort('Coder', null)).toBe(null)
})

const entry = (id: string, start = 1000): CrewEntry => ({
  id, type: 'Explore', role: 'Explorer', model: 'haiku', description: 'look around', start, status: 'working',
})

test('addEntry appends and replaces by id without mutating', () => {
  const a: CrewEntry[] = []
  const b = addEntry(a, entry('1'))
  const c = addEntry(b, entry('2'))
  expect(a.length).toBe(0)
  expect(c.map(e => e.id)).toEqual(['1', '2'])
  const d = addEntry(c, { ...entry('1'), description: 'again' })
  expect(d.map(e => e.id)).toEqual(['1', '2'])
  expect(d[0]?.description).toBe('again')
  expect(c[0]?.description).toBe('look around')
})

test('setStatus stamps end, keeps it, clears on working, ignores unknown ids', () => {
  const list = [entry('1'), entry('2')]
  const done = setStatus(list, '1', 'done', 5000)
  expect(done[0]).toEqual({ ...entry('1'), status: 'done', end: 5000 })
  expect(list[0]?.status).toBe('working')
  expect(done[1]).toBe(list[1])

  const err = setStatus(done, '1', 'error', 9000)
  expect(err[0]?.status).toBe('error')
  expect(err[0]?.end).toBe(5000)

  const again = setStatus(err, '1', 'working', 9500)
  expect(again[0]?.status).toBe('working')
  expect(again[0]?.end).toBe(undefined)

  expect(setStatus(list, 'nope', 'done', 1)).toBe(list)
  expect(setStatus(done, '1', 'done', 7000)).toBe(done)
  expect(setStatus(list, '2', 'interrupted', 3000)[1]?.end).toBe(3000)
})

test('patchEntry merges by id without mutating; unknown id returns the same array', () => {
  const list = [entry('1'), entry('2')]
  const p = patchEntry(list, '2', { agentId: 'a2', model: 'claude-haiku-5-5' })
  expect(p[1]).toEqual({ ...entry('2'), agentId: 'a2', model: 'claude-haiku-5-5' })
  expect(list[1]?.agentId).toBe(undefined)
  expect(p[0]).toBe(list[0])
  expect(patchEntry(list, 'x', { model: 'm' })).toBe(list)
})

test('durationOf uses end when stopped, now while working, never negative', () => {
  const w = entry('1', 1000)
  expect(durationOf(w, 4000)).toBe(3000)
  expect(durationOf({ ...w, status: 'done', end: 2500 }, 99999)).toBe(1500)
  expect(durationOf(w, 500)).toBe(0)
})

test('formatDuration', () => {
  expect(formatDuration(0)).toBe('0s')
  expect(formatDuration(999)).toBe('0s')
  expect(formatDuration(42_000)).toBe('42s')
  expect(formatDuration(60_000)).toBe('1m 00s')
  expect(formatDuration(185_000)).toBe('3m 05s')
  expect(formatDuration(3_720_000)).toBe('1h 02m')
  expect(formatDuration(-5)).toBe('0s')
  expect(formatDuration(Number.NaN)).toBe('0s')
})
