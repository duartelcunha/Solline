/**
 * The docked card end to end on the desktop surface: AbovePrompt draws ONE card
 * above the prompt box (the slim bar by default, a transparent Client region
 * over all of it); AssistantMessage draws the reply's body only. No Apply:
 * choosing a model, an effort or a mode applies it at once (config.set, the
 * effort that reaches turn.step, the permission-mode tool).
 */
import type { ConfigRow, JsonValue, On, SessionMessage } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'
import { iconMarkup, type EffortIconKind, type IconView } from '../hooks/card/effort-icon'
import { MODE_ICON } from '../hooks/card/mode-icons'

const MODE_TOOL = 'mcp__ccd_session_mgmt__set_session_permission_mode'

const BODY = 'Feito. A barra já mostra o uso.'
const footer = (model: string, effort: string, mode: string, task = 'barra de uso'): string =>
  ['**Próximo passo**', `- **Tarefa**: ${task}`, `- **Modelo**: ${model}`, `- **Effort**: ${effort}`, `- **Modo**: ${mode}`].join('\n')
const footerEn = (model: string, effort: string, mode: string): string =>
  ['**Next step**', '- **Task**: usage bar', `- **Model**: ${model}`, `- **Effort**: ${effort}`, `- **Mode**: ${mode}`].join('\n')

const row = (key: string, kind: ConfigRow['kind'], value: ConfigRow['value']): ConfigRow => ({
  key,
  label: key,
  kind,
  value,
  provider: { plugin: 'engine', tier: 'core' },
  isLocked: false,
})

type World = {
  clock: ReturnType<typeof mock.clock>
  model: string
  sets: { key: string; value: unknown }[]
  modes: unknown[]
  efforts: unknown[]
  toasts: string[]
  played: unknown[]
  opens: string[]
  /** what the plugin stored ($.store) */
  store: Record<string, unknown>
  /** with `hold`: resolves once the mode tool was called; release() answers it */
  modeCalled: Promise<void>
  release: () => void
  /** with `holdModel`: answers the waiting config.set of the model */
  releaseModel: () => void
}

type WorldOptions = {
  /** config.set of the model waits for releaseModel() (the card must not show the choice before it returned) */
  holdModel?: boolean
  model?: string
  theme?: string
  reduceMotion?: boolean
  hold?: boolean
  denyModel?: string
  modeError?: string
  playFails?: boolean
  /** `/model` (session.model) keeps the old model after config.set until the next request (the app applies it lazily) */
  lagModel?: boolean
}

/** The engine beneath the plugin: model, config rows, config.set, the mode tool, a clock, a store, audio, toasts. */
function world(on: On, opts: WorldOptions | string = {}): World {
  const o: WorldOptions = typeof opts === 'string' ? { model: opts } : opts
  let called: () => void = () => undefined
  const w: World = {
    clock: mock.clock(on, { now: 1_000 }),
    model: o.model ?? 'claude-opus-5-5',
    sets: [],
    modes: [],
    efforts: [],
    toasts: [],
    played: [],
    opens: [],
    store: {},
    modeCalled: new Promise<void>(res => {
      called = res
    }),
    release: () => undefined,
    releaseModel: () => undefined,
  }
  on('store.get', (_$, e) => ({ value: w.store[e.key] }))
  on('store.set', (_$, e) => {
    w.store[e.key] = e.value
    return { value: undefined }
  })
  on('session.model', () => ({ value: w.model }))
  on('config.list', () => ({ value: [row('theme', 'choice', o.theme ?? 'dark'), row('reduceMotion', 'boolean', o.reduceMotion ?? false)] }))
  on('config.set', (_$, e) => {
    w.sets.push({ key: e.key, value: e.value })
    if (o.denyModel !== undefined && e.key === 'model') return { deny: o.denyModel }
    const apply = () => {
      if (e.key === 'model' && typeof e.value === 'string' && !o.lagModel) w.model = e.value
      return { value: e.value }
    }
    if (o.holdModel && e.key === 'model') return new Promise(res => (w.releaseModel = () => res(apply())))
    return apply()
  })
  on('tool.call', (_$, e) => {
    if (String(e.tool) === MODE_TOOL) w.modes.push((e as unknown as { mode?: unknown }).mode)
    called()
    if (o.modeError !== undefined) return { result: { ok: false }, isError: true as const, text: o.modeError }
    // hold: the first mode call waits for release() (the approval card); later ones answer at once
    if (o.hold && w.modes.length === 1) return new Promise(res => (w.release = () => res({ result: { ok: true } })))
    return { result: { ok: true } }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    w.opens.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('audio.play', (_$, e) => {
    w.played.push(e)
    if (o.playFails) throw new Error('no player')
    return { value: undefined }
  })
  on('classic.UserPromptSubmit', () => ({}))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('turn.step', async function* (_$, e) {
    w.efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  lastWorld = w
  return w
}

/** the world of the running test, so a card can settle: past the motion's end, the next redraw draws no SMIL */
let lastWorld: World | null = null
async function settle(ui: { advance: (ms: number) => Promise<void>; redraw: () => Promise<void> }): Promise<void> {
  await lastWorld?.clock.advance(1_000)
  await ui.advance(16)
  await ui.redraw()
}

/** Columns the band keeps at its right edge for the native gear (register.tsx GEAR_COLS): a band of N + GEAR columns draws an N-column card. */
const GEAR = 3
const bandProps = (bodyColumns = 70 + GEAR, over: { hasSurvey?: boolean } = {}) =>
  ({ hasSurvey: false, isWorking: false, maxRows: 24, bodyColumns, scroll: { offset: 0, bodyRows: 24 }, view: {}, ...over }) as const

/** The docked card: the band above the prompt on the desktop surface. */
const mountDock = ($: Engine, bodyColumns = 70 + GEAR, over: { hasSurvey?: boolean } = {}) =>
  $.ui.mount({ plugin: 'crab-crew', surface: 'desktop', component: 'AbovePrompt', props: bandProps(bodyColumns, over), requestId: 'prompt-band' })

/** A reply, as the transcript draws it. */
const mountReply = ($: Engine, text: string, requestId = 'msg-1') =>
  $.ui.mount({ plugin: 'crab-crew', surface: 'desktop', component: 'AssistantMessage', props: { text, isFirstOfReply: true }, requestId })

const crab = ($: Engine, args: string) =>
  $.command.run({ command: 'crab', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

async function step($: Engine, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'medium', agentId?: string) {
  const s = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort, messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _chunk of s) {
    // drain
  }
  return s.result
}

/** The session as the app reports it: its effort on a main-thread request, its permission mode on a prompt. */
async function sessionAt($: Engine, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max', mode: string) {
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: mode })
  await step($, effort)
}

const append = ($: Engine, uuid: string, text: string) =>
  $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
    door: 'response',
    origin: { kind: 'model', model: 'claude-opus-5-5' },
    uuid,
  })

type Dock = Awaited<ReturnType<typeof mountDock>>
const svgOf = async (ui: Dock) => (await ui.find({ type: 'Svg' }))?.props
const source = async (ui: Dock): Promise<string> => String((await svgOf(ui))?.source)
const alt = async (ui: Dock): Promise<string> => String((await svgOf(ui))?.alt)

/** The footer of the Client region's tag is gone: a zone message is just the zone. */
const zone = (ui: Dock, id: string | null, phase: 'down' | 'up' | 'hover' = 'down') => ui.post({ kind: 'zone', id, phase })
const tap = async (ui: Dock, id: string) => {
  await zone(ui, id, 'down')
  await zone(ui, id, 'up')
}
const commit = (ui: Dock, level: number, via: 'tap' | 'drag' = 'tap') =>
  ui.post({ kind: 'effort-commit', level, x: 29 + 125.5 * level, velocity: 0, via })
const expand = async (ui: Dock) => {
  await zone(ui, 'body', 'down')
  await ui.advance(16)
}

/** the native controls of the fallback row, none of them drawn by default */
const NATIVE = ['cc-toggle', 'cc-hide', 'cc-show', 'cc-settings', 'cc-adjust', 'cc-apply', 'cc-sel-model', 'cc-sel-effort', 'cc-sel-mode']
const noNative = async (ui: Dock): Promise<void> => {
  for (const key of NATIVE) expect([key, await ui.find({ key })]).toEqual([key, undefined])
  // the one native Button by default: the gear safety net beside the card
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['cc-gear'])
  expect(await ui.find({ type: 'Select' })).toBeUndefined()
}

