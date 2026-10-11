import { expect, mock, test } from 'claude-code/testing'

import { ACCESSORIES, CRAB_COLORS, MAX_CRABS, SEED_CRABS, addCrab, designPrompt, hashCrab, matchCrab, parseDesign } from '../hooks/comfort/crabs'
import { cellWidth } from '../hooks/comfort/look'

test('a task finds its crab by agent type, then by the words of its description; a new kind finds none', () => {
  expect(matchCrab(SEED_CRABS, 'Explore', 'anything at all')?.name).toBe('scout')
  expect(matchCrab(SEED_CRABS, 'general-purpose', 'Review the cc.ps1 changes')?.name).toBe('reviewer')
  expect(matchCrab(SEED_CRABS, 'general-purpose', 'Independently verify the claim')?.name).toBe('reviewer')
  expect(matchCrab(SEED_CRABS, 'general-purpose', 'Fix the login bug')?.name).toBe('fixer')
  expect(matchCrab(SEED_CRABS, 'general-purpose', 'Translate the app strings into Portuguese')).toBeUndefined()
  // the earliest keyword in the sentence wins: "plan the tests" is the planner's
  expect(matchCrab(SEED_CRABS, 'general-purpose', 'plan the tests')?.name).toBe('planner')
})

test('the design answer: reuse an existing crab, a new valid crab, or nothing (then the hash design)', () => {
  const reuse = parseDesign('sure: {"reuse":"scout"}', SEED_CRABS, 'general-purpose')
  expect(reuse !== undefined && 'reuse' in reuse && reuse.reuse.name).toBe('scout')
  const made = parseDesign('{"name":"Translator!","color":"#f472b6","accessory":"🧭","keywords":["translate","language","i18n"]}', SEED_CRABS, 'general-purpose')
  expect(made !== undefined && 'crab' in made && made.crab).toEqual({ name: 'translator', color: '#F472B6', accessory: '🧭', keywords: ['translate', 'language', 'i18n'], kinds: [] })
  // off-palette colour or accessory: replaced from the safe sets, never drawn as given
  const odd = parseDesign('{"name":"odd","color":"#000000","accessory":"⚡","keywords":["x"]}', SEED_CRABS, 'my-agent')
  expect(odd !== undefined && 'crab' in odd && CRAB_COLORS.includes(odd.crab.color) && ACCESSORIES.includes(odd.crab.accessory)).toBe(true)
  expect(odd !== undefined && 'crab' in odd && odd.crab.kinds).toEqual(['my agent'])
  expect(parseDesign('no json here', SEED_CRABS, 'x')).toBeUndefined()
  const taken = parseDesign('{"name":"scout"}', SEED_CRABS, 'x')   // a name already taken is that crab
  expect(taken !== undefined && 'reuse' in taken && taken.reuse.name).toBe('scout')
  expect(parseDesign('{"reuse":"nobody"}', SEED_CRABS, 'x')).toBeUndefined()
  const prompt = designPrompt(SEED_CRABS, 'general-purpose', 'Translate the README')
  expect(prompt.prompt).toContain('scout')
  expect(prompt.prompt).toContain('Translate the README')
})

test('the hash design is stable, and the crew never grows past its cap (seeds stay)', () => {
  expect(hashCrab('translator', 'general-purpose', ['translate'])).toEqual(hashCrab('translator', 'general-purpose', ['translate']))
  let crew = [...SEED_CRABS]
  for (let i = 0; i < 40; i += 1) {
    crew = addCrab(crew, hashCrab(`kind${i}`, 'general-purpose', []))
  }
  expect(crew.length).toBe(MAX_CRABS)
  for (const seed of SEED_CRABS) {
    expect(crew.some(c => c.name === seed.name)).toBe(true)
  }
  expect(crew.some(c => c.name === 'kind39')).toBe(true)
  expect(crew.some(c => c.name === 'kind0')).toBe(false)
})

test('every crab glyph has the width the band counts on', () => {
  for (const part of ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', '✓', '✗', '·', '…', '◦']) {
    expect(cellWidth(part)).toBe(1)
  }
  for (const one of ACCESSORIES) {
    expect(cellWidth(one)).toBe(2)
  }
})

