/**
 * The "Crab Crew" settings pane: `/crab` and the docked card's gear open it; each
 * section stores its value, redraws the pane with the choice and (where it
 * shows) the card.
 */
import type { ConfigRow, On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'
import { iconMarkup, type EffortIconKind, type IconView } from '../hooks/card/effort-icon'

const footer = (model: string, effort: string, mode: string): string =>
  ['**Próximo passo**', '- **Tarefa**: barra de uso', `- **Modelo**: ${model}`, `- **Effort**: ${effort}`, `- **Modo**: ${mode}`].join('\n')

const row = (key: string, kind: ConfigRow['kind'], value: ConfigRow['value']): ConfigRow => ({
  key,
  label: key,
  kind,
  value,
  provider: { plugin: 'engine', tier: 'core' },
  isLocked: false,
})

type World = { store: Record<string, unknown>; opens: { id: string; title?: string }[]; efforts: unknown[]; clock: ReturnType<typeof mock.clock> }

function world(on: On): World {
  const w: World = { store: {}, opens: [], efforts: [], clock: mock.clock(on, { now: 1_000 }) }
  on('store.get', (_$, e) => ({ value: w.store[e.key] }))
  on('store.set', (_$, e) => {
    w.store[e.key] = e.value
    return { value: undefined }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('config.list', () => ({ value: [row('theme', 'choice', 'dark'), row('reduceMotion', 'boolean', false)] }))
  on('config.set', (_$, e) => ({ value: e.value }))
  on('tool.call', () => ({ result: { ok: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('audio.play', () => ({ value: undefined }))
  on('ui.open', (_$, e) => {
    w.opens.push({ id: e.id, ...(e.title !== undefined ? { title: e.title } : {}) })
    return { value: { isPlaced: true } }
  })
  on('turn.step', async function* (_$, e) {
    w.efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return w
}

const crab = ($: Engine, args: string) =>
  $.command.run({ command: 'crab', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

const mountCard = ($: Engine) =>
  $.ui.mount({
    plugin: 'crab-crew',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 24, bodyColumns: 70, scroll: { offset: 0, bodyRows: 24 }, view: {} },
    requestId: 'prompt-band',
  })

const PANE_PROPS = { title: 'Crab Crew', isFocused: false, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 24 }, view: {} } as const
const mountPane = ($: Engine) => $.ui.mount({ plugin: 'crab-crew', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'crab-settings' })
const mountMobilePane = ($: Engine) => $.ui.mount({ plugin: 'crab-crew', surface: 'mobile', component: 'Pane', props: PANE_PROPS, requestId: 'crab-settings' })

type Mounted = Awaited<ReturnType<typeof mountCard>>
type Pane = Awaited<ReturnType<typeof mountPane>>
const source = async (ui: Mounted): Promise<string> => String((await ui.find({ type: 'Svg' }))?.props.source)
const valueOf = async (ui: Pane, key: string): Promise<unknown> => (await ui.find({ key }))?.props.value

async function step($: Engine, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max') {
  const s = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort, messageCount: 1 })
  for await (const _chunk of s) {
    // drain
  }
}

/** Tags an icon draws that the star does not (no ids, so they match any card's prefix). */
function iconTags(kind: EffortIconKind, level: number): string[] {
  const base = (k: EffortIconKind): IconView => ({ kind: k, level, model: 'opus', change: null, reaction: null, now: 0, reduced: false, theme: 'dark', idPrefix: 'x' })
  const star = new Set(iconMarkup(base('star')).split('<'))
  return iconMarkup(base(kind)).split('<').filter(t => !star.has(t) && t.includes(' d="') && !t.includes('#x') && !t.includes('id='))
}

test('/crab with no arguments opens the "Crab Crew" pane; unknown arguments still print the usage', async ($, on) => {
  const w = world(on)
  expect(JSON.stringify(await crab($, ''))).toContain('ajustes abertos')
  expect(w.opens).toEqual([{ id: 'crab-settings', title: 'Crab Crew' }])
  const help = JSON.stringify(await crab($, 'nonsense'))
  expect(help).toContain('Usage:')
  expect(w.opens).toHaveLength(1)
})

test('the gear on the docked card (a zone drawn in the Svg) opens the pane, and so does the one native gear beside it (the safety net)', async ($, on) => {
  const w = world(on)
  const ui = await mountCard($)
  expect(await ui.find({ key: 'cc-settings' })).toBeUndefined() // the Botões row is not drawn
  expect(await source(ui)).toContain('class="cc-gear"')
  await ui.post({ kind: 'zone', id: 'gear', phase: 'down' })
  expect(w.opens).toEqual([{ id: 'crab-settings', title: 'Crab Crew' }])
  // the native gear outside the Svg: clickable whatever the Client region receives
  expect((await ui.find({ key: 'cc-gear' }))?.props).toMatchObject({ label: '⚙', plain: true })
  await ui.press({ key: 'cc-gear' })
  expect(w.opens).toHaveLength(2)
  await ui.unmount()
})

test('the pane draws one Select per section with the current values and the reset button', async ($, on) => {
  world(on)
  const pane = await mountPane($)
  for (const t of ['Ícone de effort', 'Sons', 'Movimento', 'Tema', 'Cliques no card', 'Orquestrador', 'Diagnóstico']) expect(await pane.find({ text: t })).toBeDefined()
  expect(await valueOf(pane, 'cs-icon')).toBe('pet') // the default since 0.7.0
  expect(await valueOf(pane, 'cs-diag')).toBe('on')
  // the pet per level is fixed: no pose section
  expect(await pane.find({ text: 'Pet por nível' })).toBeUndefined()
  expect(await pane.find({ key: 'cs-pet-medium' })).toBeUndefined()
  expect(await valueOf(pane, 'cs-sound')).toBe('on')
  expect(await valueOf(pane, 'cs-chime')).toBe('on')
  expect(await valueOf(pane, 'cs-tap')).toBe('on')
  expect(await valueOf(pane, 'cs-orchestrator')).toBe('on')
  // "Sons": one section, three labelled switches
  expect((await pane.find({ key: 'cs-sound' }))?.props.label).toBe('Clique')
  expect((await pane.find({ key: 'cs-chime' }))?.props.label).toBe('Concluído (≥ 2 min)')
  expect((await pane.find({ key: 'cs-tap' }))?.props.label).toBe('Aprovação')
  expect(await valueOf(pane, 'cs-motion')).toBe('full')
  expect(await valueOf(pane, 'cs-theme')).toBe('auto')
  expect(await valueOf(pane, 'cs-clicks')).toBe('direct')
  expect(JSON.stringify((await pane.find({ key: 'cs-clicks' }))?.props.options)).toContain('Botões')
  expect(JSON.stringify((await pane.find({ key: 'cs-clicks' }))?.props.options)).toContain('Direto')
  const labels = JSON.stringify((await pane.find({ key: 'cs-icon' }))?.props.options)
  for (const l of ['Estrela', 'Pet', 'Lua', 'Haltere', 'Onda']) expect(labels).toContain(l)
  expect((await pane.find({ key: 'cs-effort-reset' }))?.props.label).toBe('Repor effort da app')
  await pane.unmount()
})

test('icon: stored, the pane shows it, the card draws the new icon', async ($, on) => {
  const w = world(on)
  const card = await mountCard($)
  const pane = await mountPane($)
  const tags = iconTags('moon', 2)
  expect(tags.length).toBeGreaterThan(0)
  for (const t of tags) expect(await source(card)).not.toContain(t)
  await pane.select({ key: 'cs-icon', value: 'moon' })
  expect(w.store.icon).toBe('moon')
  expect(await valueOf(pane, 'cs-icon')).toBe('moon')
  for (const t of tags) expect(await source(card)).toContain(t)
  // the subcommand and the pane share the setter: the pane follows `/crab icon`
  await crab($, 'icon moon')
  expect(await valueOf(pane, 'cs-icon')).toBe('moon')
  await pane.unmount()
  await card.unmount()
})

test('theme: stored, the pane shows it, the card switches palette', async ($, on) => {
  const w = world(on)
  const card = await mountCard($)
  const pane = await mountPane($)
  expect(await source(card)).toContain('fill="#E6E6E6"')
  await pane.select({ key: 'cs-theme', value: 'light' })
  expect(w.store.theme).toBe('light')
  expect(await valueOf(pane, 'cs-theme')).toBe('light')
  expect(await source(card)).toContain('fill="#1D1D1F"')
  expect(await source(card)).not.toContain('fill="#E6E6E6"')
  await pane.select({ key: 'cs-theme', value: 'dark' })
  expect(await source(card)).toContain('fill="#E6E6E6"')
  await pane.select({ key: 'cs-theme', value: 'auto' })
  expect(w.store.theme).toBe('auto')
  await pane.unmount()
  await card.unmount()
})

test('the pet per level is fixed: no pose setting, and an old stored petPose is ignored (status included)', async ($, on) => {
  const w = world(on)
  on('session.messages', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'crab' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  for (const old of [{ medium: 'coffee' }, { low: 'melt', medium: 'attentive' }, 'laptop', null]) {
    w.store.petPose = old
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
    const pane = await mountPane($)
    expect(await pane.find({ text: 'Pet por nível' })).toBeUndefined()
    const status = JSON.stringify(await crab($, 'status'))
    expect(status).toContain('icon star')
    expect(status).not.toContain('pet medium')
    // left as it was: never read, never rewritten
    expect(w.store.petPose).toEqual(old)
    await pane.unmount()
  }
})

test('sound, motion and clicks: stored, shown, and the card follows (motion stills it; Botões swaps the Client for the compact row)', async ($, on) => {
  const w = world(on)
  const card = await mountCard($)
  const pane = await mountPane($)
  await pane.select({ key: 'cs-sound', value: 'off' })
  expect(w.store.sound).toBe(false)
  expect(await valueOf(pane, 'cs-sound')).toBe('off')
  await pane.select({ key: 'cs-motion', value: 'reduced' })
  expect(w.store.motion).toBe('reduced')
  expect(await valueOf(pane, 'cs-motion')).toBe('reduced')
  await w.clock.advance(2_000)
  expect((await source(card)).match(/<animate/g)).toBeNull()
  // Direto is the default: the Client over the card, nothing native
  expect(await card.find({ type: 'Client' })).toBeDefined()
  expect(await card.find({ key: 'cc-toggle' })).toBeUndefined()
  await pane.select({ key: 'cs-clicks', value: 'buttons' })
  expect(w.store.mapping).toBe('B')
  expect(await valueOf(pane, 'cs-clicks')).toBe('buttons')
  expect(await card.find({ type: 'Client' })).toBeUndefined()
  expect(await card.find({ key: 'cc-toggle' })).toBeDefined()
  expect(await card.find({ key: 'cc-settings' })).toBeDefined()
  await pane.select({ key: 'cs-clicks', value: 'direct' })
  expect(w.store.mapping).toBe('A')
  expect(await valueOf(pane, 'cs-clicks')).toBe('direct')
  expect(await card.find({ type: 'Client' })).toBeDefined()
  expect(await card.find({ key: 'cc-toggle' })).toBeUndefined()
  // /crab drag shares the setter, and the pane follows
  await crab($, 'drag off')
  expect(await valueOf(pane, 'cs-clicks')).toBe('buttons')
  expect(JSON.stringify(await crab($, 'status'))).toContain('clicks buttons')
  await pane.unmount()
  await card.unmount()
})

test('"Repor effort da app" clears the chosen effort, as /crab effort reset does', async ($, on) => {
  const w = world(on)
  const card = await mountCard($)
  await card.post({ kind: 'effort-commit', level: 3, x: 398.5, velocity: 0, via: 'tap' }) // choosing applies it
  await step($, 'medium')
  expect(w.efforts.at(-1)).toBe('xhigh')
  const pane = await mountPane($)
  await pane.press({ key: 'cs-effort-reset' })
  await step($, 'medium')
  expect(w.efforts.at(-1)).toBe('medium')
  await pane.unmount()
  await card.unmount()
})

test('a surface without Select (mobile) gets rows of plain Buttons, the chosen one marked', async ($, on) => {
  const w = world(on)
  const pane = await mountMobilePane($)
  expect((await pane.find({ key: 'cs-icon-pet' }))?.props.variant).toBe('secondary')
  expect((await pane.find({ key: 'cs-icon-moon' }))?.props.plain).toBe(true)
  await pane.press({ key: 'cs-icon-moon' })
  expect(w.store.icon).toBe('moon')
  expect((await pane.find({ key: 'cs-icon-moon' }))?.props.variant).toBe('secondary')
  expect((await pane.find({ key: 'cs-icon-pet' }))?.props.plain).toBe(true)
  expect(await pane.find({ key: 'cs-pet-medium-coffee' })).toBeUndefined()
  expect((await pane.find({ key: 'cs-sound-on' }))?.props.variant).toBe('secondary')
  await pane.unmount()
})

test('chime, tap and Orquestrador: stored, shown, reported by /crab status and loaded at session.start', async ($, on) => {
  const w = world(on)
  on('session.messages', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'crab' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const pane = await mountPane($)
  await pane.select({ key: 'cs-chime', value: 'off' })
  await pane.select({ key: 'cs-tap', value: 'off' })
  await pane.select({ key: 'cs-orchestrator', value: 'off' })
  expect(w.store).toMatchObject({ chime: false, tap: false, orchestrator: false })
  expect(await valueOf(pane, 'cs-chime')).toBe('off')
  expect(await valueOf(pane, 'cs-tap')).toBe('off')
  expect(await valueOf(pane, 'cs-orchestrator')).toBe('off')
  expect(JSON.stringify(await crab($, 'status'))).toContain('chime off, tap off, orchestrator off')
  // /crab shares the setters, and the pane follows
  await crab($, 'orchestrator on')
  expect(w.store.orchestrator).toBe(true)
  expect(await valueOf(pane, 'cs-orchestrator')).toBe('on')
  await pane.unmount()
  // a new session loads the stored values
  w.store.chime = true
  w.store.tap = false
  w.store.orchestrator = false
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  expect(JSON.stringify(await crab($, 'status'))).toContain('chime on, tap off, orchestrator off')
})

test('"Diagnóstico": on by default, stored, reported by /crab status, and /crab diag shares the setter', async ($, on) => {
  const w = world(on)
  const pane = await mountPane($)
  expect(await valueOf(pane, 'cs-diag')).toBe('on')
  await pane.select({ key: 'cs-diag', value: 'off' })
  expect(w.store.diag).toBe(false)
  expect(await valueOf(pane, 'cs-diag')).toBe('off')
  expect(JSON.stringify(await crab($, 'status'))).toContain('diag off')
  expect(JSON.stringify(await crab($, 'diag on'))).toContain('diagnóstico ligado')
  expect(w.store.diag).toBe(true)
  expect(await valueOf(pane, 'cs-diag')).toBe('on')
  await pane.unmount()
})