/** A drawn node, as `ui.drawn()` gives it. */
type Node = { type: string; props: { [k: string]: unknown }; children?: Node[] }
/** Every Client of a drawn tree with the nodes above it, outermost first. */
function clientsIn(n: Node, up: Node[] = []): { client: Node; up: Node[] }[] {
  if (n.type === 'Client') return [{ client: n, up }]
  return (n.children ?? []).flatMap(c => clientsIn(c, [...up, n]))
}
const byKey = (n: Node, key: string): Node | undefined => (n.props.key === key ? n : (n.children ?? []).map(c => byKey(c, key)).find(x => x !== undefined))

/**
 * The layer stack the desktop needs for the pointer to reach the Client: the Svg in an absolute Box drawn first, the
 * Client in flow after it in a relative Box, sized explicitly in cells, never inside an absolute Box; the stack as
 * big as the region (it cannot collapse), and the native gear beside it, outside the Svg.
 */
async function expectStack(ui: Dock, cols: number, rows: number): Promise<void> {
  const root = (await ui.drawn()) as unknown as Node
  const found = clientsIn(root)
  expect(found).toHaveLength(1)
  for (const { client, up } of found) {
    expect(up.filter(b => b.props.position === 'absolute')).toEqual([])
    expect([client.props.width, client.props.height]).toEqual([cols, rows])
  }
  const stack = byKey(root, 'cc-stack')
  expect(stack?.props).toMatchObject({ position: 'relative', width: cols, height: rows })
  const [art, hit] = stack?.children ?? []
  expect(art?.props).toMatchObject({ key: 'cc-art', position: 'absolute', top: 0, left: 0 })
  expect(art?.children?.map(c => c.type)).toEqual(['Svg'])
  expect(hit?.props).toMatchObject({ key: 'cc-hit', position: 'relative', width: cols, height: rows })
  expect(hit?.children?.map(c => c.type)).toEqual(['Client'])
  // the gear: a sibling of the stack, outside the Svg
  expect(root.children?.map(c => c.props.key)).toEqual(['cc-stack', 'cc-gear'])
  expect(root.children?.[1]?.type).toBe('Button')
}

// ───────────────────────────── the dock ─────────────────────────────

test('AbovePrompt draws ONE docked card: the slim bar by default, the session alone before any reply, a Client in flow over it, one native gear', async ($, on) => {
  world(on)
  const ui = await mountDock($)
  const svg = await svgOf(ui)
  expect(svg?.isInteractive).toBe(true)
  expect(svg?.width).toBe(560) // 70 columns of the default 8 px cell: the band's 73 less the gear's 3, not a scaled layout
  expect(svg?.height).toBe(48) // the bar, not the 184 px card
  expect(String(svg?.alt)).toBe('Session: Opus 5.5, high effort, Ask mode.') // no reply yet: the session alone
  // the bar: [effort rail + pet knob] Opus 5.5 [mode icon] … [crew] [hide] [chevron] [gear], the controls at the right edge
  const src = await source(ui)
  expect(src).toContain('>Opus<tspan')
  expect(src).toContain('translate(510 24)')
  expect(src).toContain('class="cc-gear"')
  expect(src).toContain('class="cc-crew"')
  expect(src).toContain('class="cc-bar-rail"')
  expect(src).toContain('<g class="cc-bar-knob" transform="translate(60 22)"><svg ') // the pet, the default icon, on the high tick
  expect(src).not.toContain('y="98"') // not the expanded rail
  expect(src).not.toContain('class="cc-rec')
  // the Client region in flow, sized in cells (560 / 8 x ceil(48 / 16)), with the bar's zones and its effort band (svg.ts owns them)
  const client = await ui.find({ type: 'Client' })
  expect(client?.key).toBe('cc-region')
  expect([client?.props.width, client?.props.height]).toEqual([70, 3])
  const props = client?.props.props as { zones?: { id: string }[]; slider?: unknown; rail?: unknown; svgHeight?: number } | undefined
  expect(props?.zones?.map(z => z.id)).toEqual(['crew', 'hide', 'chev', 'gear', 'body'])
  expect(props?.svgHeight).toBe(48)
  expect(props?.slider).toEqual({ x: 16, y: 4, w: 88, h: 40 })
  expect(props?.rail).toEqual({ x0: 28, step: 16, count: 5 })
  // nothing native but the gear
  await noNative(ui)
  expect(await ui.findAll({ type: 'Client' })).toHaveLength(1)
  await ui.unmount()
})

test('the layer stack: the Svg in an absolute Box drawn first, the Client in flow (never inside an absolute Box) with an explicit size, the native gear outside the Svg; every look', async ($, on) => {
  const x = world(on)
  const ui = await mountDock($)
  await expectStack(ui, 70, 3) // the bar: 48 px over 16 px rows
  await expand(ui)
  await expectStack(ui, 70, 12) // the card: 184 px, rounded up
  await tap(ui, 'hide')
  await expectStack(ui, 70, 2) // the handle: 20 px
  // the native gear opens the pane in every look
  await ui.press({ key: 'cc-gear' })
  expect(x.opens).toEqual(['crab-settings'])
  // a band of another width: the region follows the card's columns
  await ui.unmount()
  const narrow = await mountDock($, 40 + GEAR)
  await expectStack(narrow, 40, 2)
  await narrow.unmount()
})

test('the crew control on the bar opens the Crew pane (and on the card)', async ($, on) => {
  const x = world(on)
  const ui = await mountDock($)
  await tap(ui, 'crew')
  expect(x.opens).toEqual(['crab-crew'])
  // a press on the crew does not expand the bar
  expect((await svgOf(ui))?.height).toBe(48)
  await expand(ui)
  await tap(ui, 'crew')
  expect(x.opens).toEqual(['crab-crew', 'crab-crew'])
  // by the pointer too: the crew's target x 440..468 on the 560 px bar -> column 56
  await tap(ui, 'chev')
  await ui.resize({ columns: 70, rows: 3 })
  await ui.pointer({ type: 'down', x: 56, y: 1, button: 'left' })
  await ui.advance(16)
  await ui.pointer({ type: 'up', x: 56, y: 1, button: 'left' })
  expect(x.opens).toEqual(['crab-crew', 'crab-crew', 'crab-crew'])
  await ui.unmount()
})

