/**
 * The crew end to end (decisions 1-6 at the hook level): Agent calls recorded
 * and the Crew pane, the inline Agent row, the Orquestrador (plan mode ->
 * Fable, approved plan -> Opus, subagent model and effort by role), generated
 * costumes for unknown roles, and the chime and tap.
 */
import type { ConfigRow, On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

const row = (key: string, kind: ConfigRow['kind'], value: ConfigRow['value'], options?: readonly string[]): ConfigRow => ({
  key,
  label: key,
  kind,
  value,
  ...(options ? { options } : {}),
  provider: { plugin: 'engine', tier: 'core' },
  isLocked: false,
})

const GRID = '{"rows":["..aa..",".abba."],"colors":{"a":"#335577","b":"#AACCEE"},"anchor":"head"}'

type Spawned = { type: string; model: string | undefined; agentId: string }

type World = {
  clock: ReturnType<typeof mock.clock>
  model: string
  sets: { key: string; value: unknown }[]
  toasts: string[]
  played: string[]
  opens: { id: string; title?: string }[]
  store: Record<string, unknown>
  spawned: Spawned[]
  /** effort each subagent request reached the model with, by agentId ('main' for the main loop) */
  efforts: { agent: string; effort: unknown }[]
  completions: number
  /** what the costume model call answers */
  reply: string
  /** an approved ExitPlanMode (false: the person rejected the plan) */
  approve: boolean
  /** Agent calls launched in the background (the call resolves at once) */
  background: boolean
  /** ms the clock moves while a foreground Agent runs */
  runMs: number
}

type WorldOptions = { model?: string; modelOptions?: readonly string[]; reduceMotion?: boolean }

/** The engine beneath the plugin. An Agent call spawns its subagent and runs one step of it, as the Agent tool does. */
function world($: Engine, on: On, o: WorldOptions = {}): World {
  const w: World = {
    clock: mock.clock(on, { now: 1_000 }),
    model: o.model ?? 'claude-opus-5-5',
    sets: [],
    toasts: [],
    played: [],
    opens: [],
    store: {},
    spawned: [],
    efforts: [],
    completions: 0,
    reply: GRID,
    approve: true,
    background: false,
    runMs: 0,
  }
  let n = 0
  on('store.get', (_$, e) => ({ value: w.store[e.key] }))
  on('store.set', (_$, e) => {
    w.store[e.key] = e.value
    return { value: undefined }
  })
  on('session.model', () => ({ value: w.model }))
  on('config.list', () => ({
    value: [
      row('theme', 'choice', 'dark'),
      row('reduceMotion', 'boolean', o.reduceMotion ?? false),
      ...(o.modelOptions ? [row('model', 'choice', w.model, o.modelOptions)] : []),
    ],
  }))
  on('config.set', (_$, e) => {
    w.sets.push({ key: e.key, value: e.value })
    if (e.key === 'model' && typeof e.value === 'string') w.model = e.value
    return { value: e.value }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.play', (_$, e) => {
    w.played.push(String(e.clip.asset ?? ''))
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    w.opens.push({ id: e.id, ...(e.title !== undefined ? { title: e.title } : {}) })
    return { value: { isPlaced: true } }
  })
  on('model.complete', () => {
    w.completions++
    return { value: { isAnswered: true as const, text: w.reply, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('agent.spawn', (_$, e) => {
    const agentId = `ag-${++n}`
    w.spawned.push({ type: e.subagentType, model: e.model, agentId })
    return { model: e.model ?? w.model, agentId }
  })
  on('turn.step', async function* (_$, e) {
    w.efforts.push({ agent: e.agentId ?? 'main', effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  on('classic.Notification', () => ({}))
  // the engine's own tool rows
  on('ui.render', { component: 'ToolUse' }, ($e, e) => {
    const { Text } = $e.ui.resolve(e)
    return <Text>engine row</Text>
  })
  on('tool.call', async (_$, e) => {
    const tool = String(e.tool)
    if (tool === 'ExitPlanMode' || tool === 'EnterPlanMode') {
      return w.approve || tool === 'EnterPlanMode' ? { result: {}, text: 'ok' } : { result: {}, text: 'The user rejected the plan', isError: true as const }
    }
    if (tool !== 'Agent') return { result: { ok: true } }
    const a = e as unknown as { tool_use_id: string; description: string; prompt: string; subagent_type?: string; model?: string }
    const r = await $.agent.spawn({
      tool_use_id: a.tool_use_id,
      prompt: a.prompt,
      description: a.description,
      subagentType: a.subagent_type ?? 'general-purpose',
      ...(a.model !== undefined ? { model: a.model } : {}),
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: w.model,
      background: w.background,
      fork: false,
    })
    const agentId = r.deny === undefined ? (r.agentId ?? '') : ''
    if (w.background) return { result: { status: 'async_launched', agentId }, text: 'launched' }
    await runStep($, agentId)
    if (w.runMs) await w.clock.advance(w.runMs)
    return { result: { agentId, content: [{ type: 'text', text: 'done' }], resolvedModel: r.deny === undefined ? r.model : '' }, text: 'done' }
  })
  return w
}

async function runStep($: Engine, agentId?: string, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'xhigh') {
  const s = $.turn.step({ turnId: `t-${agentId ?? 'main'}`, index: 0, model: 'claude-opus-5-5', effort, messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _chunk of s) {
    // drain
  }
  return s.result
}

const agent = ($: Engine, subagent_type: string | undefined, description: string, model?: 'haiku' | 'sonnet' | 'opus' | 'fable') =>
  $.tool.call({ tool: 'Agent', prompt: 'do it', description, ...(subagent_type !== undefined ? { subagent_type } : {}), ...(model ? { model } : {}) })

const crab = ($: Engine, args: string) =>
  $.command.run({ command: 'crab', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

const PANE_PROPS = { title: 'Crew', isFocused: false, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 24 }, view: {} } as const
const mountCrew = ($: Engine) => $.ui.mount({ plugin: 'crab-crew', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'crab-crew' })

const mountRow = ($: Engine, tool: string, id: string, input: unknown, state: { isRunning?: boolean; isErrored?: boolean; isInterrupted?: boolean } = {}) =>
  $.ui.mount({
    plugin: 'crab-crew',
    surface: 'desktop',
    component: 'ToolUse',
    props: { tool_use_id: id, tool, input, isRunning: state.isRunning ?? true, isErrored: state.isErrored ?? false, isInterrupted: state.isInterrupted ?? false },
    requestId: id,
  })

const complete = ($: Engine, durationMs: number, agentId?: string) =>
  $.turn.complete({ answer: '', durationMs, isAborted: false, turnId: `tc-${agentId ?? 'main'}`, reason: 'answer', ...(agentId ? { agentId } : {}) })

// ───────────────────────────── crew list, pane, inline row ─────────────────────────────

test('no subagent yet: the Crew pane shows the gallery of the 12 roles, each costume with its name and its default model', async ($, on) => {
  world($, on)
  const pane = await mountCrew($)
  expect(await pane.find({ type: 'Text', text: /Ainda não há subagentes/ })).toBeUndefined()
  const pets = await pane.findAll({ type: 'Svg' })
  expect(pets).toHaveLength(12)
  // still pets (images: nothing breathes in the gallery), each wearing its role, tinted by its role's model
  for (const svg of pets) expect(svg.props.isInteractive).toBeUndefined()
  const roles = ['Explorer', 'Architect', 'Builder', 'Guide', 'Designer', 'Coder', 'Reviewer', 'Tester', 'Security', 'Deployer', 'Researcher', 'Writer']
  const models: Record<string, string> = { Explorer: 'Haiku', Researcher: 'Haiku', Guide: 'Haiku', Tester: 'Haiku', Architect: 'Opus', Reviewer: 'Opus', Security: 'Opus' }
  for (const role of roles) {
    // one cell per role: the pet, its name, its model
    const cell = await pane.find({ key: `gal-${role}` })
    expect([role, cell?.text]).toEqual([role, `${role}${models[role] ?? 'Sonnet'}`])
    const pet = (cell?.children as { type: string; props: { alt?: unknown } }[] | undefined)?.find(c => c.type === 'Svg')
    expect([role, String(pet?.props.alt)]).toEqual([role, `${role}, ${models[role] ?? 'Sonnet'}`])
  }
  // the first subagent replaces the gallery with the crew itself
  await agent($, 'Explore', 'find the config files')
  expect(await pane.findAll({ type: 'Svg' })).toHaveLength(1)
  expect(await pane.find({ key: 'gal-Explorer' })).toBeUndefined()
  await pane.unmount()
})

test('an Agent call records the subagent; the Crew pane opens by itself at the first only; /crab crew reopens it', async ($, on) => {
  const w = world($, on)
  await agent($, 'Explore', 'find the config files')
  await agent($, undefined, 'build the usage bar')
  expect(w.opens).toEqual([{ id: 'crab-crew', title: 'Crew' }])
  const pane = await mountCrew($)
  for (const t of ['Explorer', 'Builder', 'Haiku', 'Sonnet']) expect(await pane.find({ type: 'Text', text: t })).toBeDefined()
  expect(await pane.findAll({ type: 'Svg' })).toHaveLength(2)
  // both ended: still pets (an image, no breathing frame) and a duration
  for (const svg of await pane.findAll({ type: 'Svg' })) expect(svg.props.isInteractive).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /0s · feito/ })).toBeDefined()
  await pane.unmount()
  expect(JSON.stringify(await crab($, 'crew'))).toContain('Crew aberta')
  expect(w.opens).toHaveLength(2)
})

test('a background subagent keeps working (it breathes, its duration moves) until its own turn ends', async ($, on) => {
  const w = world($, on)
  w.background = true
  await agent($, 'Plan', 'design the pane')
  const pane = await mountCrew($)
  const pet = await pane.find({ type: 'Svg' })
  expect(pet?.props.isInteractive).toBe(true)
  expect(String(pet?.props.source)).toContain('repeatCount="indefinite"')
  expect(await pane.find({ type: 'Text', text: /a trabalhar/ })).toBeDefined()
  await w.clock.advance(65_000)
  expect(await pane.find({ type: 'Text', text: /1m 05s · a trabalhar/ })).toBeDefined()
  await complete($, 65_000, w.spawned[0]?.agentId)
  expect(await pane.find({ type: 'Text', text: /1m 05s · feito/ })).toBeDefined()
  expect((await pane.find({ type: 'Svg' }))?.props.isInteractive).toBeUndefined()
  // at rest nothing ticks: the clock moves, the text stays
  await w.clock.advance(60_000)
  expect(await pane.find({ type: 'Text', text: /1m 05s · feito/ })).toBeDefined()
  await pane.unmount()
})

test('the inline Agent row: costume pet, role, description, model and status; reduced motion is still; other tools are the engine\'s', async ($, on) => {
  world($, on)
  const input = { description: 'review the diff', prompt: 'x', subagent_type: 'code-reviewer', model: 'opus' }
  const ui = await mountRow($, 'Agent', 'tu-row', input)
  const pet = await ui.find({ type: 'Svg' })
  expect(pet?.props.isInteractive).toBe(true)
  expect(String(pet?.props.alt)).toContain('Reviewer')
  for (const t of ['Reviewer', 'review the diff', 'Opus', 'a trabalhar']) expect(await ui.find({ type: 'Text', text: t })).toBeDefined()
  await ui.unmount()
  const done = await mountRow($, 'Agent', 'tu-row2', input, { isRunning: false, isErrored: true })
  expect(await done.find({ type: 'Text', text: 'erro' })).toBeDefined()
  expect(String((await done.find({ type: 'Svg' }))?.props.source)).toContain('#E5484D')
  expect((await done.find({ type: 'Svg' }))?.props.isInteractive).toBeUndefined()
  await done.unmount()
  await crab($, 'motion reduced')
  const still = await mountRow($, 'Agent', 'tu-row3', input)
  expect((await still.find({ type: 'Svg' }))?.props.isInteractive).toBeUndefined()
  expect(String((await still.find({ type: 'Svg' }))?.props.source)).not.toContain('<animate')
  await still.unmount()
  // other tools: never a pet. The clean chat (on by default, merged from comfort) hides a plain row;
  // with it off the row is the engine's.
  const quiet = await mountRow($, 'Bash', 'tu-bash', { command: 'ls' })
  expect(await quiet.find({ text: 'engine row' })).toBeUndefined()
  expect(await quiet.find({ type: 'Svg' })).toBeUndefined()
  await quiet.unmount()
  await $.command.run({ command: 'clean', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  const bash = await mountRow($, 'Bash', 'tu-bash2', { command: 'ls' })
  expect(await bash.find({ text: 'engine row' })).toBeDefined()
  expect(await bash.find({ type: 'Svg' })).toBeUndefined()
  expect(await bash.find({ type: 'Text', text: 'a trabalhar' })).toBeUndefined()
  await bash.unmount()
})

// ───────────────────────────── orchestrator: subagents ─────────────────────────────

test('agent.spawn picks the model by role only when the call named none and the type is built-in', async ($, on) => {
  const w = world($, on)
  await agent($, 'Explore', 'look around')
  await agent($, 'Plan', 'plan it')
  await agent($, undefined, 'build it')
  await agent($, 'claude-code-guide', 'how do hooks work')
  // the main agent's explicit choice wins
  await agent($, 'Explore', 'look harder', 'opus')
  // a person's or plugin's agent may pin its own model: left alone
  await agent($, 'ui-designer', 'design the card')
  expect(w.spawned.map(s => s.model)).toEqual(['haiku', 'opus', 'sonnet', 'haiku', 'opus', undefined])
  await crab($, 'orchestrator off')
  await agent($, 'Explore', 'look again')
  expect(w.spawned.at(-1)?.model).toBeUndefined()
})

test('turn.step holds each crew subagent at its role effort (haiku low, sonnet medium, opus high); the main loop is untouched', async ($, on) => {
  const w = world($, on)
  await agent($, 'Explore', 'look around')
  await agent($, undefined, 'build it')
  await agent($, 'Plan', 'plan it')
  await runStep($)
  expect(w.efforts).toEqual([
    { agent: 'ag-1', effort: 'low' },
    { agent: 'ag-2', effort: 'medium' },
    { agent: 'ag-3', effort: 'high' },
    { agent: 'main', effort: 'xhigh' },
  ])
  // an effort the call named itself is left, and so is everything with the Orquestrador off
  await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'look', subagent_type: 'Explore', effort: 'max' })
  await crab($, 'orchestrator off')
  await agent($, 'Explore', 'look again')
  expect(w.efforts.slice(4)).toEqual([
    { agent: 'ag-4', effort: 'xhigh' },
    { agent: 'ag-5', effort: 'xhigh' },
  ])
})

// ───────────────────────────── costumes for unknown roles ─────────────────────────────

test('an unknown role asks haiku once per type (parallel spawns too) and stores the grid; the row wears it', async ($, on) => {
  const w = world($, on)
  await Promise.all([agent($, 'quantum-widget', 'frobnicate the flux'), agent($, 'quantum-widget', 'frobnicate again')])
  await w.clock.advance(0)
  expect(w.completions).toBe(1)
  expect(w.store['costume:quantum-widget']).toEqual(JSON.parse(GRID))
  await agent($, 'Quantum-Widget', 'once more')
  await w.clock.advance(0)
  expect(w.completions).toBe(1)
  const ui = await mountRow($, 'Agent', 'tu-q', { description: 'frobnicate', prompt: 'x', subagent_type: 'quantum-widget' })
  expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toContain('#335577')
  expect(await ui.find({ type: 'Text', text: 'quantum-widget' })).toBeDefined()
  await ui.unmount()
})

test('a costume already in the store is read with no call; an invalid reply stores plain and is never asked again', async ($, on) => {
  const w = world($, on)
  w.store['costume:old-friend'] = JSON.parse(GRID)
  await agent($, 'old-friend', 'hello')
  await w.clock.advance(0)
  expect(w.completions).toBe(0)
  w.reply = 'Sure! Here is a hat: {"rows":["xx"],"colors":{"x":"red"}}'
  await agent($, 'odd-one', 'hello')
  await w.clock.advance(0)
  expect(w.completions).toBe(1)
  expect(w.store['costume:odd-one']).toBe('plain')
  await agent($, 'odd-one', 'hello again')
  await w.clock.advance(0)
  expect(w.completions).toBe(1)
})

// ───────────────────────────── orchestrator: plan mode ─────────────────────────────

test('entering plan mode (UserPromptSubmit) switches to Fable with a quiet toast, once per entry; an approved ExitPlanMode switches to Opus', async ($, on) => {
  const w = world($, on)
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'plan' })
  expect(w.sets).toEqual([{ key: 'model', value: 'fable' }])
  expect(w.toasts).toEqual(['Opus → Fable'])
  // still in plan: nothing more; the person's own choice in between stands
  w.model = 'claude-sonnet-5-5' // the person picks Sonnet in the app
  await $.classic.UserPromptSubmit({ prompt: 'y', permission_mode: 'plan' })
  expect(w.sets).toHaveLength(1)
  await $.tool.call({ tool: 'ExitPlanMode' })
  expect(w.sets.at(-1)).toEqual({ key: 'model', value: 'opus' })
  expect(w.toasts.at(-1)).toBe('Sonnet → Opus')
  // a new entry (EnterPlanMode) switches again
  await $.tool.call({ tool: 'EnterPlanMode' })
  expect(w.sets.at(-1)).toEqual({ key: 'model', value: 'fable' })
})

test('a rejected ExitPlanMode switches nothing', async ($, on) => {
  const w = world($, on, { model: 'claude-fable-5-1' })
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'plan' })
  expect(w.sets).toEqual([])
  w.approve = false
  await $.tool.call({ tool: 'ExitPlanMode' })
  expect(w.sets).toEqual([])
  expect(w.toasts).toEqual([])
})

test('a model row without Fable: Opus instead, and the fallback is said once', async ($, on) => {
  const w = world($, on, { model: 'claude-sonnet-5-5', modelOptions: ['default', 'haiku', 'sonnet', 'opus'] })
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'plan' })
  expect(w.sets).toEqual([{ key: 'model', value: 'opus' }])
  const fallback = w.toasts.filter(t => t.includes('Fable não está disponível'))
  expect(fallback).toHaveLength(1)
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'default' })
  w.model = 'claude-sonnet-5-5' // the person picks Sonnet in the app
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'plan' })
  expect(w.sets.at(-1)).toEqual({ key: 'model', value: 'opus' })
  expect(w.toasts.filter(t => t.includes('Fable não está disponível'))).toHaveLength(1)
})