// ── in the session: the band's crew row and the Agent row in the chat ──
const NOW = Date.parse('2026-10-09T10:00:00Z')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function start($: any, on: any, design = '{"name":"translator","color":"#F472B6","accessory":"🧭","keywords":["translate","language"]}', listed: unknown[] = []) {
  const asked: string[] = []
  let spawned = 0
  mock.env(on, { USERPROFILE: 'C:/Users/me' })
  const clock = mock.clock(on, { now: NOW })
  on('session.start', async (_$: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'session-c' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', async () => ({ value: { context: { percent: 10, window: 1 }, rateLimits: [], cost: { usd: 0 } } }))
  on('session.messages', async () => ({ value: [] }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('command.register', async (_$: unknown, e: any) => ({ value: { command: e.name } }))
  on('command.run', async () => ({ text: '' }))
  on('config.list', async () => ({ value: [] }))
  on('settings.read', async () => ({ value: {} }))
  on('tool.register', async (_$: unknown, e: any) => ({ value: { tool: `mcp__crab-crew__${e.name}` } }))
  on('tool.call', async () => ({ result: {} }))
  on('turn.complete', async (_$: unknown, e: any) => ({ text: e.answer ?? '' }))
  on('agent.list', async () => ({ value: listed }))
  on('agent.spawn', async () => {
    spawned += 1
    return { model: 'claude-haiku-4-5', agentId: `agent-${spawned}` }
  })
  on('model.complete', async (_$: unknown, e: any) => {
    asked.push(`${e.model}: ${typeof e.prompt === 'string' ? e.prompt.slice(0, 60) : ''}`)
    return { value: { isAnswered: true, text: design, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  const files: Record<string, string> = { 'C:/Users/me/.claude/settings.json': '{}' }
  on('fs.read', async (_$: unknown, e: any) => {
    const path = String(e.path).replace(/\\/g, '/')
    if (!(path in files)) {
      throw new Error('no such file')
    }
    return { value: files[path] }
  })
  on('fs.write', async (_$: unknown, e: any) => {
    const path = String(e.path).replace(/\\/g, '/')
    if (!(path in files)) {
      throw new Error('read-only in this test')   // the window registry then skips its wait
    }
    files[path] = e.text ?? ''
    return { value: undefined }
  })
  await $.session.start({ cwd: 'C:/projects/demo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'crab-crew', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 140, scroll: { offset: 0, bodyRows: 20 }, view: {} } })
  await ui.resize({ columns: 140, rows: 20, in: 'bar' })
  await ui.advance(2500)
  return { ui, clock, asked }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function lines(ui: any): Promise<string[]> {
  const flat = (node: unknown): string => (typeof node === 'string' ? node : ((node as { children?: unknown[] }).children ?? []).map(flat).join(''))
  return (((await ui.drawn({ in: 'bar' })) as { children?: unknown[] }).children ?? []).map(flat)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const spawn = ($: any, description: string, subagentType = 'general-purpose', tool_use_id = 'toolu_1') =>
  $.agent.spawn({ prompt: 'do it', description, subagentType, tool_use_id } as never)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const finish = ($: any, agentId: string, reason = 'answer') =>
  $.turn.complete({ turnId: `t-${agentId}`, agentId, reason, answer: 'done', durationMs: 12_000, isAborted: false } as never)

test('an agent of a known kind: its crab walks in the band at once, no design call, no rows added', async ($, on) => {
  const { ui, asked } = await start($, on)
  const before = (await lines(ui)).length
  await spawn($, 'Find where the auth code lives', 'Explore')
  await ui.advance(100)
  const rows = await lines(ui)
  expect(rows.length).toBe(before)   // the crew uses the blank row and the free left: the band never grows
  expect(rows[0]?.trim()).toBe('')   // the row above stays blank: one quiet line, no sprite
  expect(rows[1]).toContain('🔎 scout')
  expect(rows[1]).toContain('Find where the auth')
  expect(rows[1]).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
  expect(asked).toEqual([])
  // the spinner turns, and the band stays within the width
  const legs = new Set<string>()
  for (let i = 0; i < 6; i += 1) {
    await ui.advance(200)
    const r = await lines(ui)
    legs.add(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.exec(r[1] ?? '')?.[0] ?? '')
    for (const line of r) {
      expect(cellWidth(line)).toBeLessThanOrEqual(140)
    }
  }
  expect(legs.size).toBeGreaterThanOrEqual(2)
})

test('a new kind: an egg, one Haiku call, it hatches into the new crab; the next task of that kind reuses it', async ($, on) => {
  const { ui, asked } = await start($, on)
  await spawn($, 'Translate the app strings into Portuguese', 'general-purpose', 'toolu_a')
  await ui.advance(400)
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('haiku')
  await ui.advance(600)
  const rows = await lines(ui)
  expect(rows[1]).toContain('🧭 translator')
  await spawn($, 'translate the docs folder', 'general-purpose', 'toolu_b')
  await ui.advance(600)
  expect(asked.length).toBe(1)   // reused by its keywords: no second call
  expect((await lines(ui))[1]?.split('translator').length).toBe(3)
})

test('a crab sits when its agent ends (✓ and the time), then leaves the band; a failed one shows ✗', async ($, on) => {
  const { ui, clock } = await start($, on)
  await spawn($, 'Review the changes', 'general-purpose', 'toolu_r')
  await spawn($, 'Fix the crash', 'general-purpose', 'toolu_f')
  await ui.advance(200)
  await finish($, 'agent-1')
  await finish($, 'agent-2', 'error')
  await ui.advance(300)
  const rows = await lines(ui)
  expect(rows[1]).toContain('changes  ✓')
  expect(rows[1]).toContain('crash  ✗')
  await clock.advance(5000)
  await ui.advance(5000)
  const after = await lines(ui)
  expect(after[1]).not.toContain('reviewer')
  expect(after[1]).not.toContain('fixer')
})

test('the Agent row in the chat: the crab, the task and how it ended, on one line', async ($, on) => {
  const { clock } = await start($, on)
  await spawn($, 'Review the changes', 'general-purpose', 'toolu_row')
  await clock.advance(50)   // the crab joins the crew on its own, a moment after the spawn
  const row = await $.ui.mount({
    plugin: 'crab-crew',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'toolu_row',
    viewport: { columns: 100, rows: 40 },
    props: { tool_use_id: 'toolu_row', tool: 'Agent', input: { description: 'Review the changes', subagent_type: 'general-purpose' }, isRunning: false, isErrored: false, isInterrupted: false, output: {} },
  } as never)
  const flat = (node: any): string => (typeof node === 'string' ? node : node === null || typeof node !== 'object' ? '' : (node.children ?? []).map(flat).join(''))
  const text = flat(await row.drawn())
  expect(text).toContain('🔬 reviewer')
  expect(text).toContain('Review the changes')
  expect(text).toContain('…')   // its call returned, but its agent still works: the row says so
  await finish($, 'agent-1')
  expect(flat(await row.drawn())).toContain('✓ 12s')
  await clock.advance(6000)   // the crab has left the band: the row keeps how its agent ended
  expect(flat(await row.drawn())).toContain('✓ 12s')
  expect(text.includes('\n')).toBe(false)
})

test('keywords match whole words (a * marks a stem), so everyday words find no wrong crab', () => {
  for (const task of ['Dockerize the service', 'Webhook handler retry', 'Checkout flow implementation', 'Fixture generation for the api', 'Synthesize findings', 'Explain mapping of tokens']) {
    const crab = matchCrab(SEED_CRABS, 'general-purpose', task)
    expect(`${task} → ${crab?.name ?? 'none'}`).not.toMatch(/→ (scribe|researcher|reviewer|fixer|scout)$/)
  }
  expect(matchCrab(SEED_CRABS, 'general-purpose', 'Summarize the findings')?.name).toBe('scribe')
})

test('a busy crew: the cap never drops a crab still at work, and a label never breaks the band', async ($, on) => {
  const { ui } = await start($, on)
  for (let i = 0; i < 26; i += 1) {
    await spawn($, `Find thing number ${i}`, 'Explore', `toolu_${i}`)
  }
  await spawn($, 'fix a\nbroken\tlabel', 'general-purpose', 'toolu_nl')
  await ui.advance(300)
  const rows = await lines(ui)
  expect(rows.length).toBe(2)
  expect(rows.join('')).not.toContain('\n')
  expect(rows.join('')).not.toContain('\t')
  expect(rows[1]).toMatch(/\+\d+/)   // the ones that do not fit are counted, not dropped
  for (const line of rows) {
    expect(cellWidth(line)).toBeLessThanOrEqual(140)
  }
})

test('an Agent call sent to the background (ctrl+b) keeps its crab walking until the agent itself ends', async ($, on) => {
  const { ui } = await start($, on, undefined, [{ id: 'agent-1', description: 'Review the changes', type: 'general-purpose', status: 'running' }])
  await spawn($, 'Review the changes', 'general-purpose', 'toolu_bg')
  await ui.advance(100)
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_bg', description: 'Review the changes', prompt: 'p', subagent_type: 'general-purpose' } as never)
  await ui.advance(300)
  expect((await lines(ui))[1]).not.toContain('changes  ✓')
  await finish($, 'agent-1')
  await ui.advance(300)
  expect((await lines(ui))[1]).toContain('changes  ✓')
})