test('the bar\'s compact rail: a tap on a step or a drag changes the effort the next turn goes out with; the pet plays on the change and on hover, then rests', async ($, on) => {
  const x = world(on)
  const ui = await mountDock($)
  await ui.resize({ columns: 70, rows: 3 })
  // a tap on the max tick (x 92 -> column 11)
  await ui.pointer({ type: 'down', x: 11, y: 1, button: 'left' })
  await ui.advance(16)
  await ui.pointer({ type: 'up', x: 11, y: 1, button: 'left' })
  await ui.advance(32)
  expect(await alt(ui)).toContain('max effort')
  await step($, 'medium')
  expect(x.efforts.at(-1)).toBe('max')
  // the pet plays the max sequence (one discrete strip), on the bar's knob
  const playing = await source(ui)
  expect(playing).toMatch(/class="cc-bar-knob" transform="translate\(92 22\)">.*calcMode="discrete" values="-64 0;/)
  // a drag from the max tick down to low (x 28 -> column 3)
  await ui.pointer({ type: 'down', x: 11, y: 1, button: 'left' })
  await ui.advance(16)
  await ui.pointer({ type: 'move', x: 7, y: 1, button: 'left' })
  await ui.advance(16)
  await ui.pointer({ type: 'move', x: 3, y: 1, button: 'left' })
  await ui.advance(16)
  await ui.pointer({ type: 'up', x: 3, y: 1, button: 'left' })
  await ui.advance(32)
  expect(await alt(ui)).toContain('low effort')
  await step($, 'medium')
  expect(x.efforts.at(-1)).toBe('low')
  // at rest: nothing animates, an idle redraw is the same tree
  await settle(ui)
  const rest = await source(ui)
  expect(rest).not.toContain('<animate')
  await ui.redraw()
  expect(await source(ui)).toBe(rest)
  // hover over the rail: one play of the level on screen, then still again
  await ui.pointer({ type: 'move', x: 4, y: 1 })
  await ui.advance(16)
  const hovered = await source(ui)
  expect(hovered).toContain('calcMode="discrete"')
  // moving on the rail does not restart it
  await ui.pointer({ type: 'move', x: 5, y: 1 })
  await ui.advance(16)
  expect(await source(ui)).toBe(hovered)
  await settle(ui)
  expect(await source(ui)).not.toContain('<animate')
  await ui.unmount()
})

test('truthful model: the pill moves only once config.set returned ok; a refusal leaves it and says why', async ($, on) => {
  const x = world(on, { holdModel: true })
  await crab($, 'orchestrator off')
  const ui = await mountDock($)
  await expand(ui)
  const pressed = tap(ui, 'm0') // Haiku; config.set waits
  for (let i = 0; i < 5 && x.sets.length === 0; i++) await x.clock.advance(1)
  expect(x.sets).toEqual([{ key: 'model', value: 'haiku' }])
  expect(await alt(ui)).toContain('Opus 5.5') // not before it returned
  x.releaseModel()
  await pressed
  expect(await alt(ui)).toContain('Haiku 5.5')
  await ui.unmount()
})

test('the diag log: the Client layout, a pointer down with its zone, a miss, config.set and each turn.step (before and after the override), ISO-timed, rolling', async ($, on) => {
  const x = world(on)
  const writes: { path: string; text: string }[] = []
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\test' : undefined }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  const log = (): string => writes.at(-1)?.text ?? ''
  const until = async (re: RegExp): Promise<void> => {
    for (let i = 0; i < 50 && !re.test(log()); i++) await x.clock.advance(1)
  }
  const ui = await mountDock($)
  await ui.resize({ columns: 70, rows: 3 })
  await ui.advance(16)
  await until(/Client layout/)
  expect(writes.at(-1)?.path.split(String.fromCharCode(92)).join('/')).toBe('C:/Users/test/.claude/crab-crew/diag.log')
  expect(log()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z card layout look=bar svg=560x48px region=70x3 cells cell=8x16px band=73 cols$/m)
  expect(log()).toMatch(/Z Client layout columns=70 rows=3$/m)
  expect(log()).toMatch(/Z ui\.render AbovePrompt x\d+ look=bar band=73 cols$/m)
  // a pointer down on the chevron: the zone it resolved to, and the cell
  await ui.pointer({ type: 'down', x: 63, y: 1, button: 'left' })
  await ui.advance(16)
  await ui.pointer({ type: 'up', x: 63, y: 1, button: 'left' })
  await ui.advance(16)
  await until(/pointer up zone=chev/)
  expect(log()).toMatch(/Z pointer up zone=chev inside=(true|false)$/m) // the card expanded on the down: the up lands on the new drawing
  expect(log()).toMatch(/Z pointer down zone=chev at=\[63,1\]$/m)
  // a model chosen on the card: config.set's result
  await tap(ui, 'm0')
  await until(/config\.set model/)
  expect(log()).toMatch(/Z config\.set model="haiku" -> ok \("haiku"\)$/m)
  expect(log()).toMatch(/Z card model -> haiku: applied$/m)
  // the next turn: the model and effort it went out with, before and after the card's override
  await commit(ui, 4)
  await step($, 'medium')
  await until(/turn\.step main/)
  expect(log()).toMatch(/Z turn\.step main model=claude-opus-5-5 effort=medium -> model=claude-opus-5-5 effort=max \(card override\)$/m)
  // a press on no zone says where it landed
  await ui.resize({ columns: 70, rows: 12 })
  await ui.pointer({ type: 'down', x: 2, y: 11, button: 'left' })
  await ui.advance(32)
  await until(/zone=none/)
  expect(log()).toMatch(/Z pointer down zone=none at=\[2,11\] px=\[/m)
  // rolling: never more than 200 lines
  for (let i = 0; i < 120; i++) await step($, 'medium')
  await until(/turn\.step main(?:[^\n]*\n){150}/)
  for (let i = 0; i < 60; i++) await x.clock.advance(1)
  expect(log().trimEnd().split('\n').length).toBeLessThanOrEqual(200)
  // off: nothing more is written
  await crab($, 'diag off')
  const n = writes.length
  await step($, 'medium')
  for (let i = 0; i < 10; i++) await x.clock.advance(1)
  expect(writes.length).toBe(n)
  await ui.unmount()
})

test('the bar shows the live session and the latest reply\'s recommendation as the quiet chip', async ($, on) => {
  world(on, 'claude-haiku-5-5')
  mock.session(on)
  await crab($, 'orchestrator off')
  await sessionAt($, 'high', 'default')
  const ui = await mountDock($)
  expect(await alt(ui)).toContain('Haiku 5.5')
  await append($, 'u-1', `${BODY}\n\n${footer('Sonnet 5.5', 'xhigh', 'plan mode')}`)
  // the session is still Haiku: the recommendation is the outline, named in the label and drawn as the chip
  expect(await alt(ui)).toBe('Next step: barra de uso. Haiku 5.5, high effort, Ask mode. Recommended: Sonnet 5.5, xhigh effort, Plan mode.')
  const src = await source(ui)
  expect(src).toContain('class="cc-rec-chip"')
  expect(src).toContain('>Sonnet · xhigh</text>')
  expect(src).not.toContain('>Sonnet<tspan') // the bar names what the session runs
  await settle(ui)
  // the next reply replaces the recommendation
  await append($, 'u-2', footer('Haiku 5.5', 'low', 'auto mode', 'nova'))
  expect(await alt(ui)).toContain('Next step: nova.')
  expect(await source(ui)).toContain('>Haiku · low</text>') // still a chip: the session is high / Ask
  await ui.unmount()
})

test('expanded, the same card outlines the recommendation: dashed pills where the session differs, a ring on the tick, the task on top', async ($, on) => {
  world(on)
  mock.session(on)
  await crab($, 'orchestrator off')
  await sessionAt($, 'high', 'auto')
  await append($, 'u-1', `${BODY}\n\n${footer('Sonnet 5.5', 'xhigh', 'plan mode')}`)
  const ui = await mountDock($)
  await expand(ui)
  await settle(ui)
  expect((await svgOf(ui))?.height).toBe(184)
  const src = await source(ui)
  expect(src).toContain('>barra de uso</text>')
  // the session runs Opus: the dashed outline sits on Sonnet and Plan, the ring on the xhigh tick
  expect(src).toContain('<rect class="cc-rec" x="150.5" y="48.5"')
  expect(src).toContain('<rect class="cc-rec" x="18.5" y="138.5"')
  expect(src).toContain('<circle class="cc-rec" cx="405.5" cy="100" r="4.5"')
  expect(src).not.toContain('cc-rec-chip')
  expect(await alt(ui)).toContain('Recommended: Sonnet 5.5, xhigh effort, Plan mode.')
  const props = (await ui.find({ type: 'Client' }))?.props.props as { zones?: { id: string }[]; slider?: unknown; rail?: unknown } | undefined
  expect(props?.zones?.map(z => z.id)).toEqual(['crew', 'hide', 'chev', 'gear', 'm0', 'm1', 'm2', 'm3', 'o0', 'o1', 'o2', 'o3'])
  expect(props?.rail).toEqual({ x0: 29, step: 125.5, count: 5 })
  await noNative(ui)
  await ui.unmount()
})

test('expand and collapse by the zones; the choice is remembered in the store and starts the next card the same way', async ($, on) => {
  const x = world(on)
  const ui = await mountDock($)
  expect((await svgOf(ui))?.height).toBe(48)
  // the bar is one target: pressing it expands, at once (a fixed height per look, nothing eases the frame)
  await zone(ui, 'body', 'down')
  await ui.advance(16)
  expect(x.store.dock).toBe('expanded')
  expect((await svgOf(ui))?.height).toBe(184)
  expect(await source(ui)).not.toContain('<animate')
  // the chevron collapses
  await tap(ui, 'chev')
  expect(x.store.dock).toBe('bar')
  expect((await svgOf(ui))?.height).toBe(48)
  await tap(ui, 'chev')
  await ui.unmount()
  // a new drawing (a new session) starts as the person left it
  expect(x.store.dock).toBe('expanded')
  const again = await mountDock($)
  await settle(again)
  expect((await svgOf(again))?.height).toBe(184)
  await again.unmount()
})

test('a card left expanded in the store starts expanded (the older `expanded` key too); absent starts as the bar', async ($, on) => {
  const x = world(on)
  x.store.expanded = true
  const ui = await mountDock($)
  expect((await svgOf(ui))?.height).toBe(184)
  await ui.unmount()
})

test('the pointer reaches the zones: a Haiku pill press applies config.set, the gear opens the pane, the chevron collapses', async ($, on) => {
  const x = world(on)
  const ui = await mountDock($)
  // the bar at 70 columns: cells are 8 x 12 px; the chevron's target x 496..524 (cell 63), the gear's 524..552 (cell 67)
  // (a region laid out at other rows than it asked for maps them over the drawing, as before 0.7.0)
  await ui.resize({ columns: 70, rows: 4 })
  await ui.advance(16) // the region reports its layout (the diag log) on the next frame
  await ui.pointer({ type: 'down', x: 63, y: 1, button: 'left' })
  await ui.advance(16)
  await ui.pointer({ type: 'up', x: 63, y: 1, button: 'left' })
  await ui.advance(32)
  await settle(ui)
  expect((await svgOf(ui))?.height).toBe(184) // the chevron expanded it
  // the gear
  await ui.resize({ columns: 70, rows: 13 })
  await ui.advance(16)
  expect(x.opens).toEqual([])
  await ui.pointer({ type: 'down', x: 67, y: 1, button: 'left' })
  await ui.advance(16)
  await ui.pointer({ type: 'up', x: 67, y: 1, button: 'left' })
  expect(x.opens).toEqual(['crab-settings'])
  // Haiku's pill (first column): x 92, y 72 -> cell (11, 4)
  await ui.pointer({ type: 'down', x: 11, y: 4, button: 'left' })
  await ui.advance(16)
  await ui.pointer({ type: 'up', x: 11, y: 4, button: 'left' })
  await ui.advance(32)
  expect(await alt(ui)).toContain('Haiku 5.5')
  expect(x.sets).toEqual([{ key: 'model', value: 'haiku' }])
  expect(x.played).toHaveLength(1)
  await ui.unmount()
})

test('the gear zone opens the "Crab Crew" pane (on the bar and on the card)', async ($, on) => {
  const x = world(on)
  const ui = await mountDock($)
  await tap(ui, 'gear')
  expect(x.opens).toEqual(['crab-settings'])
  await expand(ui)
  await tap(ui, 'gear')
  expect(x.opens).toEqual(['crab-settings', 'crab-settings'])
  // opening the pane did not toggle the card
  await settle(ui)
  expect((await svgOf(ui))?.height).toBe(184)
  await ui.unmount()
})

test('the card is laid out at the band\'s width: 40 columns draw it 320 px wide, nothing scaled, the Client maps its own cells onto it', async ($, on) => {
  const x = world(on)
  const ui = await mountDock($, 40 + GEAR)
  await expand(ui)
  await settle(ui)
  const svg = await svgOf(ui)
  expect([svg?.width, svg?.height]).toEqual([320, 184]) // the height is the look's, whatever the width
  expect(String(svg?.source)).toContain('width="320" height="184" viewBox="0 0 320 184"')
  const client = await ui.find({ type: 'Client' })
  expect([client?.props.width, client?.props.height]).toEqual([40, 12])
  const props = client?.props.props as { svgWidth?: number; svgHeight?: number; cellW?: number; measure?: unknown; zones?: { id: string; x: number; w: number }[] } | undefined
  expect([props?.svgWidth, props?.svgHeight]).toEqual([320, 184])
  expect(props?.cellW).toBe(8)
  expect(props?.measure).toEqual({ cols: 40, cellPx: 8 })
  // the gear's target ends 8 px from the drawing's right edge
  const gear = props?.zones?.find(z => z.id === 'gear')
  expect((gear?.x ?? 0) + (gear?.w ?? 0)).toBe(312)
  // the region as laid out over the 320 x 184 px Svg: 40 x 12 cells; Haiku's pill (x 16..88, y 40..80) -> cell (6, 4)
  await ui.resize({ columns: 40, rows: 12 })
  await ui.pointer({ type: 'down', x: 6, y: 4, button: 'left' })
  await ui.advance(16)
  await ui.pointer({ type: 'up', x: 6, y: 4, button: 'left' })
  await ui.advance(32)
  expect(x.sets).toEqual([{ key: 'model', value: 'haiku' }])
  await ui.unmount()
  // a wide band: the card follows it; narrower than the floor: held at it
  const wide = await mountDock($, 200 + GEAR)
  expect((await svgOf(wide))?.width).toBe(1600)
  await wide.unmount()
  const tight = await mountDock($, 10 + GEAR)
  expect((await svgOf(tight))?.width).toBe(280)
  await tight.unmount()
})

test('the Client measures the desktop cell once: one redraw at the band\'s real width, then nothing (no loop)', async ($, on) => {
  world(on)
  const ui = await mountDock($, 70 + GEAR)
  expect((await svgOf(ui))?.width).toBe(560) // first draw: the 8 px estimate
  // the desktop's code font is wider: the region over the 560 px Svg spans 60 cells (9.33 px each)
  await ui.resize({ columns: 60, rows: 3 })
  await ui.advance(32)
  expect((await svgOf(ui))?.width).toBe(652) // 70 x 9.33, snapped to 4 px
  const props = (await ui.find({ type: 'Client' }))?.props.props as { svgWidth?: number; cellW?: number; measure?: unknown } | undefined
  expect([props?.svgWidth, props?.cellW]).toEqual([652, 9.35])
  expect(props?.measure).toEqual({ cols: 70, cellPx: 9.35 })
  // the region now spans the band's 70 cells: it agrees, so it posts nothing and the drawing stays
  await ui.resize({ columns: 70, rows: 3 })
  const settled = JSON.stringify(await ui.drawn())
  for (let i = 0; i < 4; i++) await ui.advance(16)
  expect(JSON.stringify(await ui.drawn())).toBe(settled)
  // a measure that moves the width by less than 8 px, or an implausible one, redraws nothing
  await ui.post({ kind: 'measure', cellPx: 9.4, columns: 70 })
  await ui.post({ kind: 'measure', cellPx: 40, columns: 14 })
  expect(JSON.stringify(await ui.drawn())).toBe(settled)
  // the band itself narrows by a scrollbar's cell: the card shrinks at once (never wider than the band) …
  await ui.redraw(bandProps(69 + GEAR))
  expect((await svgOf(ui))?.width).toBe(644)
  // … and does not grow back for one cell
  await ui.redraw(bandProps(70 + GEAR))
  expect((await svgOf(ui))?.width).toBe(644)
  await ui.unmount()
})

test('a survey holds the band, and other surfaces keep the engine\'s: next(e)', async ($, on) => {
  world(on)
  on('ui.render', { component: 'AbovePrompt' }, ($e, e) => {
    const { Text } = $e.ui.resolve(e)
    return <Text>engine band</Text>
  })
  const survey = await mountDock($, 70 + GEAR, { hasSurvey: true })
  expect(await survey.find({ type: 'Svg' })).toBeUndefined()
  expect(await survey.find({ text: 'engine band' })).toBeDefined()
  await survey.unmount()
  const terminal = await $.ui.mount({ plugin: 'crab-crew', surface: 'terminal', component: 'AbovePrompt', props: bandProps(), requestId: 'band-t' })
  expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
  expect(await terminal.find({ text: 'engine band' })).toBeDefined()
  await terminal.unmount()
})

// ───────────────────────────── the reply: body only ─────────────────────────────

test('AssistantMessage with a complete footer draws the body only: no footer, no card, no buttons', async ($, on) => {
  world(on)
  const ui = await mountReply($, `${BODY}\n\n${footer('Sonnet 5.5', 'high', 'plan mode')}`)
  const md = await ui.find({ type: 'Markdown' })
  expect(md?.props.text).toBe(BODY)
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(await ui.find({ type: 'Client' })).toBeUndefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).not.toContain('Tarefa')
  expect(drawn).not.toContain('Próximo passo')
  expect(drawn).not.toContain('Sonnet')
  await ui.unmount()
  // English footer, and a reply that is only a footer: nothing but an empty box
  const en = await mountReply($, `${BODY}\n\n${footerEn('Sonnet 5.5', 'high', 'plan mode')}`, 'msg-2')
  expect((await en.find({ type: 'Markdown' }))?.props.text).toBe(BODY)
  expect(JSON.stringify(await en.drawn())).not.toContain('Next step')
  await en.unmount()
  const only = await mountReply($, footer('Sonnet 5.5', 'high', 'plan mode'), 'msg-3')
  expect(await only.find({ type: 'Markdown' })).toBeUndefined()
  expect(JSON.stringify(await only.drawn())).not.toContain('Tarefa')
  await only.unmount()
})

test('a reply without a footer is left to the engine', async ($, on) => {
  world(on)
  on('ui.render', { component: 'AssistantMessage' }, ($e, e) => {
    const { Text } = $e.ui.resolve(e)
    return <Text>engine draws</Text>
  })
  const ui = await mountReply($, 'Só texto, sem rodapé.\n\n- **Tarefa**: meio rodapé')
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  expect(await ui.find({ text: 'engine draws' })).toBeDefined()
  await ui.unmount()
})

test('while a turn runs, a footer that was not appended yet may still be streaming: left alone', async ($, on) => {
  world(on)
  on('ui.render', { component: 'AssistantMessage' }, ($e, e) => {
    const { Text } = $e.ui.resolve(e)
    return <Text>engine draws</Text>
  })
  await $.turn.start({ turnId: 't9', text: 'x' })
  const ui = await mountReply($, footer('Opus 5.5', 'high', 'auto'))
  expect(await ui.find({ text: 'engine draws' })).toBeDefined()
  await ui.unmount()
})

test("a background agent's turn that starts after the main one ended does not pin the streaming guard", async ($, on) => {
  world(on)
  await $.turn.start({ turnId: 'main', text: 'x' })
  await $.turn.complete({ answer: 'a', durationMs: 1, isAborted: false, turnId: 'main', reason: 'answer' })
  await $.turn.start({ turnId: 'bg', text: '' })
  await $.turn.complete({ answer: 'b', durationMs: 1, isAborted: false, turnId: 'bg', reason: 'answer', agentId: 'agent-1' })
  const ui = await mountReply($, `${BODY}\n\n${footer('Opus 5.5', 'high', 'plan mode')}`)
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe(BODY)
  await ui.unmount()
})

test('terminal is left to the engine', async ($, on) => {
  world(on)
  on('ui.render', { component: 'AssistantMessage' }, ($e, e) => {
    const { Text } = $e.ui.resolve(e)
    return <Text>engine draws</Text>
  })
  const ui = await $.ui.mount({
    plugin: 'crab-crew',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text: footer('Opus 5.5', 'high', 'plan mode'), isFirstOfReply: true },
  })
  expect(await ui.find({ text: 'engine draws' })).toBeDefined()
  await ui.unmount()
})