test('with the Orquestrador off nothing switches', async ($, on) => {
  const w = world($, on)
  await crab($, 'orchestrator off')
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'plan' })
  await $.tool.call({ tool: 'ExitPlanMode' })
  await $.tool.call({ tool: 'EnterPlanMode' })
  expect(w.sets).toEqual([])
  expect(w.toasts).toEqual([])
})

// ───────────────────────────── sounds ─────────────────────────────

test('the chime plays when a turn of 2 min or more finishes, not at 1:59; /crab chime off silences it', async ($, on) => {
  const w = world($, on)
  await complete($, 119_000)
  expect(w.played).toEqual([])
  await complete($, 120_000)
  expect(w.played).toEqual(['assets/chime.wav'])
  await crab($, 'chime off')
  await complete($, 300_000)
  expect(w.played).toHaveLength(1)
})

test('a subagent of 2 min or more chimes once when it finishes; a short one does not', async ($, on) => {
  const w = world($, on)
  await agent($, 'Explore', 'quick look')
  expect(w.played).toEqual([])
  w.runMs = 125_000
  await agent($, 'Plan', 'long plan')
  expect(w.played).toEqual(['assets/chime.wav'])
  // its own turn.complete after the result: the first end stands, no second chime
  await complete($, 125_000, 'ag-2')
  expect(w.played).toHaveLength(1)
})

test('the tap plays when the app needs approval, once per 1.5 s; other notifications and /crab tap off are silent', async ($, on) => {
  const w = world($, on)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  expect(w.played).toEqual(['assets/tap.wav'])
  await w.clock.advance(2_000)
  await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
  expect(w.played).toHaveLength(2)
  await w.clock.advance(2_000)
  await $.classic.Notification({ message: 'Signed in', notification_type: 'auth_success' })
  expect(w.played).toHaveLength(2)
  await crab($, 'tap off')
  await w.clock.advance(2_000)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
  expect(w.played).toHaveLength(2)
})