test('once the block is appended the footer is hidden and the dock gets the recommendation', async ($, on) => {
  world(on)
  mock.session(on)
  on('ui.render', { component: 'AssistantMessage' }, ($e, e) => {
    const { Text } = $e.ui.resolve(e)
    return <Text>engine draws</Text>
  })
  const text = `${BODY}\n\n${footer('Haiku 5.5', 'low', 'auto mode')}`
  const dock = await mountDock($)
  await $.turn.start({ turnId: 't1', text: 'x' })
  const reply = await mountReply($, text, 'u-1')
  expect(await reply.find({ type: 'Markdown' })).toBeUndefined() // streaming: the engine draws it
  expect(await alt(dock)).toContain('Session:')
  await append($, 'u-1', text)
  expect((await reply.find({ type: 'Markdown' }))?.props.text).toBe(BODY)
  expect(await alt(dock)).toContain('Next step: barra de uso.')
  await $.turn.complete({ answer: text, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await reply.unmount()
  await dock.unmount()
})

test('a resumed session: session.start scans the transcript, so the dock knows its newest footer; a fresh one has none', async ($, on) => {
  world(on)
  const older = footer('Opus 5.5', 'high', 'plan mode')
  const newer = footer('Haiku 5.5', 'low', 'auto mode', 'nova')
  let transcript: SessionMessage[] = [
    { role: 'user', text: 'x', toolUses: [] },
    { role: 'assistant', text: `${BODY}\n\n${older}`, toolUses: [] },
    { role: 'user', text: 'y', toolUses: [] },
    { role: 'assistant', text: newer, toolUses: [] },
  ]
  on('session.messages', () => ({ value: transcript }))
  on('command.register', () => ({ value: { command: 'crab' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const dock = await mountDock($)
  expect(await alt(dock)).toContain('Next step: nova.')
  // a running turn does not hide footers the transcript already holds
  await $.turn.start({ turnId: 't1', text: 'z' })
  const a = await mountReply($, `${BODY}\n\n${older}`, 'row-a')
  expect((await a.find({ type: 'Markdown' }))?.props.text).toBe(BODY)
  await a.unmount()
  // a new session (/clear): nothing to recommend
  transcript = []
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  expect(await alt(dock)).toContain('Session:')
  await dock.unmount()
})

// ───────────────────────────── choosing ─────────────────────────────

test('choosing applies each control at once: the model alias, the effort that reaches turn.step, the permission mode', async ($, on) => {
  const x = world(on)
  mock.session(on)
  await crab($, 'orchestrator off') // the card alone: plan mode would switch the model (crew.test.tsx)
  await append($, 'u-1', `${BODY}\n\n${footer('Sonnet 5.5', 'xhigh', 'plan mode')}`)
  const ui = await mountDock($)
  // the card shows the session (Opus) and keeps the recommendation (Sonnet) as a faint outline
  expect(await alt(ui)).toContain('Opus 5.5')
  expect(await alt(ui)).toContain('Recommended: Sonnet 5.5')
  await expand(ui)
  expect(await source(ui)).toContain('class="cc-rec"')
  await tap(ui, 'm1') // Sonnet
  expect(x.sets).toEqual([{ key: 'model', value: 'sonnet' }])
  await commit(ui, 3) // xhigh
  await step($, 'medium')
  expect(x.efforts).toEqual(['xhigh'])
  await tap(ui, 'o0') // Plan
  expect(x.modes).toEqual(['plan'])
  expect(await alt(ui)).toContain('Sonnet 5.5, xhigh effort, Plan mode. As recommended.')
  await settle(ui)
  expect(await source(ui)).not.toContain('<rect class="cc-rec"')
  await ui.unmount()
})

test('with the Orquestrador on (default), choosing Plan on the card is a plan entry: the session switches to Fable with a quiet toast', async ($, on) => {
  const x = world(on)
  const ui = await mountDock($)
  await expand(ui)
  await tap(ui, 'm1')
  await tap(ui, 'o0')
  expect(x.modes).toEqual(['plan'])
  expect(x.sets).toEqual([
    { key: 'model', value: 'sonnet' },
    { key: 'model', value: 'fable' },
  ])
  expect(x.toasts).toContain('Sonnet → Fable')
  expect(await alt(ui)).toContain('Fable 5.1')
  await ui.unmount()
})

test('choosing what the session already has calls nothing and plays nothing', async ($, on) => {
  const x = world(on, 'claude-sonnet-5-5')
  await crab($, 'orchestrator off') // the card alone: plan mode would switch the model (crew.test.tsx)
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'plan' })
  const ui = await mountDock($)
  await expand(ui)
  await tap(ui, 'm1')
  await tap(ui, 'o0')
  expect(x.sets).toEqual([])
  expect(x.modes).toEqual([])
  expect(x.played).toEqual([])
  await ui.unmount()
})

test('a mode change in flight (the tool waits for approval): the pill waits on it, a second mode press calls nothing', async ($, on) => {
  const x = world(on, { hold: true })
  await crab($, 'orchestrator off') // the card alone: plan mode would switch the model (crew.test.tsx)
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'plan' })
  const ui = await mountDock($)
  await expand(ui)
  expect(await alt(ui)).toContain('Plan mode')
  const first = tap(ui, 'o1') // Auto
  await x.modeCalled
  // the pill moved at once (pending), before the session changed
  expect(await alt(ui)).toContain('Auto mode')
  await tap(ui, 'o2')
  await tap(ui, 'o3')
  expect(x.modes).toEqual(['auto'])
  x.release()
  await first
  expect(x.modes).toEqual(['auto'])
  expect(x.sets).toEqual([])
  expect(await alt(ui)).toContain('Auto mode')
  // free again: the next mode press goes through
  await tap(ui, 'o0')
  expect(x.modes).toEqual(['auto', 'plan'])
  await ui.unmount()
})

test('a refused change (model denied, mode tool error): one quiet toast each, the pill eases back to the session, no click', async ($, on) => {
  const x = world(on, { denyModel: 'model locked by policy', modeError: 'not allowed here' })
  await crab($, 'orchestrator off') // the card alone: plan mode would switch the model (crew.test.tsx)
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'plan' })
  const ui = await mountDock($)
  await expand(ui)
  await tap(ui, 'm0') // Haiku
  expect(x.toasts).toHaveLength(1)
  expect(x.toasts[0]).toContain('model locked by policy')
  // back on the session's model, easing from where the pill was
  expect(await alt(ui)).toContain('Opus 5.5')
  expect(await source(ui)).toContain('<rect x="282" y="48" width="128"') // the pill on Opus's column
  await tap(ui, 'o3') // Edits
  expect(x.modes).toEqual(['acceptEdits'])
  expect(x.toasts).toHaveLength(2)
  expect(x.toasts[1]).toContain('not allowed here')
  expect(await alt(ui)).toContain('Plan mode')
  expect(x.played).toEqual([])
  // no acknowledgement for a refusal
  expect(await source(ui)).not.toContain('values="0;1;0"')
  await ui.unmount()
})

test('when the session already matches the recommendation: no outline, no chip, the label says so', async ($, on) => {
  const x = world(on, 'claude-opus-5-5')
  mock.session(on)
  await step($, 'high') // the session's own effort, seen on a main-thread request
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'auto' })
  await append($, 'u-1', `${BODY}\n\n${footer('Opus 5.5', 'high', 'auto mode')}`)
  const ui = await mountDock($)
  expect(await source(ui)).not.toContain('cc-rec-chip')
  expect(await alt(ui)).toContain('As recommended')
  await expand(ui)
  await settle(ui)
  expect(await source(ui)).not.toContain('<rect class="cc-rec"')
  expect(await alt(ui)).toContain('As recommended')
  await ui.unmount()
})

test('each change that took effect plays the click once; at rest nothing animates; /crab sound reports the play', async ($, on) => {
  const x = world(on)
  await crab($, 'orchestrator off') // the card alone: plan mode would switch the model (crew.test.tsx)
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'plan' })
  const ui = await mountDock($)
  await expand(ui)
  await settle(ui)
  await tap(ui, 'm3') // Fable
  expect(x.sets).toEqual([{ key: 'model', value: 'fable' }])
  expect(JSON.stringify(x.played)).toContain('assets/click.wav')
  expect(x.played).toHaveLength(1)
  // the pill slides; no second motion once the session took it (no acknowledgement pulse)
  expect(await source(ui)).toContain('<animate attributeName="x"')
  expect(await source(ui)).not.toContain('values="0;1;0"')
  await tap(ui, 'o3')
  expect(x.modes).toEqual(['acceptEdits'])
  expect(x.played).toHaveLength(2)
  // past the motion's end, the next redraw: nothing animates
  await settle(ui)
  expect((await source(ui)).match(/<animate/g)?.length ?? 0).toBe(0)
  expect(JSON.stringify(await crab($, 'sound'))).toContain('last click played')
  await ui.unmount()
})

test('/crab sound reports a rejected play', async ($, on) => {
  world(on, { playFails: true })
  const ui = await mountDock($)
  await expand(ui)
  await tap(ui, 'm3')
  await ui.advance(16)
  expect(JSON.stringify(await crab($, 'sound'))).toContain('last click failed')
  await ui.unmount()
})

test('/crab sound off: a change plays nothing, and the choice is stored', async ($, on) => {
  const x = world(on)
  expect(JSON.stringify(await crab($, 'sound off'))).toContain('sound off')
  expect(x.store.sound).toBe(false)
  const ui = await mountDock($)
  await expand(ui)
  await tap(ui, 'm3')
  expect(x.sets).toEqual([{ key: 'model', value: 'fable' }])
  expect(x.played).toEqual([])
  await ui.unmount()
})

test('reduced motion (/crab motion reduced): instant, nothing animates at rest or on a change, a change is silent', async ($, on) => {
  const x = world(on)
  expect(JSON.stringify(await crab($, 'motion reduced'))).toContain('motion reduced')
  expect(x.store.motion).toBe('reduced')
  const ui = await mountDock($)
  expect((await source(ui)).match(/<animate/g)).toBeNull()
  await expand(ui)
  expect((await svgOf(ui))?.height).toBe(184)
  await tap(ui, 'm0')
  const src = await source(ui)
  expect(src).not.toContain('<animate')
  expect(src).not.toContain('@keyframes')
  expect(await alt(ui)).toContain('Haiku 5.5')
  expect(x.sets).toEqual([{ key: 'model', value: 'haiku' }])
  expect(x.played).toEqual([])
  await tap(ui, 'chev')
  expect((await source(ui)).match(/<animate/g)).toBeNull()
  expect((await svgOf(ui))?.height).toBe(48)
  await ui.unmount()
})

test("reduced motion also follows the config row 'reduceMotion'", async ($, on) => {
  world(on, { reduceMotion: true })
  const ui = await mountDock($)
  await expand(ui)
  expect((await source(ui)).match(/<animate/g)).toBeNull()
  await ui.unmount()
})

test('light theme from the config row; /crab theme overrides it', async ($, on) => {
  world(on, { theme: 'light' })
  const ui = await mountDock($)
  expect(await source(ui)).toContain('stroke="#6B6B70"')
  expect(await source(ui)).not.toContain('stroke="#939398"')
  expect(JSON.stringify(await crab($, 'theme dark'))).toContain('theme dark')
  expect(await source(ui)).toContain('stroke="#939398"')
  expect(await source(ui)).not.toContain('stroke="#6B6B70"')
  await crab($, 'theme auto')
  expect(await source(ui)).toContain('stroke="#6B6B70"')
  await ui.unmount()
})

test('turn.step leaves a subagent outside the crew untouched (the card effort is the main loop one)', async ($, on) => {
  const x = world(on)
  const ui = await mountDock($)
  await commit(ui, 4)
  await step($, 'low', 'agent-1')
  await step($, 'low')
  expect(x.efforts).toEqual(['low', 'max'])
  await ui.unmount()
})

test("the chosen effort yields when the app's own effort changes, and to /crab effort reset", async ($, on) => {
  const x = world(on)
  const ui = await mountDock($)
  await commit(ui, 3)
  await step($, 'medium')
  await step($, 'medium')
  await step($, 'low') // the person changed effort in the app
  await step($, 'low')
  expect(x.efforts).toEqual(['xhigh', 'xhigh', 'low', 'low'])
  // the card follows the session: the knob is on low now
  expect(await alt(ui)).toContain('low effort')
  await commit(ui, 3)
  await step($, 'low')
  expect(x.efforts.at(-1)).toBe('xhigh')
  expect(JSON.stringify(await crab($, 'effort reset'))).toContain('cleared')
  await step($, 'low')
  expect(x.efforts.at(-1)).toBe('low')
  await ui.unmount()
})

test('effort-drag moves the knob with the pointer (instant, nothing eases under it), effort-commit applies it and eases onto the tick in whole pixels', async ($, on) => {
  const x = world(on)
  const ui = await mountDock($)
  await expand(ui)
  await settle(ui)
  const post = (data: { [k: string]: JsonValue }) => ui.post(data)
  await post({ kind: 'effort-drag', x: 280, phase: 'down', velocity: 0 })
  await post({ kind: 'effort-drag', x: 294, phase: 'move', velocity: 100 })
  expect(await alt(ui)).toContain('high effort')
  await post({ kind: 'effort-drag', x: 390, phase: 'move', velocity: 400 })
  await x.clock.advance(50)
  await post({ kind: 'effort-drag', x: 396, phase: 'move', velocity: 100 })
  await x.clock.advance(130)
  await post({ kind: 'effort-drag', x: 400, phase: 'move', velocity: 20 })
  expect(await alt(ui)).toContain('xhigh effort')
  // under the pointer the knob and the icon follow at once: no animation to restart on every move
  expect(await source(ui)).not.toContain('<animate')
  expect(await source(ui)).toContain('<g transform="translate(400 100)">')
  // nothing applied while dragging
  await step($, 'medium')
  expect(x.efforts).toEqual(['medium'])

  await post({ kind: 'effort-commit', level: 3, x: 400, velocity: 600, via: 'drag' })
  const src = await source(ui)
  // the knob eases onto the tick in whole-pixel discrete steps, no overshoot bounce
  expect(/type="translate" values="(\d+) 100;[^"]*" keyTimes="[^"]*" calcMode="discrete"/.exec(src)).not.toBeNull()
  expect(await alt(ui)).toContain('xhigh effort')
  // the release applied it
  await step($, 'medium')
  expect(x.efforts.at(-1)).toBe('xhigh')
  expect(x.played).toHaveLength(1)
  await ui.unmount()
})


/** Tags an icon draws at a level that the star does not (no ids, so they match any card's prefix). */
function iconTags(kind: EffortIconKind, level: number): string[] {
  const base = (k: EffortIconKind): IconView => ({ kind: k, level, model: 'opus', change: null, reaction: null, now: 0, reduced: false, theme: 'dark', idPrefix: 'x' })
  const star = new Set(iconMarkup(base('star')).split('<'))
  return iconMarkup(base(kind)).split('<').filter(t => !star.has(t) && t.includes(' d="') && !t.includes('#x') && !t.includes('id='))
}


test('/crab icon pet: stored, the card redraws with the pet, cross-fading from what was on screen', async ($, on) => {
  const x = world(on)
  await crab($, 'icon star') // the pet is the default: start from a stored star
  const ui = await mountDock($)
  await commit(ui, 2) // touched: the card is known
  await x.clock.advance(2_000)
  const tags = iconTags('pet', 2)
  expect(tags.length).toBeGreaterThan(0)
  const before = await source(ui)
  for (const t of tags) expect(before).not.toContain(t)
  expect(JSON.stringify(await crab($, 'icon pet'))).toContain('icon pet')
  expect(x.store.icon).toBe('pet')
  const after = await source(ui)
  for (const t of tags) expect(after).toContain(t)
  expect(after).not.toBe(before)
  // the star fades out under the pet fading in (from what was on screen)
  expect(after).toContain('<animate attributeName="opacity"')
  expect(JSON.stringify(await crab($, 'status'))).toContain('icon pet')
  // another icon, and an unknown one is refused (usage)
  await crab($, 'icon moon')
  expect(x.store.icon).toBe('moon')
  const help = JSON.stringify(await crab($, 'icon sparkly'))
  expect(help).toContain('/crab icon star|pet|moon|dumbbell|wave')
  expect(x.store.icon).toBe('moon')
  // a removed kind is refused too
  for (const gone of ['flame', 'rings', 'dots']) expect(JSON.stringify(await crab($, `icon ${gone}`))).toContain('/crab icon star|pet|moon|dumbbell|wave')
  expect(x.store.icon).toBe('moon')
  await ui.unmount()
})

test('a stored icon that was removed (flame, rings, dots) falls back to the default (the pet) at session.start; a stored choice is kept', async ($, on) => {
  const x = world(on)
  on('session.messages', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'crab' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  for (const gone of ['flame', 'rings', 'dots']) {
    x.store.icon = gone
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
    expect(x.store.icon).toBe('pet')
    expect(JSON.stringify(await crab($, 'status'))).toContain('icon pet')
  }
  // a choice the person stored stays theirs
  x.store.icon = 'star'
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  expect(x.store.icon).toBe('star')
  expect(JSON.stringify(await crab($, 'status'))).toContain('icon star')
})

test('modes read Plan / Auto / Ask / Edits in the card; the tool still gets the internal value', async ($, on) => {
  const x = world(on)
  mock.session(on)
  await append($, 'u-1', footer('Opus 5.5', 'high', 'Edits'))
  const ui = await mountDock($)
  await expand(ui)
  const src = await source(ui)
  for (const name of ['Plan', 'Auto', 'Ask', 'Edits']) expect(src).toContain(`>${name}</text>`)
  for (const old of ['>plan<', '>auto<', '>default<', '>acceptEdits<', 'plan mode', 'auto mode']) expect(src).not.toContain(old)
  expect(await alt(ui)).toContain('Recommended: Opus 5.5, high effort, Edits mode.')
  await tap(ui, 'o2')
  expect(x.modes).toEqual(['default'])
  expect(await alt(ui)).toContain('Ask mode')
  // the mode of the bar is only its icon
  await tap(ui, 'chev')
  await settle(ui)
  expect(await source(ui)).toContain(`<path d="${MODE_ICON.default[0]}"`)
  expect(await source(ui)).toContain('<title>Ask</title>')
  await ui.unmount()
})

// ───────────────────────────── the fallback: Botões, or a faulted Client ─────────────────────────────

test('Botões (/crab drag off): a compact native row inside the band instead of the Client; Direto brings the Client back and the row away', async ($, on) => {
  const x = world(on)
  const ui = await mountDock($)
  await noNative(ui)
  expect(await ui.find({ type: 'Client' })).toBeDefined()
  expect(JSON.stringify(await crab($, 'drag off'))).toContain('botões')
  expect(x.store.mapping).toBe('B')
  expect(await ui.find({ type: 'Client' })).toBeUndefined()
  // the row: [Ocultar] [Expandir] [⚙] under the bar, aligned to the card's content column
  expect((await ui.find({ key: 'cc-hide' }))?.props.label).toBe('Ocultar')
  expect((await ui.find({ key: 'cc-toggle' }))?.props.label).toBe('Expandir')
  expect((await ui.find({ key: 'cc-settings' }))?.props.label).toBe('⚙')
  expect(await ui.find({ key: 'cc-adjust' })).toBeUndefined() // no Adjust tray, ever
  expect(await ui.find({ key: 'cc-sel-model' })).toBeUndefined() // the bar has no controls to pick with
  expect((await ui.find({ key: 'cc-row' }))?.props.paddingLeft).toBe(2) // x 16 / 8
  // it works: expand, pick a model with the Select, open the pane
  await ui.press({ key: 'cc-toggle' })
  await settle(ui)
  expect((await svgOf(ui))?.height).toBe(184)
  expect((await ui.find({ key: 'cc-toggle' }))?.props.label).toBe('Recolher')
  expect(x.store.dock).toBe('expanded')
  expect((await ui.find({ key: 'cc-sel-model' }))?.props.value).toBe('opus')
  await ui.select({ key: 'cc-sel-model', value: 'haiku' })
  expect(x.sets).toEqual([{ key: 'model', value: 'haiku' }])
  expect((await ui.find({ key: 'cc-sel-model' }))?.props.value).toBe('haiku')
  await ui.select({ key: 'cc-sel-effort', value: 'max' })
  await step($, 'low')
  expect(x.efforts.at(-1)).toBe('max')
  await ui.select({ key: 'cc-sel-mode', value: 'default' })
  expect(x.modes).toEqual(['default'])
  await ui.press({ key: 'cc-settings' })
  expect(x.opens).toEqual(['crab-settings'])
  // hidden: only a native button to bring it back
  await ui.press({ key: 'cc-hide' })
  expect(x.store.dock).toBe('hidden')
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect((await ui.find({ key: 'cc-show' }))?.props.label).toBe('Mostrar crab')
  await ui.press({ key: 'cc-show' })
  expect(x.store.dock).toBe('bar')
  expect((await svgOf(ui))?.height).toBe(48)
  // Direto again
  expect(JSON.stringify(await crab($, 'drag on'))).toContain('diretos')
  expect(x.store.mapping).toBe('A')
  expect(await ui.find({ type: 'Client' })).toBeDefined()
  await noNative(ui)
  await ui.unmount()
})

// ───────────────────────────── stability: what the host's frequent redraws see ─────────────────────────────

/**
 * Everything the band draws, as the host receives it, less the engine's press handle of the native gear (the runtime
 * stamps a new one on every pass of the hook, whatever the closure: bookkeeping, nothing drawn).
 */
const tree = async (ui: Dock): Promise<string> => JSON.stringify(await ui.drawn()).replace(/"handle":\d+/g, '"handle":0')

test('a redraw with no state change returns a byte-identical tree, mid-animation too; once the motion ended nothing animates', async ($, on) => {
  const x = world(on)
  const ui = await mountDock($)
  await expand(ui)
  await x.clock.advance(2_000)
  await ui.redraw()
  const rest = await tree(ui)
  // idle: the host redraws on every streamed token
  for (let i = 0; i < 5; i++) {
    await x.clock.advance(30)
    await ui.redraw()
    expect(await tree(ui)).toBe(rest)
  }
  // a change animates once, keyed to that change: the redraws during it do not restart it
  await tap(ui, 'm1')
  const a0 = await tree(ui)
  expect(a0).toContain('<animate')
  for (let i = 0; i < 5; i++) {
    await x.clock.advance(30)
    await ui.redraw()
    expect([i, await tree(ui)]).toEqual([i, a0])
  }
  // past its end: no animation element, and identical again
  await x.clock.advance(1_000)
  await ui.redraw()
  const after = await tree(ui)
  expect(after).not.toContain('<animate')
  await x.clock.advance(30)
  await ui.redraw()
  expect(await tree(ui)).toBe(after)
  await ui.unmount()
})

test('hovering the card changes nothing on screen (no redraw per zone crossed)', async ($, on) => {
  world(on)
  const ui = await mountDock($)
  const before = await tree(ui)
  await zone(ui, 'gear', 'hover')
  await zone(ui, 'body', 'hover')
  expect(await tree(ui)).toBe(before)
  await ui.unmount()
})

test("the model pill never bounces back while the session's /model still names the old model", async ($, on) => {
  const x = world(on, { lagModel: true })
  await crab($, 'orchestrator off')
  const ui = await mountDock($)
  await expand(ui)
  await tap(ui, 'm1') // Sonnet; /model keeps answering Opus until the next request
  expect(x.sets).toEqual([{ key: 'model', value: 'sonnet' }])
  expect(await alt(ui)).toContain('Sonnet 5.5')
  await x.clock.advance(2_000)
  await ui.redraw()
  expect(await alt(ui)).toContain('Sonnet 5.5')
  await ui.unmount()
})

test('the band keeps its height while the column jitters by a cell (a scrollbar coming and going)', async ($, on) => {
  world(on)
  const ui = await mountDock($, 61 + GEAR)
  const h = (await svgOf(ui))?.height
  for (const cols of [60, 62, 61, 60]) {
    await ui.redraw(bandProps(cols + GEAR))
    expect([cols, (await svgOf(ui))?.height]).toEqual([cols, h])
  }
  await ui.unmount()
})

test('the Client region is the drawn Svg, whatever the surface cell metric (a 19.6 px line, not 16)', async ($, on) => {
  const x = world(on)
  await crab($, 'orchestrator off')
  const ui = await mountDock($)
  await expand(ui)
  // the desktop lays the region out in its code font: 70 columns by 10 rows over the 184 px card
  await ui.resize({ columns: 70, rows: 10 })
  // the Edits pill (x 412..544, y 130..170): column 58 (468 px), row 7 (138 px at 18.4 px a row)
  await ui.pointer({ type: 'down', x: 58, y: 7, button: 'left' })
  await ui.advance(16)
  await ui.pointer({ type: 'up', x: 58, y: 7, button: 'left' })
  await ui.advance(32)
  expect(x.modes).toEqual(['acceptEdits'])
  await ui.unmount()
})

test('hidden: the bar hides everything down to a small handle; the handle brings the bar back; remembered', async ($, on) => {
  const x = world(on)
  const ui = await mountDock($)
  const props = (await ui.find({ type: 'Client' }))?.props.props as { zones?: { id: string }[] } | undefined
  expect(props?.zones?.map(z => z.id)).toContain('hide')
  await tap(ui, 'hide')
  expect(x.store.dock).toBe('hidden')
  const svg = await svgOf(ui)
  expect(svg?.height).toBeLessThanOrEqual(24)
  expect(String(svg?.alt)).toContain('hidden')
  const hz = (await ui.find({ type: 'Client' }))?.props.props as { zones?: { id: string }[] } | undefined
  expect(hz?.zones?.map(z => z.id)).toEqual(['show'])
  await ui.unmount()
  // a new drawing starts hidden
  const again = await mountDock($)
  expect((await svgOf(again))?.height).toBeLessThanOrEqual(24)
  await tap(again, 'show')
  expect(x.store.dock).toBe('bar')
  expect((await svgOf(again))?.height).toBe(48)
  await again.unmount()
})

test('drawing a reply never feeds back into itself: no transcript read, no state write from a render', async ($, on) => {
  const x = world(on)
  let calls = 0
  on('session.messages', () => {
    calls++
    return { value: [] }
  })
  const ui = await mountReply($, `${BODY}

${footer('Sonnet 5.5', 'high', 'plan mode')}`)
  for (let i = 0; i < 10; i++) await x.clock.advance(16)
  expect(calls).toBe(0)
  await ui.unmount()
})
