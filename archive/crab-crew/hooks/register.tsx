/**
 * crab-crew: the docked control card (desktop) and the comfort bar (terminal), in one mod.
 *
 * Every function that touches `$` lives in this file; ./card/*, ./crew/* and ./comfort/* are pure.
 *
 * Surfaces
 * - Desktop: the docked card owns the band above the prompt (model, effort, mode), the Agent rows are pet
 *   rows, the reply's footer is hidden. Comfort's header rows never draw there.
 * - Terminal: the comfort bar (./comfort/bar.tsx, a Client) owns the band: identity, model / effort /
 *   ultracode picker, usage message, the band crabs, and ≡ for the settings pane. The Agent rows are the
 *   one-line crab rows of the clean chat.
 * - Everywhere: the window identity (emoji + name, the tab title), the clean chat (tool rows hidden, one task
 *   line and one edits line per turn, a ✗ only for a turn that ended broken), the spinner's plain words,
 *   the usage gauges on the footer row, the progress tool, the crew's sounds and the orchestrator.
 * - One hook per event and component dispatches by surface and feature (AbovePrompt, ToolUse, ui.message,
 *   ui.fault, session.start, turn.start / turn.complete, agent.spawn), so nothing depends on hook order.
 *
 * - ui.render on AbovePrompt (desktop, no survey): ONE card docked right above the
 *   prompt box, as wide as the band (bodyColumns x the measured cell, in CSS px). It is a live
 *   control of the session (model, effort, mode) and keeps the latest reply's
 *   "Próximo passo" recommendation as a faint dashed outline / effort-tick ring (svg.ts).
 *   Three looks, remembered in $.store ('dock'): the slim bar (default)
 *   [effort icon] Model ver · [mode icon] … [hide][chevron][gear]; the full card
 *   (models / effort rail / modes); hidden, a small handle that brings the bar back.
 * - ui.render on AssistantMessage (desktop): a block that ends with a complete
 *   footer is drawn as Markdown(body) only (the footer is hidden, nothing else);
 *   the footer reaches the docked card through session.append (and the transcript
 *   scan at session.start). Anything else, and a footer that may still be streaming,
 *   is left to next(e). A render never writes state.
 * - Clicks ("Cliques no card"): Direto (default, mapping A) = a transparent Client
 *   region (card/slider.tsx) over the docked Svg; it maps its cells onto the svg.ts
 *   zones (model pills, mode pills, the effort rails (the expanded one and the bar's
 *   compact one: drag 1:1 + tap), crew, hide, chevron, gear, the bar, the handle).
 *   Botões (`/crab drag off`), or after a ui.fault for our Client: a compact native
 *   row inside the band (hide, toggle, gear and, expanded, three Selects). Never both.
 * - The layer stack (0.7.0, the fix for "nothing is clickable"): the Svg sits in a
 *   `position: "absolute"` Box drawn FIRST, the Client sits IN FLOW after it, in a
 *   `position: "relative"` Box, sized explicitly in cells (ceil of the drawing over
 *   the cell). BoxProps.position says a pointer on an absolute Box "is on its
 *   parent": the 0.6 Client, inside an absolute Box over the Svg, never got one.
 *   One native Button (⚙, `cc-gear`) always sits at the band's right edge, outside
 *   the Svg: the settings pane (and its "Botões" fallback) is reachable by click even
 *   when the Client gets nothing.
 * - Diagnostics ("Diagnóstico", default on): a rolling log of the last DIAG_MAX lines
 *   at ~/.claude/crab-crew/diag.log (ISO time + one line per event: the Client's
 *   layout, every pointer down and the zone it resolved to, every ui.message,
 *   ui.fault, config.set and permission-mode results, each turn.step's model and
 *   effort before and after the override, AbovePrompt renders counted once a second).
 *   Writing never throws into a hook and no hook waits on it.
 * - Redraws: the host redraws the band on every streamed token and the desktop
 *   reloads an interactive Svg whenever its source changes. So handlers only write
 *   state; the render hook derives the motion (motionFor): when the view differs
 *   from the one on screen it retargets from it, once, and the drawing is keyed
 *   to that instant (svg.ts renderCard), so a redraw with no change returns the
 *   same tree. No timers, no hover or press feedback (each would be a reload).
 * - Apply on select (no Apply button): choosing a model applies it via
 *   config.set, an effort (a tick, the release of a drag) via the effort atom
 *   (read by the turn.step hook below), a mode via the session's permission-mode
 *   tool (a more permissive mode still shows the app's approval card). The model
 *   is shown only once config.set returned ok (the config.set hook records it): a
 *   refusal leaves the pill where it was, with a quiet toast. A mode in flight
 *   (`applying`) shows its value while the app's approval card waits. One change in
 *   flight per kind: a second model or mode press while one waits is ignored.
 *   The app's own "Opus 5.5 · Alto" pill below the textbox is not ours to change:
 *   set_session_model / set_session_effort refuse the own session.
 *
 * Decisions
 * - Recommendation: session.append (door 'response', main loop) records the newest
 *   assistant block whose text has a footer (`rec`); session.start scans the
 *   transcript so a resumed session knows its newest footer (a new session clears
 *   it). An AssistantMessage that renders a footer while `rec` is still empty feeds it.
 *   Before any footer the card shows the session alone (no outline, no task).
 * - Streaming: while any turn runs (turn.start .. turn.complete, by turnId), a
 *   footer is hidden only once its block was appended (its fp is in `done`),
 *   because a cut ending "- **Modo**: auto" already parses.
 * - Width: the card is laid out at the band's real width (svg.ts layout(W)), never scaled:
 *   left content anchors left, the hide / chevron / gear controls anchor right, the wells and
 *   the rail span the column, and each look has one fixed height whatever the width.
 *   W = bodyColumns x the desktop's cell width in px. The engine gives cells, not px, so the
 *   cell starts at CELL_W (8 px) and the Client region (laid exactly over the Svg) measures it:
 *   when its own column count disagrees with W / cell by more than 2 cells it posts
 *   { kind: 'measure', cellPx } once for those props; the hooks keep it (`cellPx`) only when it
 *   moves W by 8 px or more. W snaps to 4 px; it shrinks at once (never wider than the band)
 *   and grows only by COL_GROW_PX or more (a scrollbar coming and going redraws nothing).
 * - Theme: `/crab theme light|dark` forces it; 'auto' (default) reads the config
 *   row 'theme' (contains 'light' => light, else dark). The API exposes no
 *   desktop colour-scheme signal, so a light Code tab under a dark CLI theme
 *   needs `/crab theme light`.
 * - Reduced motion: the config row 'reduceMotion' === true OR `/crab motion
 *   reduced` (stored). Reduced: cross-fades only, no click.
 * - Effort icon: `/crab icon star|pet|moon|dumbbell|wave`
 *   (stored, default pet since 0.7.0; a stored choice is kept) is the knob of the
 *   expanded rail and of the bar's compact rail; a change cross-fades it. The pet
 *   plays its level's sequence once on a level change and once on hover (the
 *   Client's `hover` post, the petHover atom), then rests still.
 * - Effort: the chosen override is cleared when the app's own effort (seen on a
 *   main-thread request) changes to a value the mod did not set, at
 *   session.start, and by `/crab effort reset`.
 * - Settings pane "Crab Crew" (./settings.ts): `/crab` with no arguments, or the
 *   gear on the card, opens it. Each section is a native Select (a row of plain
 *   Buttons, the chosen one `secondary`, where the surface has no Select). The
 *   pane and the `/crab` subcommands share the setters below (setIcon, setClicks,
 *   …): state + store; the card and the pane read the same atoms, so both redraw
 *   with the choice. The pet per level is fixed, so
 *   there is no pose setting (an old stored `petPose` is ignored).
 * - Modes are shown by their visible names (MODE_NAME: Plan, Auto, Ask, Edits);
 *   the values (plan, auto, default, acceptEdits) are what the permission-mode
 *   tool takes.
 *
 * Crew (./crew/*, pure; the calls are here)
 * - tool.call Agent records the subagent in `crew` (id = tool_use_id, role by
 *   roleOf(resolved type, description), status working); its result ends it
 *   (done / error / interrupted), or, launched in the background, the agent's
 *   own turn.complete does. The first subagent of the session opens the Crew
 *   pane by itself; `/crab crew` reopens it. While one works, `crewTick` moves
 *   every CREW_TICK_MS so the pane's durations move; nothing ticks at rest.
 * - agent.spawn ties the entry to its agentId and resolved model and, with the
 *   Orquestrador on, picks the model by role for a built-in agent type when the
 *   call named none (forks, workflow agents, teammates and agents a plugin or
 *   the person defined, whose frontmatter may pin a model, are left alone).
 *   turn.step holds a crew subagent at the effort of the model it runs on
 *   (haiku low, sonnet medium, opus high) unless its call named an effort.
 * - ui.render ToolUse (desktop, Agent only): one compact row, the costume pet
 *   + role + description + model + status. Every other row is next(e).
 * - An unknown role asks haiku once per subagent type for a small accessory
 *   grid (costumes.ts validates it); the answer or 'plain' is kept in $.store
 *   under costume:<type> and never asked again; one request per type at a time.
 * - Orquestrador (default on): entering plan mode (UserPromptSubmit's
 *   permission_mode, EnterPlanMode, a mode chosen on the card) switches the
 *   session to Fable (Opus, with one toast, when the model row offers no Fable);
 *   an approved ExitPlanMode switches to Opus. Through config.set, as the card
 *   does, so the pill and the card follow; a quiet toast says "Fable → Opus".
 * - Sounds: the click (exists), a chime when a turn or a subagent of 2 min or
 *   more finishes, a tap when the app waits on the person (PermissionRequest,
 *   a permission / idle / elicitation Notification), one tap per 1.5 s.
 *
 * Live desktop checklist (cannot be proven in the test kit)
 * - [ ] AbovePrompt draws on desktop: the slim bar sits right above the textbox, sized to the column.
 * - [ ] Svg isInteractive frame shows SMIL (pill slide, icon morph) on desktop.
 * - [ ] Pointer reaches the in-flow Client region over the whole card (diag.log: "pointer down zone=…"
 *       with the right zone): chevron / bar expand, the gear opens the pane, pills apply, the rails
 *       (expanded and the bar's compact one) tap and drag 1:1, crew opens the Crew pane, hide leaves the
 *       handle, the handle brings the bar back. If not, the native ⚙ beside the card opens the pane, and
 *       its "Cliques no card: Botões" shows the compact native row.
 * - [ ] diag.log: "Client layout columns=… rows=…" equals the region asked for ("card layout … region=…");
 *       if the rows differ the surface ignored the size and rows map over the drawing (the 0.6 measure).
 * - [ ] After a model click, the next "turn.step main model=…" line names the chosen model.
 * - [ ] The pet knob plays once on an effort change and on hover over a rail, then rests still.

 * - [ ] While a reply streams the card does not flicker: the Svg source only changes on a real change.
 * - [ ] Choosing Auto from plan: the approval card appears, the pill waits on
 *       Auto; refusing it eases the pill back to Plan with a quiet toast.
 * - [ ] Click sound: run `/crab sound` after a change; it reports whether the
 *       last play resolved ("played") or rejected (Windows may play nothing).
 * - [ ] Theme: card matches the Code tab; otherwise `/crab theme light|dark`.
 * - [ ] A reply's footer is hidden; the dashed outline / chip on the card shows the recommendation.
 * - [ ] `/crab icon pet`: the knob shows the pet; the card cross-fades it.
 * - [ ] `/crab` and the card's gear open the "Crab Crew" pane; each Select changes the card live.
 * - [ ] The first subagent opens the Crew pane; its Agent row is the compact pet row; a working pet breathes.
 * - [ ] shift+tab into plan: the pill moves to Fable with a quiet toast; approving the plan moves it to Opus.
 * - [ ] Chime after a 2 min turn, tap on an approval prompt (Windows may play nothing).
 * Tooling note: a `{ tool: 'Agent' }` matcher on tool.call is too deep for tsc in this
 * module (TS2589), so one unmatched tool.call hook dispatches on String(e.tool).
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, JsonValue, Register } from 'claude-code'

import type { Applying, BarEffort, CrewEntry, DockLook, Identity, Item, StoredCostume, ThemePref } from '../types'
import type { BarProps, Usage } from './comfort/bar'
import { activity, describe, errorDetail, groupLine, shorten } from './comfort/compact'
import { type Crab, type Member, SEED_CRABS, addCrab, designPrompt, hashCrab, matchCrab, parseDesign } from './comfort/crabs'
import { LEFT_RESERVE, footerGauges } from './comfort/footer'
import {
  LEVELS,
  MODELS,
  PROGRESS_TOOL,
  type ProgressInput,
  activeModel,
  barMessage,
  editPath,
  editsLine,
  flatLine,
  fromProgress,
  isLevel,
  listFromInput,
  offeredModels,
  saneCrab,
  shortPath,
  taskWords,
  toUsage,
  withProgressRule,
  withTeachRule,
} from './comfort/helpers'
import { type Action, cellWidth, fitCells } from './comfort/look'
import { type Fold, type Piece, addTask, counts, fromTodos, isFinished, lineHead, lineState, toggleFold, treeRows, updateTask } from './comfort/progress'
import {
  type Entry,
  claim,
  cleanName,
  collides,
  folderName,
  parse as parseRegistry,
  pickEmoji,
  remove as removeWindow,
  serialize,
  splitTitle,
  upsert,
} from './comfort/registry'
import { ROLES, ROUTING, addEntry, durationOf, exactRole, formatDuration, patchEntry, roleOf, routeModel, setStatus, subagentEffort, type CrewStatus } from './crew/roles'
import { PLAIN, costumeGridJson, costumeGridPrompt, costumeStoreKey, crewPetSvg, parseCostumeReply, validateCostumeGrid, CREW_PET_BOX } from './crew/costumes'
import { SOUND_ASSETS, isApprovalNotification, shouldChime, shouldTap, type SoundKind } from './crew/sounds'
import {
  CREW_MAX,
  CREW_PANE,
  CREW_TICK_MS,
  CREW_TITLE,
  FABLE_MISSING_TOAST,
  STATUS_COLOR,
  STATUS_LABEL,
  agentCallStatus,
  agentResultModel,
  entersPlan,
  modelLabel,
  oneLine,
  outputModel,
  petPrefix,
  planTarget,
  roleLabel,
  rowStatus,
  switchToast,
  toolOk,
  turnEndStatus,
  type PlanEdge,
} from './crew/orchestrator'
import { DEFAULT_ICON, EFFORT_ICONS, type EffortIconKind } from './card/effort-icon'
import {
  CLICK_OPTIONS,
  ICON_OPTIONS,
  MOTION_OPTIONS,
  ON_OFF_OPTIONS,
  SETTINGS_PANE,
  SETTINGS_TITLE,
  THEME_OPTIONS,
  pick,
  type Option,
} from './settings'
import {
  EFFORTS,
  FAMILIES,
  FAMILY_NAME,
  FAMILY_VERSION,
  MODES,
  MODE_NAME,
  effortIndex,
  familyOf,
  parseNextStep,
  type Family,
  type Mode,
  type NextStep,
} from './card/parse'
import {
  LOOK_H,
  MAX_WIDTH,
  MIN_WIDTH,
  effortFromX,
  effortOnRail,
  emptyAnim,
  hitMap,
  layout,
  petPlaying,
  renderCard,
  retarget,
  startPetHover,
  type AnimState,
  type CardView,
  type Mapping,
  type RailGeometry,
  type Theme,
} from './card/svg'

// ───────────────────────────── state ─────────────────────────────

const effortAtom = atom({ plugin: 'crab-crew', key: 'effort' } as const, null)
const sessionEffortAtom = atom({ plugin: 'crab-crew', key: 'sessionEffort' } as const, null)
const sessionModeAtom = atom({ plugin: 'crab-crew', key: 'sessionMode' } as const, null)
const sessionModelAtom = atom({ plugin: 'crab-crew', key: 'sessionModel' } as const, null)
const modelSetAtom = atom({ plugin: 'crab-crew', key: 'modelSet' } as const, null)
const lookAtom = atom({ plugin: 'crab-crew', key: 'look' } as const, null)
const dragAtom = atom({ plugin: 'crab-crew', key: 'drag' } as const, null)
const recAtom = atom({ plugin: 'crab-crew', key: 'rec' } as const, null)
const clientFaultAtom = atom({ plugin: 'crab-crew', key: 'clientFault' } as const, null)
const cellPxAtom = atom({ plugin: 'crab-crew', key: 'cellPx' } as const, null)
const doneAtom = atom({ plugin: 'crab-crew', key: 'done' } as const, [])
const turnsAtom = atom({ plugin: 'crab-crew', key: 'turns' } as const, [])
const applyingAtom = atom({ plugin: 'crab-crew', key: 'applying' } as const, { model: null, mode: null })
const mappingAtom = atom({ plugin: 'crab-crew', key: 'mapping' } as const, 'A')
const soundAtom = atom({ plugin: 'crab-crew', key: 'sound' } as const, true)
const soundLastAtom = atom({ plugin: 'crab-crew', key: 'soundLast' } as const, null)
const reducedMotionAtom = atom({ plugin: 'crab-crew', key: 'reducedMotion' } as const, false)
const themePrefAtom = atom({ plugin: 'crab-crew', key: 'themePref' } as const, 'auto')
const effortIconAtom = atom({ plugin: 'crab-crew', key: 'effortIcon' } as const, DEFAULT_ICON)
const crewAtom = atom({ plugin: 'crab-crew', key: 'crew' } as const, [])
const crewOpenedAtom = atom({ plugin: 'crab-crew', key: 'crewOpened' } as const, false)
const crewTickAtom = atom({ plugin: 'crab-crew', key: 'crewTick' } as const, 0)
const costumesAtom = atom({ plugin: 'crab-crew', key: 'costumes' } as const, {})
const orchestratorAtom = atom({ plugin: 'crab-crew', key: 'orchestrator' } as const, true)
const planActiveAtom = atom({ plugin: 'crab-crew', key: 'planActive' } as const, null)
const fableNotedAtom = atom({ plugin: 'crab-crew', key: 'fableNoted' } as const, false)
const chimeAtom = atom({ plugin: 'crab-crew', key: 'chime' } as const, true)
const tapAtom = atom({ plugin: 'crab-crew', key: 'tap' } as const, true)
const diagAtom = atom({ plugin: 'crab-crew', key: 'diag' } as const, true)
const petHoverAtom = atom({ plugin: 'crab-crew', key: 'petHover' } as const, null)

const MODE_TOOL = 'mcp__ccd_session_mgmt__set_session_permission_mode'
const CLICK = SOUND_ASSETS.click
const MODEL_NAMES = FAMILIES.map(f => FAMILY_NAME[f])
/** desktop cell metric the band is laid out in until the Client region measures it (spec §9: 8 x 16 px) */
const CELL_W = 8
const CELL_H = 16
/** a measured cell is believed between these (px); outside, the post is ignored */
const CELL_MIN = 4
const CELL_MAX = 16
/** the card's width snaps to this many px */
const W_SNAP = 4
/** a measured cell that moves the width by less than this (px) is ignored: no redraw */
const MEASURE_MIN_PX = 8
/** the width grows only by this many px or more (it shrinks at once): a scrollbar's cell or two redraws nothing */
const COL_GROW_PX = 24
/** How long a model set through config.set is shown while `/model` still names another (the host catching up). */
const MODEL_CONFIRM_MS = 5_000
/** A change in flight older than this is taken as abandoned (a reload mid-await never ran its finally). */
const APPLY_STALE_MS = 10 * 60_000
/** Columns the card leaves at the band's right edge for the native gear (the click safety net). */
const GEAR_COLS = 3
/** Svg ids of the one docked card. */
const DOCK_PREFIX = 'kdock_'
/** $.store key of the look (expanded, bar, hidden); an older version stored 'expanded' (boolean). */
const DOCK_KEY = 'dock'
const LEGACY_EXPANDED_KEY = 'expanded'

// ───────────────────────────── pure helpers ─────────────────────────────

const fpOf = (s: NextStep): string => `${s.task}|${s.model}|${s.effort}|${s.mode}`

/** What the card is built from before any reply recommended something: the session's model, a neutral effort and mode. */
function stepFor(rec: NextStep | null, model: Family | null): NextStep {
  if (rec) return rec
  const m = model ?? 'opus'
  return { task: '', model: m, modelLabel: `${FAMILY_NAME[m]} ${FAMILY_VERSION[m]}`, effort: 'high', mode: 'default' }
}

type Ctx = {
  /** what the session has now (null: not seen yet) */
  session: { model: Family | null; effort: number | null; mode: Mode | null }
  theme: Theme
  reduced: boolean
  mapping: Mapping
  sound: boolean
  /** the latest reply's recommendation (null: none yet) */
  rec: NextStep | null
  /** `rec`, or the session-only step the card is built from */
  step: NextStep
  icon: EffortIconKind
}

type ApplyingState = { model: Applying | null; mode: Applying | null }

/**
 * One source of truth per control: a change in flight shows its value (until
 * the session took or refused it, or it went stale), else the session's value,
 * else (not seen yet) a neutral one. The knob under the pointer wins for the effort.
 */
function viewOf(ctx: Ctx, look: DockLook, drag: number | null, applying: ApplyingState, now: number): CardView {
  const s = ctx.session
  const fresh = (a: Applying | null): string | null => (a !== null && now - a.at < APPLY_STALE_MS ? a.value : null)
  // not seen yet: a neutral value, never the recommendation's (the card would claim the session follows it)
  const neutral = stepFor(null, s.model)
  return {
    step: ctx.step,
    hasRec: ctx.rec !== null,
    draft: {
      // truthful: the model the session runs (or the one config.set just took), never a pending choice
      model: neutral.model,
      effort: drag ?? s.effort ?? EFFORTS.indexOf(neutral.effort),
      mode: toMode(fresh(applying.mode)) ?? s.mode ?? neutral.mode,
    },
    collapsed: look !== 'expanded',
    hidden: look === 'hidden',
    dragging: drag !== null,
    mapping: ctx.mapping,
    icon: ctx.icon,
  }
}

/**
 * What the band shows, as last drawn (this module's copy; one band). The motion
 * is derived here, not stored: when the view to draw differs from the one on
 * screen, it retargets from it at `now`, whoever changed the state. The same
 * view keeps the same motion record, so a redraw returns the same drawing.
 */
let onScreen: { key: string; view: CardView; anim: AnimState; hover: number | null } | null = null

/**
 * `hover`: when the pointer last came over the effort rail (petHover). A hover newer than the one on screen
 * starts the pet's play from that instant (startPetHover), once; the same hover keeps the same drawing.
 */
function motionFor(view: CardView, now: number, reduced: boolean, hover: number | null = null): AnimState {
  const key = JSON.stringify(view)
  if (onScreen?.key === key) {
    if (hover !== null && hover !== onScreen.hover) onScreen = { ...onScreen, hover, anim: startPetHover(onScreen.anim, view, hover, reduced) }
    return onScreen.anim
  }
  const anim = onScreen ? retarget(onScreen.anim, onScreen.view, view, now, reduced) : emptyAnim()
  onScreen = { key, view, anim, hover }
  return anim
}

/** The effort rail as last drawn (the expanded one or the bar's): an effort-drag x is read on it. */
let drawnRail: RailGeometry | null = null

/** The native gear's closure: one stable function, so the band's tree stays the same on a redraw; the ui.press hook acts. */
const gearPress = (): void => undefined

/** The band as last drawn (this module's copy): its columns, the cell width used, the card's width (px). */
let dock: { cols: number; cell: number; w: number } | null = null

/** The band's px width for `cols` cells of `cell` px: snapped down to W_SNAP, within the layout's bounds. */
function bandWidth(cols: number, cell: number): number {
  const c = Number.isFinite(cols) && cols > 0 ? cols : 70
  return clamp(Math.floor((c * cell) / W_SNAP) * W_SNAP, MIN_WIDTH, MAX_WIDTH)
}

/**
 * The width the card is drawn at for the band's `cols` cells: it shrinks at once (never wider than the band),
 * grows only by COL_GROW_PX or more, and follows a new cell measure at once.
 */
function dockWidth(cols: number, cell: number): number {
  const target = bandWidth(cols, cell)
  const prev = dock
  const w = prev && prev.cell === cell && target > prev.w && target - prev.w < COL_GROW_PX ? prev.w : target
  dock = { cols, cell, w }
  return w
}

const toMode = (m: unknown): Mode | null => (typeof m === 'string' && (MODES as readonly string[]).includes(m) ? (m as Mode) : null)

/** Markdown takes tab and newline as its only control characters. */
const cleanBody = (s: string): string => s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')

const isIcon = (v: unknown): v is EffortIconKind => typeof v === 'string' && (EFFORT_ICONS as readonly string[]).includes(v)
const isLook = (v: unknown): v is DockLook => v === 'expanded' || v === 'bar' || v === 'hidden'

const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x))

// ───────────────────────────── diagnostics ─────────────────────────────

/** Lines the diag log keeps (the oldest go first). */
const DIAG_MAX = 200
/** The log's place when the environment names no home folder. */
const DIAG_FALLBACK = '.claude/crab-crew/diag.log'

/** This module copy's lines (null until the file was read once: a reload keeps the log rolling). */
let diagBuf: string[] | null = null
/** One write at a time, in order. */
let diagChain: Promise<void> = Promise.resolve()
/** Throttled kinds: when the last line of each went out, and how many were skipped since. */
const diagLast = new Map<string, { at: number; skipped: number }>()

async function diagPath($: EngineInterface): Promise<string> {
  let home: string | undefined
  try {
    home = await homeDir($)
  } catch {
    home = undefined
  }
  return home ? `${home}/.claude/crab-crew/diag.log` : DIAG_FALLBACK
}

/** One line of text: control characters out, capped. */
const diagText = (s: string): string => {
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, ' ')
  return t.length > 400 ? `${t.slice(0, 399)}…` : t
}

/**
 * Adds one line to the diag log (when "Diagnóstico" is on): `<ISO time> <text>`, the file rewritten whole
 * with the last DIAG_MAX lines. `kind` throttles: at most one line of that kind per `ms` (default 1 s), the
 * skipped ones counted on the next. Never rejects; callers do not wait on it (`void diag(...)`), so a slow
 * or refused write never holds a hook.
 */
function diag($: EngineInterface, text: string, throttle?: { kind: string; ms?: number }): Promise<void> {
  const run = async (): Promise<void> => {
    if (!(await read($, diagAtom))) return
    const now = await $.clock.now()
    let line = text
    if (throttle) {
      const prev = diagLast.get(throttle.kind)
      if (prev && now - prev.at < (throttle.ms ?? 1000)) {
        prev.skipped += 1
        return
      }
      if (prev && prev.skipped > 0) line += ` (+${prev.skipped} skipped)`
      diagLast.set(throttle.kind, { at: now, skipped: 0 })
    }
    const path = await diagPath($)
    if (diagBuf === null) {
      try {
        const old = await $.fs.read(path)
        diagBuf = typeof old === 'string' ? old.split('\n').filter(l => l !== '').slice(-(DIAG_MAX - 1)) : []
      } catch {
        diagBuf = []
      }
    }
    diagBuf.push(`${new Date(now).toISOString()} ${diagText(line)}`)
    if (diagBuf.length > DIAG_MAX) diagBuf = diagBuf.slice(-DIAG_MAX)
    await $.fs.write(path, `${diagBuf.join('\n')}\n`)
  }
  const p = diagChain.then(run).catch(() => undefined)
  diagChain = p
  return p
}

/** AbovePrompt renders since the last counted line, and the card's last logged layout. */
let renderCount = { n: 0, since: -1 }
let lastLayoutLine = ''

/** "Diagnóstico" on or off; stored for the next session. Off stops writing at once (the file stays). */
async function setDiag($: EngineInterface, on: boolean): Promise<void> {
  if (on) await update($, diagAtom, () => true)
  void diag($, `diag ${on ? 'on' : 'off'}`)
  if (!on) await update($, diagAtom, () => false)
  await $.store.set('diag', on).catch(() => undefined)
}

/** What a Client post says, for the log. */
function describeMsg(d: Msg): { text: string; kind?: string } {
  const k = String(d.kind)
  const at = Array.isArray(d.at) ? ` at=[${d.at.join(',')}]` : ''
  if (k === 'zone') return { text: `pointer ${String(d.phase)} zone=${String(d.id)}${at}${d.phase === 'up' ? ` inside=${String(d.inside)}` : ''}` }
  if (k === 'miss') return { text: `pointer down zone=none${at} px=[${Array.isArray(d.px) ? d.px.join(',') : ''}]` }
  if (k === 'effort-drag') {
    const x = typeof d.x === 'number' ? Math.round(d.x) : '?'
    return d.phase === 'down' ? { text: `pointer down zone=effort-rail x=${x}px` } : { text: `effort drag x=${x}px`, kind: 'drag' }
  }
  if (k === 'effort-commit') return { text: `effort commit level=${String(d.level)} via=${String(d.via)}` }
  if (k === 'hover') return { text: `hover ${String(d.id)}`, kind: 'hover' }
  if (k === 'layout') return { text: `Client layout columns=${String(d.columns)} rows=${String(d.rows)}` }
  if (k === 'measure') return { text: `Client measure cellPx=${String(d.cellPx)} columns=${String(d.columns)}` }
  return { text: `ui.message ${k}` }
}

// ───────────────────────────── engine reads ─────────────────────────────

async function context($: EngineInterface): Promise<Ctx> {
  const [override, seenEffort, mode, , modelSet, mapping, sound, rec, reducedPref, themePref, icon] = await Promise.all([
    read($, effortAtom),
    read($, sessionEffortAtom),
    read($, sessionModeAtom),
    read($, sessionModelAtom), // subscribes the drawing to the model each request runs on
    read($, modelSetAtom),
    read($, mappingAtom),
    read($, soundAtom),
    read($, recAtom),
    read($, reducedMotionAtom),
    read($, themePrefAtom),
    read($, effortIconAtom),
  ])
  // `/model` is the truth; for a moment after a config.set that took effect (or a request) the value set wins,
  // so a host that reports the new model a little late never bounces the pill back and forth
  let live: Family | null = null
  try {
    live = familyOf(await $.session.model())
  } catch {
    live = null
  }
  const now = await $.clock.now()
  const set = modelSet !== null && now - modelSet.at < MODEL_CONFIRM_MS ? familyOf(modelSet.value) : null
  const model: Family | null = set ?? live
  let rows: { key: string; value: unknown }[] = []
  try {
    rows = await $.config.list()
  } catch {
    rows = []
  }
  const themeRow = rows.find(r => r.key === 'theme')?.value
  const theme: Theme =
    themePref === 'light' || themePref === 'dark'
      ? themePref
      : typeof themeRow === 'string' && themeRow.toLowerCase().includes('light')
        ? 'light'
        : 'dark'
  const reduced = rows.find(r => r.key === 'reduceMotion')?.value === true || reducedPref
  const ei = effortIndex(override ?? seenEffort)
  return {
    session: { model, effort: ei >= 0 ? ei : null, mode },
    theme,
    reduced,
    mapping,
    sound,
    rec,
    step: stepFor(rec, model),
    icon: isIcon(icon) ? icon : DEFAULT_ICON,
  }
}

/** The look the person left: 'dock' in the store; an older 'expanded' true is the full card; else the bar. */
async function storedLook($: EngineInterface): Promise<DockLook> {
  try {
    const look = await $.store.get(DOCK_KEY)
    if (isLook(look)) return look
    return (await $.store.get(LEGACY_EXPANDED_KEY)) === true ? 'expanded' : 'bar'
  } catch {
    return 'bar'
  }
}

// ───────────────────────────── card changes ─────────────────────────────

/** Sets the look (expanded, bar, hidden); remembered in the store for the next session. */
async function setLook($: EngineInterface, look: DockLook): Promise<void> {
  await update($, lookAtom, () => look)
  await $.store.set(DOCK_KEY, look).catch(() => undefined)
}

/** The chevron or the bar: expanded <-> bar. */
async function toggleDock($: EngineInterface): Promise<void> {
  const cur = (await read($, lookAtom)) ?? (await storedLook($))
  await setLook($, cur === 'expanded' ? 'bar' : 'expanded')
}

type Choice = { what: 'model'; value: Family } | { what: 'effort'; value: number } | { what: 'mode'; value: Mode }

/** Makes the change in the session. Returns null when it took effect, else why not (for the toast). */
async function applyChoice($: EngineInterface, ch: Choice): Promise<string | null> {
  try {
    if (ch.what === 'model') {
      const r = await $.config.set({ key: 'model', value: ch.value })
      // took effect: the config.set hook below records it (whoever sets the model) and logs the result
      return r.deny !== undefined ? r.deny : null
    }
    if (ch.what === 'effort') {
      const effort = EFFORTS[ch.value] ?? null
      if (!effort) return 'unknown effort'
      await update($, effortAtom, () => effort)
      return null
    }
    const r = await $.tool.call({ tool: MODE_TOOL, session_id: 'self', mode: ch.value })
    const outcome = typeof r.deny === 'string' ? `deny (${r.deny})` : r.isError ? `error (${r.text ?? 'the tool failed'})` : 'ok'
    void diag($, `set_session_permission_mode self mode=${ch.value} -> ${outcome}`)
    if (typeof r.deny === 'string') return r.deny
    if (r.isError) return r.text ?? 'the tool failed'
    await update($, sessionModeAtom, () => ch.value)
    // a mode chosen on the card is a plan-mode transition like any other (the orchestrator's)
    await notePlan($, ch.value === 'plan').catch(() => undefined)
    return null
  } catch (err) {
    return String(err)
  }
}

/** The click of a change that took effect, its outcome kept for `/crab sound`. */
async function clickSound($: EngineInterface, ctx: Ctx): Promise<void> {
  if (!ctx.sound || ctx.reduced) return
  const now = await $.clock.now()
  void $.audio
    .play({ asset: CLICK })
    .then(
      () => update($, soundLastAtom, () => ({ ok: true, at: now, error: null })),
      err => update($, soundLastAtom, () => ({ ok: false, at: now, error: String(err) })),
    )
    .catch(() => undefined)
}

/**
 * Apply on select. A choice that already matches the session does nothing.
 * Effort: the override atom (read by turn.step), the drag let go. Model and
 * mode: `applying` holds the choice (the card shows it at once) until the
 * session took it (the session atom is written first, so the card never shows
 * the old value in between) or refused it (a quiet toast; the card shows the
 * session's value again). One model and one mode change in flight at a time:
 * a press while one waits does nothing.
 */
async function choose($: EngineInterface, ch: Choice): Promise<void> {
  const ctx = await context($)
  if (ch.what === 'effort') {
    const changed = ch.value !== ctx.session.effort
    const failed = changed ? await applyChoice($, ch) : null
    await update($, dragAtom, () => null)
    if (changed && failed === null) await clickSound($, ctx)
    return
  }
  const what = ch.what
  if (ch.value === ctx.session[what]) return
  const t0 = await $.clock.now()
  let won = false
  await update($, applyingAtom, cur => {
    const busy = cur[what]
    if (busy && t0 - busy.at < APPLY_STALE_MS) return cur
    won = true
    return { ...cur, [what]: { at: t0, value: ch.value } }
  })
  if (!won) return
  let failed: string | null = 'not applied'
  try {
    failed = await applyChoice($, ch)
  } finally {
    await update($, applyingAtom, cur => (cur[what]?.at === t0 ? { ...cur, [what]: null } : cur))
  }
  void diag($, `card ${what} -> ${ch.value}: ${failed === null ? 'applied' : `not applied (${failed})`}`)
  if (failed !== null) $.ui.toast(`Crab: ${what} not applied (${failed})`, { timeoutMs: 6000 })
  else await clickSound($, ctx)
}

// ───────────────────────────── Client messages (mapping A) ─────────────────────────────

type Msg = {
  kind?: unknown
  x?: unknown
  phase?: unknown
  level?: unknown
  id?: unknown
  cellPx?: unknown
  at?: unknown[]
  px?: unknown[]
  inside?: unknown
  via?: unknown
  columns?: unknown
  rows?: unknown
  items?: unknown[]
}

/**
 * The Client region measured the desktop's cell (px): kept (a redraw at the new width) only when plausible and
 * when it moves the card's width by MEASURE_MIN_PX or more, so a measure never loops on rounding.
 */
async function onMeasure($: EngineInterface, cellPx: number): Promise<void> {
  if (!(cellPx >= CELL_MIN && cellPx <= CELL_MAX) || dock === null) return
  const cell = Math.round(cellPx * 20) / 20
  if (Math.abs(bandWidth(dock.cols, cell) - dock.w) < MEASURE_MIN_PX) return
  await update($, cellPxAtom, () => cell)
}

/** The Client region's posts: the knob under the pointer, its release, a zone pressed. Hover and release of a zone change nothing. */
async function onSliderMessage($: EngineInterface, d: Msg): Promise<void> {
  // several posts queued in one frame arrive as one batch, in order
  if (d.kind === 'batch' && Array.isArray(d.items)) {
    for (const item of d.items.slice(0, 32)) if (item && typeof item === 'object') await onSliderMessage($, item as Msg)
    return
  }
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const said = describeMsg(d)
  void diag($, said.text, said.kind ? { kind: said.kind } : undefined)
  if (d.kind === 'measure') return onMeasure($, num(d.cellPx))
  if (d.kind === 'layout' || d.kind === 'miss') return
  if (d.kind === 'hover') return onHover($)
  if (d.kind === 'effort-drag') {
    // on the rail as drawn (the expanded one or the bar's); whole hundredths: a sub-pixel wobble is not a new drawing
    const x = num(d.x)
    const effort = Math.round((drawnRail ? effortOnRail(x, drawnRail) : effortFromX(x, dock?.w)) * 100) / 100
    await update($, dragAtom, () => effort)
    return
  }
  if (d.kind === 'effort-commit') return choose($, { what: 'effort', value: Math.max(0, Math.min(4, Math.round(num(d.level)))) })
  if (d.kind !== 'zone' || d.phase !== 'down' || typeof d.id !== 'string') return
  const z = d.id
  if (z === 'chev' || z === 'body') return toggleDock($)
  if (z === 'hide') return setLook($, 'hidden')
  if (z === 'show') return setLook($, 'bar')
  if (z === 'gear') {
    await openSettings($)
    return
  }
  if (z === 'crew') {
    await openCrew($)
    return
  }
  const i = Number(z.slice(1))
  const model = z[0] === 'm' ? FAMILIES[i] : undefined
  if (model) return choose($, { what: 'model', value: model })
  const mode = z[0] === 'o' ? MODES[i] : undefined
  if (mode) return choose($, { what: 'mode', value: mode })
}

/**
 * The pointer came over the effort rail: the pet plays once (the render starts it from this instant). Nothing
 * while a play runs, or when the knob is not the pet, so a resting pointer never redraws the card.
 */
async function onHover($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (!onScreen || onScreen.view.icon !== 'pet' || onScreen.view.hidden || petPlaying(onScreen.anim, now)) return
  if (await read($, reducedMotionAtom)) return
  await update($, petHoverAtom, () => now)
}

/**
 * The transcript's footers: they are all done (a running turn does not hide them), and the newest is the
 * recommendation (a new session has none). A failed read leaves the card showing the session alone.
 */
async function scanTranscript($: EngineInterface): Promise<void> {
  try {
    const msgs = await $.session.messages()
    const steps: NextStep[] = []
    for (const m of msgs) {
      if (m.role !== 'assistant') continue
      const p = parseNextStep(m.text)
      if (p) steps.push(p.step)
    }
    const fps = steps.map(fpOf)
    if (fps.length > 0) await update($, doneAtom, list => [...list.filter(x => !fps.includes(x)), ...new Set(fps)].slice(-64))
    await update($, recAtom, () => steps[steps.length - 1] ?? null)
  } catch {
    // no transcript
  }
}

/** A reply's footer arrived whole: it is done and it is the recommendation now. */
async function noteFooter($: EngineInterface, step: NextStep): Promise<void> {
  const fp = fpOf(step)
  await update($, doneAtom, list => [...list.filter(x => x !== fp), fp].slice(-64))
  await update($, recAtom, () => step)
}

// ───────────────────────────── settings ─────────────────────────────

const USAGE =
  'Usage: /crab (settings pane), /crab hide|show (the card), /crab crew, /crab icon star|pet|moon|dumbbell|wave, /crab drag on|off (clicks: direct|buttons), /crab sound on|off, /crab chime on|off, /crab tap on|off, /crab orchestrator on|off, /crab diag on|off, /crab motion reduced|full, /crab theme auto|light|dark, /crab effort reset, /crab status'

/**
 * The setters the settings pane and the `/crab` subcommands share. Each writes
 * the state (what the card and the pane read, so both redraw; the card animates
 * from what it showed by itself) and the store (the next session).
 */

async function setIcon($: EngineInterface, icon: EffortIconKind): Promise<void> {
  await update($, effortIconAtom, () => icon)
  await $.store.set('icon', icon)
}

/** "Cliques no card": Direto (the Client region, mapping A) or Botões (the compact native row, B). Choosing Direto tries the Client again. */
async function setClicks($: EngineInterface, direct: boolean): Promise<void> {
  const mapping: Mapping = direct ? 'A' : 'B'
  await update($, mappingAtom, () => mapping)
  await $.store.set('mapping', mapping)
  if (direct) await update($, clientFaultAtom, () => null)
}

async function setSound($: EngineInterface, on: boolean): Promise<void> {
  await update($, soundAtom, () => on)
  await $.store.set('sound', on)
}

async function setChime($: EngineInterface, on: boolean): Promise<void> {
  await update($, chimeAtom, () => on)
  await $.store.set('chime', on)
}

async function setTap($: EngineInterface, on: boolean): Promise<void> {
  await update($, tapAtom, () => on)
  await $.store.set('tap', on)
}

/** "Orquestrador": plan mode -> Fable, approved plan -> Opus, subagents by role. */
async function setOrchestrator($: EngineInterface, on: boolean): Promise<void> {
  await update($, orchestratorAtom, () => on)
  await $.store.set('orchestrator', on)
}

async function setMotion($: EngineInterface, motion: 'reduced' | 'full'): Promise<void> {
  await update($, reducedMotionAtom, () => motion === 'reduced')
  await $.store.set('motion', motion)
}

async function setTheme($: EngineInterface, pref: ThemePref): Promise<void> {
  await update($, themePrefAtom, () => pref)
  await $.store.set('theme', pref)
}

/** "Repor effort da app" and `/crab effort reset`: the chosen override yields to the session's own effort. */
const resetEffort = async ($: EngineInterface): Promise<void> => {
  await update($, effortAtom, () => null)
}

const openSettings = ($: EngineInterface) => $.ui.open({ id: SETTINGS_PANE, title: SETTINGS_TITLE })

async function soundReport($: EngineInterface, on: boolean): Promise<string> {
  const last = await read($, soundLastAtom)
  const tail = !last ? 'no click played yet' : last.ok ? 'last click played' : `last click failed (${last.error ?? 'unknown'})`
  return `sound ${on ? 'on' : 'off'} (${tail})`
}

// ───────────────────────────── sounds ─────────────────────────────

/** Plays one clip behind its own switch; never throws, never holds the hook. */
async function playSound($: EngineInterface, kind: SoundKind): Promise<void> {
  try {
    const on = kind === 'click' ? await read($, soundAtom) : kind === 'chime' ? await read($, chimeAtom) : await read($, tapAtom)
    if (!on) return
  } catch {
    return
  }
  void $.audio.play({ asset: SOUND_ASSETS[kind] }).catch(() => undefined)
}

/** When the last tap played (this module's copy): one tap per approval, not one per event. */
let lastTapAt: number | null = null

async function approvalTap($: EngineInterface, input: unknown): Promise<void> {
  if (!isApprovalNotification(input)) return
  const now = await $.clock.now()
  if (!shouldTap(lastTapAt, now)) return
  lastTapAt = now
  await playSound($, 'tap')
}

// ───────────────────────────── orchestrator ─────────────────────────────

/** Toasts once per session that the model row offers no Fable. */
async function noteFableMissing($: EngineInterface): Promise<void> {
  let first = false
  await update($, fableNotedAtom, seen => {
    if (!seen) first = true
    return true
  })
  if (first) $.ui.toast(FABLE_MISSING_TOAST, { timeoutMs: 6000 })
}

/**
 * A plan-mode edge with the Orquestrador on: switch the session's model the way
 * the card does (config.set, the pill and every card follow), with a quiet toast.
 * Nothing when the session already runs on the target.
 */
async function orchestrate($: EngineInterface, edge: PlanEdge): Promise<void> {
  if (!(await read($, orchestratorAtom))) return
  let options: readonly string[] | undefined
  try {
    options = (await $.config.list()).find(r => r.key === 'model')?.options
  } catch {
    options = undefined
  }
  const target = planTarget(edge, options)
  if (target.fallback) await noteFableMissing($)
  let current: Family | null = null
  try {
    current = familyOf(await $.session.model())
  } catch {
    current = null
  }
  if (current === target.model) return
  let to: Family = target.model
  let failed = await applyChoice($, { what: 'model', value: to })
  if (failed !== null && to === 'fable') {
    // the row refused Fable: Opus, said once
    await noteFableMissing($)
    to = 'opus'
    failed = current === 'opus' ? 'already opus' : await applyChoice($, { what: 'model', value: to })
  }
  if (failed !== null) return
  $.ui.toast(switchToast(current, to), { timeoutMs: 3000 })
}

/** The session is (not) in plan mode now; entering it switches the model (orchestrate 'enter'). */
async function notePlan($: EngineInterface, active: boolean): Promise<void> {
  let entered = false
  await update($, planActiveAtom, prev => {
    entered = entersPlan(prev, active)
    return active
  })
  if (entered) await orchestrate($, 'enter')
}

// ───────────────────────────── crew ─────────────────────────────

/** Agent types the engine offered, by lowercase name -> its source (`built-in`, `plugin`, a settings source). */
const offerSources = new Map<string, string>()

/** A built-in agent type: its offer said so, or (no offer seen since this copy loaded) the exact map names it. */
function isBuiltInType(type: string): boolean {
  const src = offerSources.get(type.trim().toLowerCase())
  return src !== undefined ? src === 'built-in' : exactRole(type) !== null
}

const toEntries = (l: readonly CrewEntry[]): CrewEntry[] => l.slice(-CREW_MAX)

/** One costume request per type at a time (this module's copy). */
const costumeLocks = new Set<string>()

async function rememberCostume($: EngineInterface, key: string, value: StoredCostume): Promise<void> {
  await update($, costumesAtom, m => ({ ...m, [key]: value }))
}

/**
 * The costume of an unknown role's type: the cached one, the stored one, or one
 * cheap model call whose answer (or 'plain') is stored for good. An aborted call
 * (the dispatch was cut) stores nothing, so the next subagent of the type asks again.
 */
async function ensureCostume($: EngineInterface, type: string, description: string): Promise<void> {
  const key = costumeStoreKey(type)
  if (costumeLocks.has(key)) return
  costumeLocks.add(key)
  try {
    const known = await read($, costumesAtom)
    if (Object.prototype.hasOwnProperty.call(known, key)) return
    const stored = await $.store.get(key)
    if (stored !== undefined && stored !== null) {
      const g = stored === PLAIN ? null : validateCostumeGrid(stored)
      await rememberCostume($, key, g ? costumeGridJson(g) : PLAIN)
      return
    }
    let value: StoredCostume = PLAIN
    try {
      const r = await $.model.complete({ model: 'haiku', effort: 'low', prompt: costumeGridPrompt(type, description), maxTokens: 400, timeoutMs: 30_000 })
      if (!r.isAnswered && r.reason === 'aborted') return
      const g = r.isAnswered ? parseCostumeReply(r.text) : null
      if (g) value = costumeGridJson(g)
    } catch {
      value = PLAIN // the engine refused to send it: the plain pet, never asked again
    }
    await $.store.set(key, value)
    await rememberCostume($, key, value)
  } catch {
    // the store failed: nothing cached, the plain pet meanwhile
  } finally {
    costumeLocks.delete(key)
  }
}

/** Moves the Crew pane's durations while a subagent works; stops by itself when none does. */
let ticking = false
function scheduleTick($: EngineInterface): void {
  if (ticking) return
  ticking = true
  $.clock.after(CREW_TICK_MS, () => {
    ticking = false
    void (async () => {
      const l = await read($, crewAtom)
      if (!l.some(x => x.status === 'working')) return
      await update($, crewTickAtom, n => n + 1)
      scheduleTick($)
    })().catch(() => undefined)
  })
}

/** A new subagent: recorded, the Crew pane opened at the session's first, its costume asked for when the role is unknown. */
async function recordAgent($: EngineInterface, entry: CrewEntry): Promise<void> {
  await update($, crewAtom, l => toEntries(addEntry(l, entry)))
  let first = false
  await update($, crewOpenedAtom, opened => {
    if (!opened) first = true
    return true
  })
  if (first) await $.ui.open({ id: CREW_PANE, title: CREW_TITLE }).catch(() => undefined)
  if (entry.role === null) void ensureCostume($, entry.type, entry.description)
  scheduleTick($)
}

/**
 * Ends the first working entry `pick` finds with `status`; a chime when it took
 * 2 min or more. An entry that already ended is left (its first end stands, so
 * the call's result and the agent's turn.complete chime once).
 */
async function finishAgent($: EngineInterface, pick: (x: CrewEntry) => boolean, status: CrewStatus): Promise<void> {
  const now = await $.clock.now()
  let ended: CrewEntry | null = null
  await update($, crewAtom, l => {
    const cur = l.find(pick)
    if (!cur || cur.status !== 'working') return l
    const next = setStatus(l, cur.id, status, now)
    ended = next.find(x => x.id === cur.id) ?? null
    return toEntries(next)
  })
  const e: CrewEntry | null = ended
  if (e && shouldChime(durationOf(e, now))) await playSound($, 'chime')
}

/** agent.spawn started the subagent of an Agent call: its loop id, the model it runs on, the effort it is held at. */
async function noteSpawn($: EngineInterface, toolUseId: string, agentId: string | undefined, model: string, routed: boolean, fork: boolean): Promise<void> {
  await update($, crewAtom, l => {
    const cur = l.find(x => x.id === toolUseId)
    if (!cur) return l
    const effort = fork ? null : subagentEffort(cur.role, familyOf(model), cur.explicitEffort === true)
    return toEntries(patchEntry(l, toolUseId, { ...(agentId ? { agentId } : {}), model: model || cur.model, routed, effort }))
  })
}

/** What the inline row and the pane share: the theme and reduced motion, as the card reads them. */
async function look($: EngineInterface): Promise<{ theme: Theme; reduced: boolean }> {
  const [reducedPref, themePref] = await Promise.all([read($, reducedMotionAtom), read($, themePrefAtom)])
  let rows: { key: string; value: unknown }[] = []
  try {
    rows = await $.config.list()
  } catch {
    rows = []
  }
  const themeRow = rows.find(r => r.key === 'theme')?.value
  const theme: Theme =
    themePref === 'light' || themePref === 'dark' ? themePref : typeof themeRow === 'string' && themeRow.toLowerCase().includes('light') ? 'light' : 'dark'
  return { theme, reduced: rows.find(r => r.key === 'reduceMotion')?.value === true || reducedPref }
}

const openCrew = ($: EngineInterface) => $.ui.open({ id: CREW_PANE, title: CREW_TITLE })

/** What the crew reads of an Agent call's input. */
type AgentArgs = { subagent_type?: unknown; description?: unknown; model?: unknown; effort?: unknown }

/** An Agent call starts: its entry (role by type, then description), the pane at the session's first. */
async function agentStarted($: EngineInterface, id: string, a: AgentArgs): Promise<void> {
  // an Agent call without subagent_type runs general-purpose (Builder)
  const type = (typeof a.subagent_type === 'string' && a.subagent_type.trim()) || 'general-purpose'
  const description = oneLine(a.description)
  const entry: CrewEntry = {
    id,
    type,
    role: roleOf(type, description),
    model: typeof a.model === 'string' ? a.model : '',
    description,
    start: await $.clock.now(),
    status: 'working',
    ...(a.effort !== undefined && a.effort !== null ? { explicitEffort: true } : {}),
  }
  await recordAgent($, entry)
}

/** An Agent call resolved: the model it names, and its end (none while it runs in the background). */
async function agentEnded($: EngineInterface, id: string, r: unknown): Promise<void> {
  const m = agentResultModel(r)
  if (m) await update($, crewAtom, l => toEntries(patchEntry(l, id, { model: m })))
  const status = agentCallStatus(r)
  // null: launched in the background, the agent's own turn.complete ends it
  if (status) await finishAgent($, x => x.id === id, status)
}

/** EnterPlanMode ran (enter) or ExitPlanMode was approved (exit: out of plan, onto Opus, only at this edge). */
async function planEdge($: EngineInterface, edge: PlanEdge): Promise<void> {
  if (edge === 'enter') return notePlan($, true)
  await update($, planActiveAtom, () => false)
  await orchestrate($, 'exit')
}

// ═════════════════════════════ the terminal comfort features ═════════════════════════════
// Ported from the comfort mod (./comfort/* is pure; the calls are here). Identity, the terminal bar
// (./comfort/bar.tsx, a Client), the usage gauges, the clean chat, the task line and the band crabs.

type Api = EngineInterface

const HEARTBEAT_MS = 20_000
const identityAtom = atom({ plugin: 'crab-crew', key: 'identity' } as const, null)
const itemsAtom = atom({ plugin: 'crab-crew', key: 'items' } as const, [])
const isCleanAtom = atom({ plugin: 'crab-crew', key: 'isClean' } as const, true)
const barModelAtom = atom({ plugin: 'crab-crew', key: 'barModel' } as const, '')
const barEffortAtom = atom({ plugin: 'crab-crew', key: 'barEffort' } as const, null)
const isOpenAtom = atom({ plugin: 'crab-crew', key: 'isOpen' } as const, false)
const flashAtom = atom({ plugin: 'crab-crew', key: 'flash' } as const, '')
const barFailedAtom = atom({ plugin: 'crab-crew', key: 'barFailed' } as const, false)
// The usage bar: context, the 5-hour and weekly windows (or the cost off a subscription), and ultracode.
const usageAtom = atom({ plugin: 'crab-crew', key: 'usage' } as const, [])
const ultraAtom = atom({ plugin: 'crab-crew', key: 'ultra' } as const, false)
// What the clean chat keeps: one line of changed files per turn, one task line per turn.
const editsAtom = atom({ plugin: 'crab-crew', key: 'edits' } as const, {})
const openEditsAtom = atom({ plugin: 'crab-crew', key: 'openEdits' } as const, '')
const snapsAtom = atom({ plugin: 'crab-crew', key: 'snaps' } as const, {})
const taskTurnAtom = atom({ plugin: 'crab-crew', key: 'taskTurn' } as const, {})
const turnLastAtom = atom({ plugin: 'crab-crew', key: 'turnLast' } as const, {})
const turnNowAtom = atom({ plugin: 'crab-crew', key: 'turnNow' } as const, '')
const openLinesAtom = atom({ plugin: 'crab-crew', key: 'openLines' } as const, [])
const lineFoldsAtom = atom({ plugin: 'crab-crew', key: 'lineFolds' } as const, {})
const turnEditAtom = atom({ plugin: 'crab-crew', key: 'turnEdit' } as const, '')
const editOwnersAtom = atom({ plugin: 'crab-crew', key: 'editOwners' } as const, {})
const fatalAtom = atom({ plugin: 'crab-crew', key: 'fatal' } as const, [])
const doingAtom = atom({ plugin: 'crab-crew', key: 'doing' } as const, '')
// The agents at work (their crabs walk in the terminal bar) and each Agent call's crab, for its terminal row.
const bandCrewAtom = atom({ plugin: 'crab-crew', key: 'bandCrew' } as const, [])
const agentCrabsAtom = atom({ plugin: 'crab-crew', key: 'agentCrabs' } as const, {})

const REFRESH_MS = 2000
const FLASH_MS = 1400
const REQUEST_MAX_AGE_MS = 600_000
/** $.store key of the clean chat switch (on unless turned off). */
const CLEAN_KEY = 'clean'

let refreshTimer: { cancel: () => void } | undefined
let ticks = 0
let heartbeatTimer: { cancel: () => void } | undefined
let hasWarned = false
let lastTitle = ''
let flashTimer: { cancel: () => void } | undefined
let chosenEffort = ''
let modelRow: { key: string; options: readonly string[] } | undefined
// Opened from cc: the bar offers the way back to its card.
let fromCc = false
let branch = ''
let workDir = ''
// The turn's last main-loop call: when the turn ends on a failure, only that row speaks up.
let lastCall: { id: string; isError: boolean } | undefined
let progressRegistered = false
// The step the footer gauges drew last (hysteresis); a reload starts from the fullest row.
let footerStep = -1
// Only a session that started where the band crabs show (the terminal) asks a model to design one; on the
// desktop the pet rows stand for the agents, so a new kind gets the hash design and no model call.
let designsCrabs = false

const toEntry = (id: Identity): Entry => ({ ...id, lastSeen: 0 })
const toIdentity = (entry: Entry): Identity => ({ sessionId: entry.sessionId, emoji: entry.emoji, name: entry.name, since: entry.since })

async function homeDir($: Api): Promise<string | undefined> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home === undefined || home === '' ? undefined : home.replace(/[\\/]+$/, '')
}

// The window registry. The path never comes from anyone's text; it stays where comfort kept it, so the
// windows comfort named keep their emoji.
async function registryPath($: Api): Promise<string | undefined> {
  const home = await homeDir($)
  return home === undefined ? undefined : `${home}/.claude/comfort/windows.json`
}

async function loadRegistry($: Api, path: string): Promise<Entry[]> {
  try {
    const text = await $.fs.read(path)
    return parseRegistry(typeof text === 'string' ? text : undefined)
  } catch {
    return []
  }
}

function warnOnce($: Api, why: string) {
  if (!hasWarned) {
    hasWarned = true
    $.ui.toast(`crab: ${why}`)
  }
}

// Writes this window to the registry; if an older one has the same emoji, this one gives way.
async function commitWindow($: Api, mine: Entry): Promise<Entry> {
  const path = await registryPath($)
  if (path === undefined) {
    return mine
  }
  let entry = mine
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = await $.clock.now()
      entry = { ...entry, lastSeen: now }
      await $.fs.write(path, serialize(upsert(await loadRegistry($, path), entry, now)))
      await $.clock.sleep(150)
      const again = await loadRegistry($, path)
      if (!collides(again, entry, await $.clock.now())) {
        return entry
      }
      entry = { ...entry, emoji: pickEmoji(again, entry.sessionId, now, entry.emoji) }
    }
  } catch {
    warnOnce($, 'could not write the registry; the emoji only applies to this window')
  }
  return entry
}

// The name the session already has (~/.claude/sessions/<pid>.json), so startup never runs /rename
// when the name is already right.
async function sessionName($: Api, sessionId: string): Promise<string | undefined> {
  try {
    const home = await homeDir($)
    if (home === undefined) {
      return undefined
    }
    const dir = `${home}/.claude/sessions`
    for (const entry of await $.fs.list(dir)) {
      if (!entry.name.endsWith('.json')) {
        continue
      }
      try {
        const text = await $.fs.read(`${dir}/${entry.name}`)
        const data = JSON.parse(typeof text === 'string' ? text : '') as { sessionId?: unknown; name?: unknown }
        if (data.sessionId === sessionId && typeof data.name === 'string' && data.name !== '') {
          return data.name
        }
      } catch {
        // a file being written or not ours: skip it
      }
    }
  } catch {
    // no sessions folder: nothing to adopt
  }
  return undefined
}

// The session name is the tab title: runs /rename outside the hook, only when it changes.
async function syncTitle($: Api, title: string) {
  try {
    await $.command.run({ command: 'rename', args: title })
  } catch {
    // without /rename the identity stays in the bar only
  }
}

// Only a change the user made (a rename left by cc) renames the session; starts and collisions just update the bar.
async function adopt($: Api, saved: Entry, rename = false) {
  const id = toIdentity(saved)
  await update($, identityAtom, () => id)
  const title = `${id.emoji} ${id.name}`
  if (rename && title !== lastTitle) {
    lastTitle = title
    $.clock.after(400, () => {
      void syncTitle($, title)
    })
  }
}

async function changeIdentity($: Api, patch: Partial<Pick<Identity, 'emoji' | 'name'>>) {
  const current = await read($, identityAtom)
  if (current === null) {
    return
  }
  const next = { ...current, ...patch }
  await adopt($, toEntry(next), true)
  const saved = await commitWindow($, toEntry(next))
  if (saved.emoji !== next.emoji) {
    await adopt($, saved, true)
  }
}

async function beat($: Api) {
  const current = await read($, identityAtom)
  if (current === null) {
    return
  }
  const sessionId = await $.session.id()
  const saved = await commitWindow($, toEntry({ ...current, sessionId }))
  if (saved.emoji !== current.emoji || sessionId !== current.sessionId) {
    await adopt($, saved)
  }
}

type Ui = ReturnType<Api['ui']['resolve']>
type BarView = {
  id: Identity | null
  model: string
  effort: BarEffort | null
  isOpen: boolean
  flash: string
  usage: readonly Usage[]
  ultra: boolean
  files: number
  crew: readonly Member[]
  now: number
}

async function readBarView($: Api): Promise<BarView> {
  return {
    id: await read($, identityAtom),
    model: await read($, barModelAtom),
    effort: await read($, barEffortAtom),
    isOpen: await read($, isOpenAtom),
    flash: await read($, flashAtom),
    usage: await read($, usageAtom),
    ultra: await read($, ultraAtom),
    files: new Set(Object.values(await read($, editsAtom)).flat()).size,
    crew: await read($, bandCrewAtom),
    now: await $.clock.now(),
  }
}

// Reads model and effort; only writes what changed, so it doesn't redraw for nothing.
async function refreshBar($: Api, withEffort: boolean) {
  try {
    const current = await $.session.model()
    if (current !== (await read($, barModelAtom))) {
      await update($, barModelAtom, () => current)
    }
    if (withEffort) {
      let value = chosenEffort
      if (value === '') {
        const fromEnv = ((await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')) ?? '').toLowerCase()
        value = isLevel(fromEnv) ? fromEnv : ''
      }
      const saved = (await $.settings.read()) as {
        effortLevel?: unknown
        modelSettings?: Record<string, { effortLevel?: unknown }>
        ultracode?: unknown
      }
      if (value === '') {
        // the env var, then this model's own saved level, then the general one (as /effort reads them)
        const own = saved.modelSettings?.[current]?.effortLevel
        value = typeof own === 'string' && isLevel(own) ? own : typeof saved.effortLevel === 'string' ? saved.effortLevel : ''
        // nothing saved anywhere: Claude Code runs at medium
        value = isLevel(value) ? value : 'medium'
      }
      const next: BarEffort = { key: '', value, options: [...LEVELS] }
      if (JSON.stringify(next) !== JSON.stringify(await read($, barEffortAtom))) {
        await update($, barEffortAtom, () => next)
      }
      const isUltra = saved.ultracode === true || saved.ultracode === 'on'
      if (isUltra !== (await read($, ultraAtom))) {
        await update($, ultraAtom, () => isUltra)
      }
    }
    await readUsage($)
    await applyRenameRequest($)
  } catch {
    // nothing read: the bar stays as it was
  }
}

// cc renames an open chat by leaving a request: the window it names applies it like a rename made here
// (the tab title follows), then removes it.
async function applyRenameRequest($: Api) {
  const path = (await registryPath($))?.replace(/windows\.json$/, 'rename-requests.json')
  const current = await read($, identityAtom)
  if (path === undefined || current === null) {
    return
  }
  let data: { requests?: Record<string, { title?: unknown; at?: unknown }> }
  try {
    const text = await $.fs.read(path)
    data = JSON.parse(typeof text === 'string' ? text : '') as typeof data
  } catch {
    return
  }
  const request = data.requests?.[current.sessionId]
  if (request === undefined || data.requests === undefined) {
    return
  }
  delete data.requests[current.sessionId]
  try {
    await $.fs.write(path, JSON.stringify(data, null, 2))
  } catch {
    // left in place: a later refresh tries again
    return
  }
  if (typeof request.title !== 'string' || typeof request.at !== 'number' || (await $.clock.now()) - request.at > REQUEST_MAX_AGE_MS) {
    return
  }
  const parts = splitTitle(request.title)
  await changeIdentity(
    $,
    parts !== undefined ? { emoji: parts.emoji, name: cleanName(parts.name, current.name) } : { name: cleanName(request.title, current.name) },
  )
}

async function readUsage($: Api) {
  try {
    const next = toUsage(await $.session.usage(), await $.clock.now())
    if (JSON.stringify(next) !== JSON.stringify(await read($, usageAtom))) {
      await update($, usageAtom, () => next)
    }
  } catch {
    // no reading yet: the gauges show —
  }
}

// Ultracode on or off through the `ultracode` settings key, which Claude Code applies live: running
// `/effort ultracode` would print its echo and reply in the chat (rows no mod can hide).
async function toggleUltra($: Api) {
  const on = !(await read($, ultraAtom))
  await update($, ultraAtom, () => on)
  try {
    const path = `${(await homeDir($)) ?? ''}/.claude/settings.json`
    const text = await $.fs.read(path)
    const data = JSON.parse(typeof text === 'string' && text.trim() !== '' ? text : '{}') as Record<string, unknown>
    if (on) {
      data.ultracode = true
    } else {
      delete data.ultracode
    }
    await $.fs.write(path, `${JSON.stringify(data, null, 2)}\n`)
  } catch {
    warnOnce($, 'could not switch ultracode')
    await update($, ultraAtom, () => !on)
  }
}

// Back to the cc card: Claude exits and cc's loop draws the card again.
async function backToCc($: Api) {
  try {
    await $.command.run({ command: 'exit', args: '' })
  } catch {
    $.ui.toast('press ctrl+d twice to go back to cc')
  }
}

async function readBranch($: Api, cwd: string) {
  try {
    const head = await $.fs.read(`${cwd.replace(/[\\/]+$/, '')}/.git/HEAD`)
    const match = /ref: refs\/heads\/(.+)/.exec(typeof head === 'string' ? head : '')
    branch = match?.[1]?.trim() ?? ''
  } catch {
    branch = ''
  }
}

// The brief ✓ that confirms a choice.
async function flashConfirm($: Api, key: string) {
  await update($, flashAtom, () => key)
  flashTimer?.cancel()
  flashTimer = $.clock.after(FLASH_MS, () => {
    void update($, flashAtom, () => '')
  })
}

// /config's model row changes the model without writing anything in the chat.
async function findModelRow($: Api) {
  try {
    const one = (await $.config.list()).find(row => row.key === 'model')
    modelRow = one === undefined || one.options === undefined || one.options.length === 0 ? undefined : { key: one.key, options: one.options }
  } catch {
    modelRow = undefined
  }
}

// This session's effort comes from the environment variable the engine reads: nothing in the chat, nothing in settings.
async function applyEffortEnv($: Api, value: string): Promise<boolean> {
  try {
    await $.env.set('CLAUDE_CODE_EFFORT_LEVEL', value)
    return true
  } catch {
    return false
  }
}

async function viaConfig($: Api, key: string, value: string): Promise<boolean> {
  try {
    const set = await $.config.set({ key, value })
    return !('deny' in set && set.deny !== undefined)
  } catch {
    return false
  }
}

async function setBarModel($: Api, alias: string) {
  await update($, barModelAtom, () => alias)
  await flashConfirm($, `model-${alias}`)
  if (modelRow === undefined) {
    await findModelRow($)
  }
  const option = modelRow?.options.find(one => one.toLowerCase().includes(alias))
  if (modelRow !== undefined && option !== undefined && (await viaConfig($, modelRow.key, option))) {
    await refreshBar($, false)
    return
  }
  // Only reached with no /config row or when Fable asks for consent: /model runs once, hidden.
  try {
    await $.command.run({ command: 'model', args: alias })
  } catch {
    warnOnce($, 'could not change the model')
  }
  await refreshBar($, false)
}

async function setBarEffort($: Api, value: string) {
  if (!isLevel(value)) {
    return
  }
  chosenEffort = value
  await update($, barEffortAtom, () => ({ key: '', value, options: [...LEVELS] }))
  await flashConfirm($, `effort-${value}`)
  if (!(await applyEffortEnv($, value))) {
    warnOnce($, 'could not change the effort')
  }
}

/** "Chat limpo" and `/clean`: the clean chat on or off, remembered for the next session. */
async function setClean($: Api, on: boolean): Promise<void> {
  await update($, isCleanAtom, () => on)
  await $.store.set(CLEAN_KEY, on).catch(() => undefined)
}

function headerRow($: Api, ui: Ui, v: BarView) {
  const { Box, Button, Text } = ui
  if (v.id === null) {
    return null
  }
  const level = v.effort?.value ?? ''
  return (
    <Box>
      <Button key="toggle" label={v.isOpen ? '▾' : '▸'} plain dimColor onPress={() => update($, isOpenAtom, was => !was)} />
      <Text> </Text>
      <Text>{`${v.id.emoji} ${v.id.name}`}</Text>
      <Text dimColor>{'   ·   '}</Text>
      <Text color="claude">{activeModel(v.model)}</Text>
      {level !== '' && <Text dimColor>{` · ${level}`}</Text>}
    </Box>
  )
}

// A radio-style row of options: ● the active one (coloured), ○ the others (light up on hover).
function choiceRow(ui: Ui, label: string, group: string, options: readonly string[], active: string, flashKey: string, onPick: (option: string) => void) {
  const { Box, Button, Text } = ui
  return (
    <Box>
      <Text dimColor>{label}</Text>
      {options.map(option => {
        const key = `${group}-${option}`
        return option === active ? (
          <Box key={key}>
            <Text color="claude" bold>
              {flashKey === key ? '✓' : '●'} {option}
            </Text>
            <Text>{'   '}</Text>
          </Box>
        ) : (
          <Box key={key}>
            <Button key={key} label={`○ ${option}`} plain dimColor hover={{ color: 'claude' }} onPress={() => onPick(option)} />
            <Text>{'   '}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

function barProps(v: BarView): BarProps {
  return {
    isOpen: v.isOpen,
    model: activeModel(v.model),
    models: offeredModels(v.model, modelRow?.options),
    effort: v.effort?.value ?? '',
    ultra: v.ultra,
    message: barMessage(v.usage, v.files, branch),
    canBack: fromCc,
    canSettings: true,
    crew: v.crew.map(m => ({
      id: m.id,
      label: m.label,
      status: m.status,
      durationMs: m.durationMs,
      name: m.crab?.name ?? '',
      color: m.crab?.color ?? '',
      accessory: m.crab?.accessory ?? '',
      startedAt: m.startedAt,
      endedAt: m.endedAt,
    })),
    now: v.now,
  }
}

// ── the band crabs (terminal): one little crab per kind of task, kept across sessions in the store

let bandCrabs: Crab[] = [...SEED_CRABS]
let crabsLoaded = false
let storeReadable = true
const CRAB_KEY = 'crabs'
const BAND_CREW_MAX = 24
const LEAVE_MS = 4500 // a finished crab sits, then leaves the band
const BAND_STALE_MS = 30 * 60_000 // a crab whose agent no one can see any more leaves after this
const DESIGN_MS = 8000

/** The designed crabs in the store (seeds are never saved), or undefined when the store could not be read. */
async function storedCrabs($: Api): Promise<Crab[] | undefined> {
  try {
    const saved = (await $.store.get(CRAB_KEY)) as { crabs?: unknown[] } | undefined
    return (saved?.crabs ?? []).map(saneCrab).filter((c): c is Crab => c !== undefined)
  } catch {
    return undefined
  }
}

async function loadCrabs($: Api) {
  if (crabsLoaded) {
    return
  }
  const saved = await storedCrabs($)
  if (saved === undefined) {
    storeReadable = false // never save over a store we could not read
    return
  }
  storeReadable = true
  crabsLoaded = true
  let next: Crab[] = [...SEED_CRABS]
  for (const c of saved) {
    next = addCrab(next, c)
  }
  bandCrabs = next
}

/** Saves one crab: the store is read again first, so another window's new crabs are kept. */
async function saveCrab($: Api, crab: Crab) {
  bandCrabs = addCrab(bandCrabs, crab)
  if (!storeReadable) {
    return
  }
  const saved = await storedCrabs($)
  if (saved === undefined) {
    return
  }
  let merged: Crab[] = [...SEED_CRABS]
  for (const c of saved) {
    merged = addCrab(merged, c)
  }
  merged = addCrab(merged, crab)
  for (const c of merged) {
    if (!bandCrabs.some(mine => mine.name === c.name)) {
      bandCrabs = addCrab(bandCrabs, c)
    }
  }
  try {
    await $.store.set(CRAB_KEY, { crabs: merged.filter(c => !SEED_CRABS.some(seed => seed.name === c.name)) })
  } catch {
    // kept for this session at least
  }
}

/** The design when no model answers: kept for this session only, with no keywords (it never takes over other tasks). */
function fallbackCrab(subagentType: string, description: string): Crab {
  const name = taskWords(description)[0] ?? 'crab'
  return { ...hashCrab(bandCrabs.some(c => c.name === name) ? `${name}2` : name, subagentType, []), keywords: [] }
}

const pendingDesigns = new Map<string, Promise<Crab>>()

/**
 * The crab for a new kind of task: Haiku picks an existing one that fits (remembered for this kind from then on)
 * or designs a new one. Each request has its own 8 s; the same task asked twice at once shares one request.
 * No valid answer, or a desktop session (no terminal bar to show it): a hash design, this session only.
 */
function designCrab($: Api, subagentType: string, description: string): Promise<Crab> {
  const key = `${subagentType}|${flatLine(description).toLowerCase()}`
  const pending = pendingDesigns.get(key)
  if (pending !== undefined) {
    return pending
  }
  const run = async (): Promise<Crab> => {
    const again = matchCrab(bandCrabs, subagentType, description)
    if (again !== undefined) {
      return again
    }
    if (designsCrabs) {
      try {
        const { system, prompt } = designPrompt(bandCrabs, subagentType, description)
        const r = await $.model.complete({ model: 'haiku', system, prompt, maxTokens: 300, timeoutMs: DESIGN_MS })
        if (r.isAnswered) {
          const got = parseDesign(r.text, bandCrabs, subagentType)
          if (got !== undefined && 'reuse' in got) {
            // this kind is the reused crab's from now on: its agent type and a word or two of the task join it
            const kind = subagentType.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim()
            const grown: Crab = {
              ...got.reuse,
              kinds:
                kind !== '' && !['general purpose', 'general', 'fork', 'teammate', 'claude', 'agent'].includes(kind) && !got.reuse.kinds.includes(kind)
                  ? [...got.reuse.kinds, kind]
                  : got.reuse.kinds,
              keywords: [...new Set([...got.reuse.keywords, ...taskWords(description).slice(0, 2)])].slice(0, 10),
            }
            if (
              !SEED_CRABS.some(seed => seed.name === grown.name) ||
              grown.kinds.length !== got.reuse.kinds.length ||
              grown.keywords.length !== got.reuse.keywords.length
            ) {
              await saveCrab($, grown)
            }
            return grown
          }
          if (got !== undefined) {
            await saveCrab($, got.crab)
            return got.crab
          }
        }
      } catch {
        // a blocked or refused model: the hash design
      }
    }
    const made = fallbackCrab(subagentType, description)
    bandCrabs = addCrab(bandCrabs, made) // this session only
    return made
  }
  const job = run().finally(() => pendingDesigns.delete(key))
  pendingDesigns.set(key, job)
  return job
}

async function setMember($: Api, id: string, change: (m: Member) => Member) {
  await update($, bandCrewAtom, was => was.map(m => (m.id === id ? change(m) : m)))
}

function leaveLater($: Api, id: string) {
  $.clock.after(LEAVE_MS, () => {
    void update($, bandCrewAtom, was => was.filter(m => m.id !== id))
  })
}

/** The chat row's memory of an Agent call: merged, never replaced (a design and an end can land in any order). */
async function rememberCall($: Api, toolUseId: string, part: { name?: string; color?: string; accessory?: string; ms?: number; failed?: boolean }) {
  if (toolUseId === '') {
    return
  }
  await update($, agentCrabsAtom, was => ({ ...was, [toolUseId]: { ...(was[toolUseId] ?? {}), ...part } }))
}

async function bandCrewStart(
  $: Api,
  e: { tool_use_id: string; description: string; subagentType: string; background: boolean; workflow?: unknown },
  agentId: string | undefined,
) {
  await loadCrabs($)
  const now = await $.clock.now()
  const label = flatLine(e.description) || 'agent'
  const id = agentId ?? `${e.tool_use_id}:${label}`
  const known = matchCrab(bandCrabs, e.subagentType, label)
  const member: Member = {
    id,
    toolUseId: e.tool_use_id,
    label,
    crab: known ?? null,
    status: known === undefined ? 'egg' : 'running',
    durationMs: 0,
    background: e.background,
    workflow: e.workflow !== undefined,
    startedAt: now,
    endedAt: 0,
  }
  // the cap only ever drops crabs that already finished; a working one always keeps its place
  await update($, bandCrewAtom, was => {
    const next = [...was.filter(m => m.id !== id), member]
    while (next.length > BAND_CREW_MAX) {
      const at = next.findIndex(m => m.status === 'done' || m.status === 'failed')
      if (at < 0) {
        break
      }
      next.splice(at, 1)
    }
    return next
  })
  const forRow = e.workflow === undefined
  if (known !== undefined) {
    if (forRow) {
      await rememberCall($, e.tool_use_id, { name: known.name, color: known.color, accessory: known.accessory })
    }
    return
  }
  const crab = await designCrab($, e.subagentType, label)
  await setMember($, id, m => ({ ...m, crab, status: m.status === 'egg' ? 'running' : m.status }))
  if (forRow) {
    await rememberCall($, e.tool_use_id, { name: crab.name, color: crab.color, accessory: crab.accessory })
  }
}

async function bandCrewEnd($: Api, match: (m: Member) => boolean, ok: boolean, durationMs: number) {
  const hit = (await read($, bandCrewAtom)).find(m => match(m) && (m.status === 'running' || m.status === 'egg'))
  if (hit === undefined) {
    return
  }
  const now = await $.clock.now()
  // an agent that ended before its design landed still ends as a crab, never as an egg
  const crab = hit.crab ?? fallbackCrab('', hit.label)
  await setMember($, hit.id, m => ({ ...m, crab: m.crab ?? crab, status: ok ? 'done' : 'failed', durationMs, endedAt: now }))
  if (!hit.workflow) {
    await rememberCall($, hit.toolUseId, { ms: durationMs, failed: !ok })
  }
  leaveLater($, hit.id)
}

/**
 * An Agent call returned. Its crab ends only when its agent did: a call sent to the background (ctrl+b, or its
 * definition) returns while the agent still works, and its own run's end (turn.complete) is what counts then.
 */
async function bandAgentReturned($: Api, id: string, r: unknown, started: number) {
  const failed = typeof r === 'object' && r !== null && 'isError' in r && (r as { isError?: boolean }).isError === true
  const mine = (await read($, bandCrewAtom)).filter(m => m.toolUseId === id && !m.workflow && (m.status === 'running' || m.status === 'egg'))
  if (mine.length === 0) {
    return
  }
  const listed = await $.agent.list().catch(() => undefined)
  for (const m of mine) {
    const agent = listed?.find(a => a.id === m.id)
    const ended = failed || (agent !== undefined ? ['completed', 'failed', 'killed'].includes(agent.status) : !m.background)
    if (ended) {
      await bandCrewEnd($, one => one.id === m.id, !failed && agent?.status !== 'failed' && agent?.status !== 'killed', (await $.clock.now()) - started)
    } else if (!m.background) {
      await setMember($, m.id, one => ({ ...one, background: true }))
    }
  }
}

/**
 * Every 2 s: finished crabs past their time leave (a reload cancels the leave timers), and a crab whose agent the
 * engine lists as ended ends too (a backgrounded call, a missed turn.complete); one nobody can see for 30 min leaves.
 */
async function sweepBandCrew($: Api) {
  const members = await read($, bandCrewAtom)
  if (members.length === 0) {
    return
  }
  const now = await $.clock.now()
  let listed: readonly { id: string; status: string }[] | undefined
  try {
    listed = await $.agent.list()
  } catch {
    listed = undefined
  }
  for (const m of members) {
    if (m.status !== 'running' && m.status !== 'egg') {
      continue
    }
    const agent = listed?.find(a => a.id === m.id)
    if (agent !== undefined && ['completed', 'failed', 'killed'].includes(agent.status)) {
      await bandCrewEnd($, one => one.id === m.id, agent.status === 'completed', now - m.startedAt)
    }
  }
  const gone = (m: Member) =>
    ((m.status === 'done' || m.status === 'failed') && now - m.endedAt > LEAVE_MS) ||
    ((m.status === 'running' || m.status === 'egg') && now - m.startedAt > BAND_STALE_MS && listed?.find(a => a.id === m.id) === undefined)
  if ((await read($, bandCrewAtom)).some(gone)) {
    await update($, bandCrewAtom, was => was.filter(m => !gone(m)))
  }
}

// ── the task line and the clean chat

const TASK_TOOLS: readonly string[] = [PROGRESS_TOOL, 'TodoWrite', 'TaskCreate', 'TaskUpdate']
const TONE_COLOR: Record<string, string> = { accent: 'claude', done: 'success', warn: 'warning', text: 'text', rule: 'subtle' }
const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']
// Tools whose rows are the conversation itself: they always draw as the engine draws them.
const KEEP_TOOLS: readonly string[] = ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']
// Calls the task line already shows: they never become the spinner's words.
const QUIET_TOOLS: readonly string[] = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']

// Changes the running task list (TaskCreate/TaskUpdate build it call by call).
async function setItems($: Api, change: (list: readonly Item[]) => Item[]) {
  await update($, itemsAtom, list => change(list))
}

// A task call's row: remembers its list and its turn; the turn's latest call is the one that draws the line.
async function noteTaskRow($: Api, id: string, list: readonly Item[]) {
  const turn = await read($, turnNowAtom)
  const key = turn === '' ? 'idle' : turn
  await update($, snapsAtom, was => ({ ...was, [id]: [...list] }))
  await update($, taskTurnAtom, was => ({ ...was, [id]: key }))
  await update($, turnLastAtom, was => ({ ...was, [key]: id }))
}

// A resumed chat: its old task calls get their turns back, so each past turn still shows one frozen line.
async function rebuildTaskRows($: Api) {
  try {
    const messages = await $.session.messages()
    if (!Array.isArray(messages)) {
      return
    }
    const of: Record<string, string> = {}
    const last: Record<string, string> = {}
    const lists: Record<string, Item[]> = {}
    let turn = 0
    for (const message of messages) {
      if (message.role === 'user' && message.text.trim() !== '' && (message.toolResults ?? []).length === 0) {
        turn += 1
      }
      for (const use of message.toolUses ?? []) {
        if (!TASK_TOOLS.includes(use.tool)) {
          continue
        }
        const list = listFromInput(use.tool, use.input)
        if (list.length === 0) {
          continue
        }
        of[use.tool_use_id] = `past:${turn}`
        last[`past:${turn}`] = use.tool_use_id
        lists[use.tool_use_id] = list
      }
    }
    if (Object.keys(of).length > 0) {
      await update($, snapsAtom, was => ({ ...lists, ...was }))
      await update($, taskTurnAtom, was => ({ ...of, ...was }))
      await update($, turnLastAtom, was => ({ ...last, ...was }))
    }
  } catch {
    // no transcript to read: old task rows stay quiet
  }
}

// Each turn's edits gather under its first edit: that row draws the turn's line, the others draw nothing.
async function noteEdit($: Api, id: string): Promise<string> {
  let owner = await read($, turnEditAtom)
  if (owner === '') {
    owner = id
    await update($, turnEditAtom, () => id)
    await update($, editsAtom, was => ({ ...was, [id]: [] }))
  }
  const of = owner
  await update($, editOwnersAtom, was => ({ ...was, [id]: of }))
  return owner
}

async function addEdit($: Api, owner: string, path: string) {
  if (path === '') {
    return
  }
  await update($, editsAtom, was => {
    const files = was[owner] ?? []
    return files.includes(path) ? was : { ...was, [owner]: [...files, path] }
  })
}

/** The progress tool's schema, as the model reads it. */
const PROGRESS_SPEC = {
  name: 'progress',
  description:
    'Shows the user one live task line in the chat (it unfolds into the tasks and their steps). Call it at the ' +
    'start of any request with 2 or more steps with every task (exactly one in_progress; big tasks carry 2 to 6 ' +
    'subtasks), and again after each step with updated statuses. Always send the whole list, in English.',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The task, short (e.g. "Fix the login test")' },
            active: { type: 'string', description: 'Present-continuous form shown while in progress (e.g. "Fixing the login test")' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            subtasks: {
              type: 'array',
              description: 'Optional steps inside this task (2 to 6), for big requests',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'The step, short' },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                },
                required: ['text', 'status'],
              },
            },
          },
          required: ['text', 'status'],
        },
      },
    },
    required: ['tasks'],
  },
} as const

/** session.start's comfort half (interactive sessions): identity, the bar's readings, the progress tool, the commands. */
async function comfortStart($: Api, e: { cwd: string; surface: string | null }) {
  $.ui.status(undefined)
  designsCrabs = e.surface !== null && e.surface !== 'desktop'
  const sessionId = await $.session.id()
  const now = await $.clock.now()
  const path = await registryPath($)
  const entries = path === undefined ? [] : await loadRegistry($, path)
  const existing = await sessionName($, sessionId)
  const fromTitle = existing === undefined ? undefined : splitTitle(existing)
  const saved =
    (await read($, identityAtom)) ?? (fromTitle === undefined ? undefined : { sessionId, emoji: fromTitle.emoji, name: fromTitle.name, since: now })
  if (existing !== undefined) {
    lastTitle = existing
  }
  workDir = e.cwd
  fromCc = (await $.env.get('CC_ACTIVE')) === '1'
  await readBranch($, e.cwd)
  await rebuildTaskRows($)
  const mine = claim(entries, sessionId, folderName(e.cwd), now, saved)
  await adopt($, await commitWindow($, mine))

  heartbeatTimer?.cancel()
  heartbeatTimer = $.clock.every(HEARTBEAT_MS, () => {
    void beat($)
  })

  await findModelRow($)
  await refreshBar($, true)
  await loadCrabs($)
  try {
    await $.tool.register(PROGRESS_SPEC)
    progressRegistered = true
  } catch {
    warnOnce($, 'the progress tool could not be registered')
  }
  refreshTimer?.cancel()
  refreshTimer = $.clock.every(REFRESH_MS, () => {
    ticks += 1
    void refreshBar($, ticks % 5 === 0)
    void sweepBandCrew($).catch(() => undefined)
  })

  if (fromCc) {
    try {
      await $.command.register({ name: 'cc', description: 'Back to the cc card (ends this Claude)' })
    } catch {
      // the bar's ⇠ cc still works
    }
  }
  try {
    await $.command.register({ name: 'clean', description: 'Turns the clean tool view on or off' })
  } catch {
    warnOnce($, 'the /clean command could not be registered')
  }
  try {
    await $.command.register({ name: 'panel', description: 'Opens or closes the model and effort controls' })
  } catch {
    warnOnce($, 'the /panel command could not be registered')
  }
}

// ───────────────────────────── register ─────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      const [mapping, sound, motion, theme, icon, chime, tap, orchestrator, clean, diagOn] = await Promise.all([
        $.store.get('mapping'),
        $.store.get('sound'),
        $.store.get('motion'),
        $.store.get('theme'),
        $.store.get('icon'),
        $.store.get('chime'),
        $.store.get('tap'),
        $.store.get('orchestrator'),
        $.store.get(CLEAN_KEY),
        $.store.get('diag'),
      ])
      if (typeof diagOn === 'boolean') await update($, diagAtom, () => diagOn)
      if (mapping === 'A' || mapping === 'B') await update($, mappingAtom, () => mapping)
      if (typeof sound === 'boolean') await update($, soundAtom, () => sound)
      if (typeof chime === 'boolean') await update($, chimeAtom, () => chime)
      if (typeof tap === 'boolean') await update($, tapAtom, () => tap)
      if (typeof orchestrator === 'boolean') await update($, orchestratorAtom, () => orchestrator)
      if (typeof clean === 'boolean') await update($, isCleanAtom, () => clean)
      if (motion === 'reduced' || motion === 'full') await update($, reducedMotionAtom, () => motion === 'reduced')
      if (theme === 'auto' || theme === 'light' || theme === 'dark') await update($, themePrefAtom, () => theme)
      if (isIcon(icon)) await update($, effortIconAtom, () => icon)
      else if (typeof icon === 'string') {
        // a kind that no longer exists (flame, rings, dots were removed): back to the default (the pet)
        await update($, effortIconAtom, () => DEFAULT_ICON)
        await $.store.set('icon', DEFAULT_ICON)
      }
    } catch {
      // defaults stand
    }
    // a new session starts with the app's own effort
    await update($, effortAtom, () => null)
    void diag($, `session.start crab-crew surface=${String(e.surface)} interactive=${String(e.isInteractive)}`)
    // a resumed transcript: which footers are done, and which is the newest (a new session has none)
    await scanTranscript($)
    try {
      await $.command.register({
        name: 'crab',
        description:
          'Crab Crew settings: /crab opens the pane; or /crab hide|show, crew, icon star|pet|moon|dumbbell|wave, drag on|off, sound|chime|tap on|off, orchestrator on|off, diag on|off, motion reduced|full, theme auto|light|dark, effort reset, status',
      })
    } catch {
      // the gear on the card and the ≡ on the terminal bar still open the pane
    }
    if (e.isInteractive) {
      try {
        await comfortStart($, e)
      } catch {
        // what was set up stays; the rest waits for the next start
      }
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      const path = await registryPath($)
      if (path !== undefined) {
        const now = await $.clock.now()
        await $.fs.write(path, serialize(removeWindow(await loadRegistry($, path), e.sessionId, now)))
      }
    } catch {
      // the registry expires on its own through the heartbeat
    }
    if (e.reason !== 'clear' && e.reason !== 'resume') {
      heartbeatTimer?.cancel()
      refreshTimer?.cancel()
    }
    return next(e)
  })

  // ── commands: /crab (settings), and the terminal bar's /clean, /panel, /cc and /effort

  on('command.run', { command: 'crab' }, async ($, e) => {
    const [what, value] = e.args.trim().toLowerCase().split(/\s+/)
    const flag = value === 'on' ? true : value === 'off' ? false : null
    if (!what) {
      const opened = await openSettings($)
      return { text: opened.isPlaced ? 'Crab Crew: ajustes abertos.' : `Crab Crew: ajustes abertos (${opened.reason}).` }
    }
    if (what === 'hide' || what === 'show') {
      await setLook($, what === 'hide' ? 'hidden' : 'bar')
      return { text: what === 'hide' ? 'Crab: card hidden (the handle above the prompt, or /crab show, brings it back).' : 'Crab: card shown.' }
    }
    if (what === 'crew') {
      const opened = await openCrew($)
      return { text: opened.isPlaced ? 'Crab: Crew aberta.' : `Crab: Crew aberta (${opened.reason}).` }
    }
    if (what === 'diag' && flag !== null) {
      await setDiag($, flag)
      return { text: flag ? 'Crab: diagnóstico ligado (~/.claude/crab-crew/diag.log).' : 'Crab: diagnóstico desligado.' }
    }
    if ((what === 'chime' || what === 'tap' || what === 'orchestrator') && flag !== null) {
      if (what === 'chime') await setChime($, flag)
      else if (what === 'tap') await setTap($, flag)
      else await setOrchestrator($, flag)
      return { text: `Crab: ${what} ${flag ? 'on' : 'off'}.` }
    }
    if (what === 'icon' && isIcon(value)) {
      // every known card's knob cross-fades to the new icon
      await setIcon($, value)
      return { text: `Crab: icon ${value}.` }
    }
    if (what === 'drag' && flag !== null) {
      await setClicks($, flag)
      return { text: flag ? 'Crab: cliques diretos (a região de ponteiro sobre o card).' : 'Crab: cliques por botões (linha nativa compacta).' }
    }
    if (what === 'sound') {
      if (flag !== null) await setSound($, flag)
      return { text: `Crab: ${await soundReport($, await read($, soundAtom))}.` }
    }
    if (what === 'motion' && (value === 'reduced' || value === 'full')) {
      await setMotion($, value)
      return { text: `Crab: motion ${value}.` }
    }
    if (what === 'theme' && (value === 'auto' || value === 'light' || value === 'dark')) {
      await setTheme($, value)
      return { text: `Crab: theme ${value}${value === 'auto' ? " (follows the config row 'theme')" : ''}.` }
    }
    if (what === 'effort' && value === 'reset') {
      await resetEffort($)
      return { text: "Crab: effort override cleared; the session's own effort applies." }
    }
    // `/crab status` and anything unknown: the settings, then the usage
    const [mapping, sound, motion, theme, effort, icon, chime, tap, orchestrator, fault, diagOn] = await Promise.all([
      read($, mappingAtom),
      read($, soundAtom),
      read($, reducedMotionAtom),
      read($, themePrefAtom),
      read($, effortAtom),
      read($, effortIconAtom),
      read($, chimeAtom),
      read($, tapAtom),
      read($, orchestratorAtom),
      read($, clientFaultAtom),
      read($, diagAtom),
    ])
    const onOff = (b: boolean): string => (b ? 'on' : 'off')
    const clicks = mapping === 'A' ? (fault !== null ? `direct (fallback row: ${fault})` : 'direct') : 'buttons'
    const status = `icon ${icon}, clicks ${clicks}, ${await soundReport($, sound)}, chime ${onOff(chime)}, tap ${onOff(tap)}, orchestrator ${onOff(orchestrator)}, diag ${onOff(diagOn)}, motion ${motion ? 'reduced' : 'full'}, theme ${theme}, effort ${effort ? `${effort} (override)` : 'session'}`
    return { text: `Crab: ${status}. ${USAGE}` }
  })

  on('command.run', { command: 'cc' }, async $ => {
    await backToCc($)
    return { text: '' }
  })

  on('command.run', { command: 'clean' }, async $ => {
    await setClean($, !(await read($, isCleanAtom)))
    return { text: (await read($, isCleanAtom)) ? 'Clean view on.' : 'Clean view off.' }
  })

  on('command.run', { command: 'panel' }, async $ => {
    await update($, isOpenAtom, was => !was)
    return { text: (await read($, isOpenAtom)) ? 'Controls open.' : 'Controls closed.' }
  })

  // An /effort typed by hand runs as usual; the environment variable follows, otherwise the old one would win.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const ran = await next(e)
    const level = e.args.trim().toLowerCase()
    if (isLevel(level)) {
      chosenEffort = level
      await applyEffortEnv($, level)
      await update($, barEffortAtom, () => ({ key: '', value: level, options: [...LEVELS] }))
    }
    return ran
  }).catch(($, e, next) => next(e))

  // ── the settings pane ("Crab Crew"): one short section per setting, native controls

  on('ui.render', { component: 'Pane', requestId: 'crab-settings' satisfies typeof SETTINGS_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // the surface's table says whether it has a Select (mobile has none yet)
    const Select = e.surface !== 'mobile' && 'Select' in els ? els.Select : null
    const look = (await read($, lookAtom)) ?? (await storedLook($))
    const [icon, sound, reduced, theme, mapping, chime, tap, orchestrator, clean, diagOn] = await Promise.all([
      read($, effortIconAtom),
      read($, soundAtom),
      read($, reducedMotionAtom),
      read($, themePrefAtom),
      read($, mappingAtom),
      read($, chimeAtom),
      read($, tapAtom),
      read($, orchestratorAtom),
      read($, isCleanAtom),
      read($, diagAtom),
    ])
    type Section = { key: string; /** '' continues the previous section (no heading) */ title: string; label?: string; value: string; options: readonly Option<string>[]; set: (v: string) => Promise<void> }
    /** runs `set` only for a value the options hold */
    const via =
      <V extends string>(options: readonly Option<V>[], set: (v: V) => Promise<void>) =>
      async (v: string): Promise<void> => {
        const ok = pick(options, v)
        if (ok !== null) await set(ok)
      }
    const sections: Section[] = [
      { key: 'cs-icon', title: 'Ícone de effort', value: isIcon(icon) ? icon : DEFAULT_ICON, options: ICON_OPTIONS, set: via(ICON_OPTIONS, v => setIcon($, v)) },
      { key: 'cs-sound', title: 'Sons', label: 'Clique', value: sound ? 'on' : 'off', options: ON_OFF_OPTIONS, set: via(ON_OFF_OPTIONS, v => setSound($, v === 'on')) },
      { key: 'cs-chime', title: '', label: 'Concluído (≥ 2 min)', value: chime ? 'on' : 'off', options: ON_OFF_OPTIONS, set: via(ON_OFF_OPTIONS, v => setChime($, v === 'on')) },
      { key: 'cs-tap', title: '', label: 'Aprovação', value: tap ? 'on' : 'off', options: ON_OFF_OPTIONS, set: via(ON_OFF_OPTIONS, v => setTap($, v === 'on')) },
      { key: 'cs-orchestrator', title: 'Orquestrador', value: orchestrator ? 'on' : 'off', options: ON_OFF_OPTIONS, set: via(ON_OFF_OPTIONS, v => setOrchestrator($, v === 'on')) },
      { key: 'cs-clean', title: 'Chat limpo', value: clean ? 'on' : 'off', options: ON_OFF_OPTIONS, set: via(ON_OFF_OPTIONS, v => setClean($, v === 'on')) },
      { key: 'cs-motion', title: 'Movimento', value: reduced ? 'reduced' : 'full', options: MOTION_OPTIONS, set: via(MOTION_OPTIONS, v => setMotion($, v)) },
      { key: 'cs-theme', title: 'Tema', value: theme, options: THEME_OPTIONS, set: via(THEME_OPTIONS, v => setTheme($, v)) },
      { key: 'cs-clicks', title: 'Cliques no card', value: mapping === 'A' ? 'direct' : 'buttons', options: CLICK_OPTIONS, set: via(CLICK_OPTIONS, v => setClicks($, v === 'direct')) },
      { key: 'cs-diag', title: 'Diagnóstico', value: diagOn ? 'on' : 'off', options: ON_OFF_OPTIONS, set: via(ON_OFF_OPTIONS, v => setDiag($, v === 'on')) },
    ]
    const control = (s: Section) =>
      Select ? (
        <Select key={s.key} {...(s.label ? { label: s.label } : {})} options={s.options} value={s.value} onSelect={v => s.set(v)} />
      ) : (
        // no Select on this surface: a row of plain Buttons, the chosen one marked
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          {s.label ? <Text dimColor>{s.label}</Text> : null}
          {s.options.map(o =>
            o.value === s.value ? (
              <Button key={`${s.key}-${o.value}`} label={o.label} variant="secondary" onPress={() => s.set(o.value)} />
            ) : (
              <Button key={`${s.key}-${o.value}`} label={o.label} plain onPress={() => s.set(o.value)} />
            ),
          )}
        </Box>
      )
    return (
      <Box flexDirection="column" rowGap={1}>
        {sections.map(s => (
          <Box flexDirection="column">
            {s.title ? <Text bold>{s.title}</Text> : null}
            {control(s)}
          </Box>
        ))}
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          <Button
            key="cs-look"
            label={look === 'hidden' ? 'Mostrar card' : 'Ocultar card'}
            plain
            onPress={() => setLook($, look === 'hidden' ? 'bar' : 'hidden')}
          />
          <Button key="cs-crew" label="Abrir Crew" plain onPress={() => openCrew($).then(() => undefined)} />
          <Button key="cs-effort-reset" label="Repor effort da app" plain onPress={() => resetEffort($)} />
        </Box>
      </Box>
    )
  })

  // ── turns: what may still stream, the clean chat's per-turn lines, the crews' ends, the chime

  on('turn.start', async ($, e, next) => {
    // TurnStartInput carries no agentId: track turns by id, so a subagent's never pins the main one
    await update($, turnsAtom, l => [...l.filter(x => x !== e.turnId), e.turnId].slice(-16))
    try {
      // a new prompt: a new edits line, no last call yet, and a task list that already finished is cleared
      lastCall = undefined
      await update($, turnEditAtom, () => '')
      await update($, turnNowAtom, () => e.turnId)
      if (isFinished(await read($, itemsAtom))) {
        await update($, itemsAtom, () => [])
      }
    } catch {
      // the clean chat's bookkeeping never holds a turn back
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // the main loop ending ends every streaming risk for the transcript; an agent's ends its own
    await update($, turnsAtom, l => (e.agentId ? l.filter(x => x !== e.turnId) : []))
    if (e.agentId) {
      // a crew subagent's run ended (a background one has no other end); chimes at 2 min or more
      const id = e.agentId
      await finishAgent($, x => x.agentId === id, turnEndStatus(e)).catch(() => undefined)
      // its band crab sits down (✓ and the time, or ✗), then leaves; a workflow agent cut (a stalled one is
      // retried under a new id) leaves quietly instead of showing a failure
      try {
        const member = (await read($, bandCrewAtom)).find(m => m.id === id)
        if (member?.workflow === true && e.reason === 'aborted') {
          await update($, bandCrewAtom, was => was.filter(m => m.id !== id))
        } else {
          await bandCrewEnd($, m => m.id === id, e.reason === 'answer', e.durationMs).catch(() => undefined)
        }
      } catch {
        // the sweep ends it instead
      }
    } else {
      if (shouldChime(e.durationMs)) await playSound($, 'chime')
      try {
        // the turn ended: if its last call failed, that row shows one ✗ line (a failure Claude fixed stays invisible)
        const last = lastCall
        if (last?.isError === true) {
          await update($, fatalAtom, was => (was.includes(last.id) ? was : [...was, last.id]))
        }
        lastCall = undefined
        await update($, turnNowAtom, () => '')
        if ((await read($, doingAtom)) !== '') {
          await update($, doingAtom, () => '')
        }
      } catch {
        // the next turn starts clean anyway
      }
    }
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.door === 'response' && !e.agentId && e.message.type === 'assistant') {
      for (const block of e.message.content) {
        if (block.type !== 'text' || typeof block.text !== 'string') continue
        const parsed = parseNextStep(block.text)
        // bookkeeping only; the row is stored either way
        if (parsed) await noteFooter($, parsed.step).catch(() => undefined)
      }
    }
    return stored
  }).catch(($, e, next) => next(e)) // a failed bookkeeping never holds the row back (next is replay-safe)

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const mode = toMode(e.permission_mode)
    const seen = await read($, sessionModeAtom).catch(() => mode)
    if (mode !== seen) await update($, sessionModeAtom, () => mode).catch(() => undefined)
    // shift+tab or the app's pill: entering plan mode is the orchestrator's 'enter' edge
    if (mode !== null) await notePlan($, mode === 'plan').catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('config.set', async ($, e, next) => {
    const r = await next(e)
    void diag($, `config.set ${e.key}=${JSON.stringify(e.value) ?? 'undefined'} -> ${r.deny !== undefined ? `deny (${r.deny})` : `ok (${JSON.stringify(r.value) ?? 'undefined'})`}`)
    if (e.key !== 'model') return r
    // whoever set it (the card, the orchestrator, the terminal bar, the app): the model the card shows now
    if (r.deny === undefined && typeof r.value === 'string') {
      const value = r.value
      const at = await $.clock.now()
      await update($, modelSetAtom, () => ({ value, at })).catch(() => undefined)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) {
      // a crew subagent: held at its role's effort (Orquestrador on, a model that takes an effort)
      const agentId = e.agentId
      const [orchestrator, crew] = await Promise.all([read($, orchestratorAtom), read($, crewAtom)])
      const effort = orchestrator && e.effort !== undefined ? (crew.find(x => x.agentId === agentId)?.effort ?? null) : null
      void diag($, `turn.step agent=${agentId} model=${e.model} effort=${String(e.effort ?? '-')} -> effort=${String(effort ?? e.effort ?? '-')}${effort ? ' (role)' : ''}`)
      return yield* next(effort ? { ...e, effort } : e)
    }

    const seen = typeof e.effort === 'string' ? e.effort : null
    const [prevSeen, prevModel, override] = await Promise.all([read($, sessionEffortAtom), read($, sessionModelAtom), read($, effortAtom)])
    // the app's own effort moved to a value we did not set: the person chose it there, the override yields
    const yieldOverride = override !== null && seen !== null && prevSeen !== null && seen !== prevSeen && seen !== override
    if (seen !== prevSeen) await update($, sessionEffortAtom, () => seen)
    if (e.model !== prevModel) await update($, sessionModelAtom, () => e.model)
    if (yieldOverride) await update($, effortAtom, () => null)

    const chosen = yieldOverride ? null : override
    void diag(
      $,
      `turn.step main model=${e.model} effort=${String(e.effort ?? '-')} -> model=${e.model} effort=${String(chosen ?? e.effort ?? '-')}${chosen ? ' (card override)' : ''}${yieldOverride ? ' (override yielded to the app)' : ''}`,
    )
    return yield* next(chosen ? { ...e, effort: chosen } : e)
  })

  // ── the system prompt: the progress rule (the tool is registered) and the clean chat's writing rule

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    let sections: { id: string; text: string; scope?: string }[] = [...composed.sections]
    if (progressRegistered || e.tools.includes(PROGRESS_TOOL)) {
      sections = withProgressRule(sections)
    }
    if (await read($, isCleanAtom)) {
      sections = withTeachRule(sections)
    }
    return { sections: sections as typeof composed.sections }
  }).catch(($, e, next) => next(e))

  // ── Client messages: the desktop card's region (mapping A) and the terminal bar

  on('ui.message', async ($, e, next) => {
    if (e.module.endsWith('card/slider.tsx') && e.data && typeof e.data === 'object') {
      await onSliderMessage($, e.data as Msg)
      return {}
    }
    if (e.element === 'bar' && e.module.endsWith('comfort/bar.tsx')) {
      const action = e.data as Action
      $.ui.log(`crab bar: ${JSON.stringify(action)}`, { to: 'debug' })
      void diag($, `ui.message bar ${JSON.stringify(action)}`)
      switch (action.kind) {
        case 'toggle':
          await update($, isOpenAtom, was => !was)
          break
        case 'model':
          await setBarModel($, action.value)
          break
        case 'effort':
          await setBarEffort($, action.value)
          break
        case 'ultra':
          await toggleUltra($)
          break
        case 'back':
          await backToCc($)
          break
        case 'settings':
          await openSettings($)
          break
      }
      return {}
    }
    return next(e)
  })

  // the native gear beside the card (the safety net): opens the settings pane, logged
  on('ui.press', { element: 'cc-gear' }, async ($, e, next) => {
    void diag($, `press native gear (${e.component})`)
    await openSettings($).catch(() => undefined)
    return next(e)
  })

  // a Client of ours failed: the desktop card's region gives way to the compact native row, the terminal bar to plain rows
  on('ui.fault', async ($, e, next) => {
    void diag($, `ui.fault module=${e.module} element=${String(e.element)} reason=${String(e.reason)}`)
    if (e.module.endsWith('card/slider.tsx')) await update($, clientFaultAtom, () => e.reason || 'the pointer region failed').catch(() => undefined)
    if (e.element === 'bar') {
      await update($, barFailedAtom, () => true).catch(() => undefined)
      warnOnce($, 'the animated bar failed; back to the simple bar')
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ── tool calls: the task line's tools, the crews, the plan-mode edges, the clean chat's bookkeeping

  // Every tool call, in ONE unmatched hook (the engine takes one per module; `{ tool }` matchers are too deep
  // for tsc here), dispatching by tool and feature; each feature's bookkeeping is guarded on its own, so none
  // holds a call back or keeps another from running:
  // - the progress tool (this mod's own): answered here, the task line follows it;
  // - TodoWrite / TaskCreate / TaskUpdate: the same task list;
  // - Agent: the crab-crew entry (pane, pet row, chime) and the band crab (terminal bar, crab row);
  // - EnterPlanMode / approved ExitPlanMode: the orchestrator's plan edges;
  // - the clean chat: the spinner's words, each turn's edited files, the turn's last call.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const id = String(e.tool_use_id)
    const isMain = e.agentId === undefined

    if (tool === PROGRESS_TOOL) {
      const list = fromProgress(e as unknown as ProgressInput)
      try {
        await setItems($, () => list)
        if (isMain) await noteTaskRow($, id, list)
      } catch {
        // the model still hears back; the line catches up on the next call
      }
      const { done, total } = counts(list)
      return { result: `Progress shown to the user: ${done}/${total} done.` }
    }

    // before the call
    let owner: string | undefined
    try {
      if (isMain && !QUIET_TOOLS.includes(tool)) {
        const words = activity(tool, e)
        if ((await read($, doingAtom)) !== words) await update($, doingAtom, () => words)
      }
      owner = EDIT_TOOLS.includes(tool) ? await noteEdit($, id) : undefined
    } catch {
      owner = undefined
    }
    if (tool === 'TodoWrite') {
      try {
        await setItems($, () => fromTodos((e as unknown as { todos: Parameters<typeof fromTodos>[0] }).todos))
        if (isMain) await noteTaskRow($, id, await read($, itemsAtom))
      } catch {
        // the line keeps the list it had
      }
    }
    const started = tool === 'Agent' ? await $.clock.now().catch(() => 0) : 0
    if (tool === 'Agent') await agentStarted($, id, e as unknown as AgentArgs).catch(() => undefined)

    const r = await next(e)

    // after the call
    const ok = r.deny === undefined && r.isError !== true
    try {
      if (isMain) lastCall = { id, isError: !ok }
      if (owner !== undefined && ok) await addEdit($, owner, editPath(e))
    } catch {
      // the edits line misses this file
    }
    if (ok && (tool === 'TaskCreate' || tool === 'TaskUpdate')) {
      try {
        const a = e as unknown as { taskId?: string; subject?: string; activeForm?: string; status?: string }
        const created = tool === 'TaskCreate' ? (r.result as { task?: { id?: unknown } } | undefined)?.task?.id : undefined
        if (tool === 'TaskCreate' && typeof created === 'string') {
          await setItems($, list => addTask(list, created, a.subject ?? '', a.activeForm))
        } else if (tool === 'TaskUpdate') {
          await setItems($, list =>
            updateTask(list, { taskId: a.taskId ?? '', status: a.status as Parameters<typeof updateTask>[1]['status'], subject: a.subject, activeForm: a.activeForm }),
          )
        }
        if (isMain && (tool === 'TaskUpdate' || typeof created === 'string')) await noteTaskRow($, id, await read($, itemsAtom))
      } catch {
        // the line keeps the list it had
      }
    }
    if (tool === 'Agent') {
      await agentEnded($, id, r).catch(() => undefined)
      await bandAgentReturned($, id, r, started).catch(() => undefined)
    } else if ((tool === 'EnterPlanMode' || tool === 'ExitPlanMode') && isMain && toolOk(r)) {
      // the main session's plan edges: EnterPlanMode ran, or the plan was approved
      await planEdge($, tool === 'EnterPlanMode' ? 'enter' : 'exit').catch(() => undefined)
    }
    return r
  }).catch(($, e, next) => next(e)) // bookkeeping never holds a call back (next is replay-safe)

  on('agent.offer', ($, e, next) => {
    offerSources.set(e.agent.trim().toLowerCase(), e.source)
    return next(e)
  }).catch(($, e, next) => next(e))

  // a subagent starts: the orchestrator may pick its model; the crab-crew entry learns its agent; its band crab joins
  on('agent.spawn', async ($, e, next) => {
    let model: string | null = null
    try {
      if (await read($, orchestratorAtom)) {
        const crew = await read($, crewAtom)
        const role = crew.find(x => x.id === e.tool_use_id)?.role ?? roleOf(e.subagentType, e.description)
        model = routeModel(role, {
          model: e.model ?? null,
          fork: e.fork,
          workflow: e.workflow,
          isTeammate: e.isTeammate === true,
          builtIn: isBuiltInType(e.subagentType),
        })
      }
    } catch {
      model = null
    }
    // the main agent's explicit model wins: routeModel is null when the call named one
    const r = await next(model ? { ...e, model } : e)
    if (r.deny === undefined) {
      await noteSpawn($, e.tool_use_id, r.agentId, r.model, model !== null, e.fork).catch(() => undefined)
      // the band crab (an egg first when its kind is new, until it is designed); teammates have none
      if (e.isTeammate !== true) void bandCrewStart($, e, r.agentId).catch(() => undefined)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    await approvalTap($, { ...e, hook_event_name: 'PermissionRequest' }).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    await approvalTap($, { ...e, hook_event_name: 'Notification' }).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // ── a tool's row: the pet row for Agent where an Svg draws (desktop), else the clean chat

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const p = e.props
    const els = $.ui.resolve(e)
    if (p.tool === 'Agent' && e.surface !== 'terminal' && 'Svg' in els) {
      const { Box, Text, Svg } = els
      const input = (p.input && typeof p.input === 'object' ? p.input : {}) as { subagent_type?: unknown; description?: unknown; model?: unknown }
      const [crew, costumes] = await Promise.all([read($, crewAtom), read($, costumesAtom)])
      const entry = crew.find(x => x.id === p.tool_use_id)
      const type = entry?.type ?? ((typeof input.subagent_type === 'string' && input.subagent_type.trim()) || 'general-purpose')
      const description = entry?.description ?? oneLine(input.description)
      const role = entry ? entry.role : roleOf(type, description)
      const model = entry?.model || (typeof input.model === 'string' ? input.model : '') || outputModel(p.output) || ''
      const status = rowStatus(entry?.status ?? null, p)
      const { theme, reduced } = await look($)
      const now = await $.clock.now()
      const grid = role ? undefined : costumes[costumeStoreKey(type)]
      const svg = crewPetSvg({
        role,
        costumeGrid: grid === PLAIN ? undefined : grid,
        model,
        status,
        theme,
        reduced,
        idPrefix: petPrefix(p.tool_use_id),
        scale: 1,
        phaseMs: entry ? now - entry.start : 0,
      })
      const name = roleLabel(role, type)
      const alt = `${name}, ${modelLabel(model)}: ${STATUS_LABEL[status]}`
      // only a working pet breathes (SMIL needs the interactive frame); at rest it is an image
      const live = status === 'working' && !reduced
      return (
        <Box flexDirection="row" columnGap={1} alignItems="center">
          {live ? (
            <Svg key="cr-pet" source={svg} alt={alt} width={CREW_PET_BOX.w} height={CREW_PET_BOX.h} isInteractive />
          ) : (
            <Svg key="cr-pet" source={svg} alt={alt} width={CREW_PET_BOX.w} height={CREW_PET_BOX.h} />
          )}
          <Text key="cr-role" bold>
            {name}
          </Text>
          <Text key="cr-desc" dimColor wrap="truncate-end">
            {description}
          </Text>
          <Text key="cr-model">{modelLabel(model)}</Text>
          <Text key="cr-status" color={STATUS_COLOR[status]}>
            {STATUS_LABEL[status]}
          </Text>
        </Box>
      )
    }

    // The clean chat: tool rows draw nothing. What stays: the call a turn ended broken on (or one that was
    // interrupted), the turn's changed files, and one task line per turn.
    if (!(await read($, isCleanAtom)) || KEEP_TOOLS.includes(p.tool)) {
      return next(e)
    }
    const { Box, Button, Text } = els
    if (p.tool === 'Agent' || p.tool === 'Task') {
      const input = (p.input ?? {}) as { description?: unknown; subagent_type?: unknown }
      const description = typeof input.description === 'string' ? flatLine(input.description) || 'agent' : 'agent'
      const kind = typeof input.subagent_type === 'string' ? input.subagent_type : ''
      const saved = (await read($, agentCrabsAtom))[p.tool_use_id]
      const guess = matchCrab(bandCrabs, kind, description) ?? { name: 'agent', color: '#A1A1AA', accessory: '' }
      const crab = saved?.name !== undefined ? { name: saved.name, color: saved.color ?? guess.color, accessory: saved.accessory ?? '' } : guess
      // the row reads as one unit: never wider than 72 cells, so the ending stays near the task
      const width = Math.min(72, Math.max(20, (e.viewport?.columns ?? 100) - 2))
      const member = (await read($, bandCrewAtom)).find(m => m.toolUseId === p.tool_use_id)
      const working = p.isRunning || member?.status === 'running' || member?.status === 'egg'
      const failedRun = member?.status === 'failed' || (member === undefined && saved?.failed === true)
      const tookMs = member !== undefined && member.status === 'done' ? member.durationMs : member === undefined ? saved?.ms : undefined
      const secs = tookMs !== undefined ? ` ${Math.max(1, Math.round(tookMs / 1000))}s` : ''
      const tail = p.isInterrupted ? 'interrupted' : p.isErrored || failedRun ? '✗' : working ? '…' : `✓${secs}`
      // one quiet row: the role's emoji and name in its colour, the task dim, how it ended at the right edge
      const icon = crab.accessory === '' ? '◦ ' : `${crab.accessory} `
      const name = fitCells(crab.name, Math.max(4, width - cellWidth(icon) - cellWidth(tail) - 3))
      const used = cellWidth(icon) + cellWidth(name)
      const room = width - used - 3 - cellWidth(tail) - 3
      const task = room >= 6 ? ` · ${fitCells(description, room)}` : ''
      const pad = ' '.repeat(Math.max(2, width - used - cellWidth(task) - cellWidth(tail)))
      const isOff = p.isErrored || p.isInterrupted || failedRun
      return (
        <Box>
          <Text wrap="truncate">{icon}</Text>
          <Text color={isOff ? '#71717A' : crab.color} bold wrap="truncate">
            {name}
          </Text>
          <Text dimColor wrap="truncate">
            {task}
          </Text>
          <Text color={isOff ? 'error' : working ? undefined : 'success'} dimColor={working} wrap="truncate">{`${pad}${tail}`}</Text>
        </Box>
      )
    }
    const isFatal = (await read($, fatalAtom)).includes(p.tool_use_id)
    if (p.isInterrupted || (isFatal && p.isErrored)) {
      const detail = p.isInterrupted ? 'interrupted' : errorDetail(p.output)
      return (
        <Box>
          <Text color="error">✗ </Text>
          <Text>{shorten(describe(p.tool, p.input), 70)}</Text>
          {detail !== '' && <Text dimColor>{` · ${detail}`}</Text>}
        </Box>
      )
    }
    if (TASK_TOOLS.includes(p.tool)) {
      // one line per turn: only the turn's latest task call draws it, live while the turn runs, frozen after
      const id = p.tool_use_id
      const turn = (await read($, taskTurnAtom))[id]
      if (turn === undefined || (await read($, turnLastAtom))[turn] !== id) {
        return <Box />
      }
      const list = (await read($, snapsAtom))[id] ?? listFromInput(p.tool, p.input)
      if (list.length === 0) {
        return <Box />
      }
      const running = await read($, turnNowAtom)
      const state = lineState(list, running !== '' && turn === running)
      const isOpen = (await read($, openLinesAtom)).includes(id)
      const width = Math.max(30, (e.viewport?.columns ?? 100) - 2)
      const fold: Fold = (await read($, lineFoldsAtom))[id] ?? { id: '', active: '' }
      const draw = (pieces: Piece[]) =>
        pieces.map((piece, at) => (
          <Text
            key={`p${at}`}
            color={piece.tone === undefined || piece.tone === 'dim' ? undefined : TONE_COLOR[piece.tone]}
            dimColor={piece.tone === 'dim'}
            bold={piece.bold === true}
          >
            {piece.text}
          </Text>
        ))
      const [arrow, label, ...rest] = lineHead(list, state, isOpen, width)
      return (
        <Box flexDirection="column">
          <Box>
            <Button key={`tasks:${id}`} plain dimColor onPress={() => update($, openLinesAtom, was => (was.includes(id) ? was.filter(one => one !== id) : [...was, id]))}>
              {`${arrow?.text ?? ''}${label?.text ?? ''}`}
            </Button>
            {draw(rest)}
          </Box>
          {isOpen &&
            treeRows(list, fold, state, width).map((row, at) =>
              row.hasSteps ? (
                <Box key={`r${at}`}>
                  {draw(row.pieces.slice(0, 1))}
                  <Button
                    key={`task:${id}:${row.id}`}
                    plain
                    dimColor={row.pieces[1]?.tone === 'dim'}
                    onPress={() => update($, lineFoldsAtom, was => ({ ...was, [id]: toggleFold(list, was[id] ?? { id: '', active: '' }, row.id) }))}
                  >
                    {row.pieces[1]?.text ?? ''}
                  </Button>
                  {draw(row.pieces.slice(2))}
                </Box>
              ) : (
                <Box key={`r${at}`}>{draw(row.pieces)}</Box>
              ),
            )}
        </Box>
      )
    }
    if (EDIT_TOOLS.includes(p.tool)) {
      // only the turn's first edit draws the line; the others, and edits from before this session, draw nothing
      const files = (await read($, editsAtom))[p.tool_use_id]
      if (files === undefined) {
        return <Box />
      }
      const isShown = (await read($, openEditsAtom)) === p.tool_use_id && files.length > 0
      const id = p.tool_use_id
      return (
        <Box flexDirection="column">
          <Box>
            <Button key={`edits:${id}`} plain dimColor onPress={() => update($, openEditsAtom, was => (was === id ? '' : id))}>
              {`${editsLine(files)}${files.length > 0 ? (isShown ? '  ▾' : '  ▸') : ''}`}
            </Button>
          </Box>
          {isShown &&
            files.map(file => (
              <Box key={file}>
                <Text dimColor>{`    ${shortPath(file, workDir)}`}</Text>
              </Box>
            ))}
        </Box>
      )
    }
    return <Box />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded || !(await read($, isCleanAtom))) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const ended = await read($, fatalAtom)
    const bad = e.props.calls.filter(call => call.isInterrupted || (call.isErrored && call.tool_use_id !== undefined && ended.includes(call.tool_use_id)))
    if (bad.length === 0) {
      return <Box />
    }
    return (
      <Box>
        <Text color="error">✗ </Text>
        <Text>{shorten(groupLine(bad), 70)}</Text>
        <Text dimColor>{bad[0]?.isInterrupted ? ' · interrupted' : ` · ${errorDetail(bad[0]?.output)}`}</Text>
      </Box>
    )
  })

  // Results never draw in the clean chat: an error's first line is already on its ✗ row.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await read($, isCleanAtom)) || KEEP_TOOLS.includes(e.props.tool)) {
      return next(e)
    }
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // While Claude works, the spinner says what it is doing in plain words; the engine's own states win.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const words = await read($, doingAtom)
    if (words === '' || e.props.message !== null || !(await read($, isCleanAtom))) {
      return next(e)
    }
    return next({ ...e, props: { ...e.props, message: words } })
  })

  on('ui.render', { component: 'ToolProgress' }, async (_$, e, next) => next({ ...e, props: { ...e.props, hint: '' } }))

  on('ui.render', { component: 'CommandOutput', props: { command: 'rename' } }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'model' } }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // /effort's reply becomes one short line.
  on('ui.render', { component: 'CommandOutput', props: { command: 'effort' } }, async (_$, e, next) => {
    const level = e.props.args.trim().toLowerCase()
    if (!isLevel(level) || e.props.isErrored) {
      return next(e)
    }
    return next({ ...e, props: { ...e.props, text: `effort → ${level} · saved as the default` } })
  })

  // The echo of a command this mod ran itself (/model, /effort, /rename) is hidden by the sibling mod
  // comfort-silencio: the engine never shows a mod the rows that mod created, so it can't be done here.

  on('ui.render', { component: 'CommandOutput', props: { command: 'panel' } }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'task-notification' } } }, async ($, e, next) => {
    if (e.props.isExpanded || !(await read($, isCleanAtom))) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const line = shorten((e.props.text.split('\n')[0] ?? '').trim(), 80)
    return (
      <Box>
        <Text dimColor>↳ {line}</Text>
      </Box>
    )
  })

  // The usage gauges at the right end of the footer row (the plan / auto mode line), bars only.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      return next(e)
    }
    const list = await read($, usageAtom)
    const modes = e.props.modes.length > 0 ? `${e.props.modes.join(' & ')}  ` : ''
    const room = (e.viewport?.columns ?? 120) - LEFT_RESERVE - cellWidth(modes)
    const { segs, step } = footerGauges(list, room, footerStep)
    footerStep = step
    if (segs.length === 0) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        {modes !== '' && <Text dimColor>{modes}</Text>}
        {segs.map((seg, at) => (
          <Text key={`g${at}`} color={seg.color}>
            {seg.text}
          </Text>
        ))}
      </Box>
    )
  })

  // ── the Crew pane: a grid of pets with role, model and duration

  on('ui.render', { component: 'Pane', requestId: 'crab-crew' satisfies typeof CREW_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const Svg = 'Svg' in els ? els.Svg : null
    // crewTick: the durations move while someone works
    const [crew, costumes] = await Promise.all([read($, crewAtom), read($, costumesAtom), read($, crewTickAtom)])
    if (!crew.length) {
      // no subagent yet: the gallery of the 12 roles, each in its costume, with the model its role runs on by default
      const { theme } = await look($)
      const scale = 2
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text dimColor>Ainda sem subagentes nesta sessão. A tripulação:</Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={1}>
            {ROLES.map(role => {
              const model = ROUTING[role].model
              const label = modelLabel(model)
              return (
                <Box key={`gal-${role}`} flexDirection="column" alignItems="center" width={16}>
                  {Svg ? (
                    <Svg
                      key={`gal-${role}-pet`}
                      source={crewPetSvg({ role, model, status: 'done', theme, reduced: true, idPrefix: petPrefix(`gal-${role}`), scale })}
                      alt={`${role}, ${label}`}
                      width={CREW_PET_BOX.w * scale}
                      height={CREW_PET_BOX.h * scale}
                    />
                  ) : null}
                  <Text key={`gal-${role}-role`} bold wrap="truncate-end">
                    {role}
                  </Text>
                  <Text key={`gal-${role}-model`} dimColor>
                    {label}
                  </Text>
                </Box>
              )
            })}
          </Box>
        </Box>
      )
    }
    const { theme, reduced } = await look($)
    const now = await $.clock.now()
    const scale = 2
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={1}>
        {crew.map(x => {
          const grid = x.role ? undefined : costumes[costumeStoreKey(x.type)]
          const name = roleLabel(x.role, x.type)
          const live = x.status === 'working' && !reduced
          const svg = Svg
            ? crewPetSvg({
                role: x.role,
                costumeGrid: grid === PLAIN ? undefined : grid,
                model: x.model,
                status: x.status,
                theme,
                reduced,
                idPrefix: petPrefix(`pane-${x.id}`),
                scale,
                phaseMs: now - x.start,
              })
            : ''
          const alt = `${name}, ${modelLabel(x.model)}: ${STATUS_LABEL[x.status]}`
          return (
            <Box key={`cr-${x.id}`} flexDirection="column" alignItems="center" width={16}>
              {Svg ? (
                live ? (
                  <Svg key={`cr-${x.id}-pet`} source={svg} alt={alt} width={CREW_PET_BOX.w * scale} height={CREW_PET_BOX.h * scale} isInteractive />
                ) : (
                  <Svg key={`cr-${x.id}-pet`} source={svg} alt={alt} width={CREW_PET_BOX.w * scale} height={CREW_PET_BOX.h * scale} />
                )
              ) : null}
              <Text key={`cr-${x.id}-role`} bold wrap="truncate-end">
                {name}
              </Text>
              <Text key={`cr-${x.id}-model`} dimColor>
                {modelLabel(x.model)}
              </Text>
              <Text key={`cr-${x.id}-time`} color={STATUS_COLOR[x.status]}>
                {`${formatDuration(durationOf(x, now))} · ${STATUS_LABEL[x.status]}`}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })

  // ── a reply: its text, with the "Próximo passo" footer hidden (the docked card shows it)

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || e.props.isSummary) return next(e)
    const parsed = parseNextStep(e.props.text)
    if (!parsed) return next(e)
    const { step, body } = parsed
    const [turns, done] = await Promise.all([read($, turnsAtom), read($, doneAtom)])
    if (turns.length > 0 && !done.includes(fpOf(step))) return next(e) // may still be streaming

    const { Box, Markdown } = $.ui.resolve(e)
    const text = cleanBody(body)
    return <Box flexDirection="column">{text ? <Markdown text={text} /> : null}</Box>
  })

  // ── the band above the prompt: the docked card on the desktop, the comfort bar on the terminal

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.surface === 'mobile') return next(e)
    if (e.surface === 'desktop') {
      const { Box, Button, Select, Svg, Client } = $.ui.resolve(e)
      const [ctx, lookSt, drag, applying, fault, cellSt, hover] = await Promise.all([
        context($),
        read($, lookAtom),
        read($, dragAtom),
        read($, applyingAtom),
        read($, clientFaultAtom),
        read($, cellPxAtom),
        read($, petHoverAtom),
      ])
      const look = lookSt ?? (await storedLook($))
      const now = await $.clock.now()

      // the card is laid out at the band's real width (px): its columns x the cell (measured by the Client, else 8 px);
      // GEAR_COLS columns at the right edge stay for the native gear
      const cell = cellSt ?? CELL_W
      const cols = Math.max(1, e.props.bodyColumns - GEAR_COLS)
      const W = dockWidth(cols, cell)
      const view: CardView = { ...viewOf(ctx, look, drag, applying, now), width: W }
      const anim = motionFor(view, now, ctx.reduced, hover)
      const r = renderCard(view, anim, now, ctx.theme, ctx.reduced, DOCK_PREFIX)
      const hm = hitMap(view)
      drawnRail = hm.rail
      // isInteractive stays: SvgProps says only the sandboxed frame runs SMIL ("absent, an image"), and the pet's
      // plays, the pill slides and the cross-fades are SMIL. The frame cannot take the clicks: the Client is laid
      // after it in its own positioned Box (painted above it) and in flow (it has room of its own).
      const svg = <Svg key="cc-card" source={r.svg} alt={r.alt} width={r.width} height={r.height} isInteractive />
      // the safety net: one native Button outside the Svg, always clickable, whatever the Client gets. Its closure is
      // one stable no-op (the engine keys a handler by its closure: a new one per render would change the tree); the
      // ui.press hook on 'cc-gear' below opens the pane
      const gear = <Button key="cc-gear" label="⚙" plain dimColor onPress={gearPress} />

      // the diag log: the renders counted once a second, the layout once per change
      renderCount.n += 1
      if (renderCount.since < 0 || now - renderCount.since >= 1000) {
        const n = renderCount.n
        renderCount = { n: 0, since: now }
        void diag($, `ui.render AbovePrompt x${n} look=${look} band=${e.props.bodyColumns} cols`)
      }

      // Direto (default): the Svg is an absolute layer drawn FIRST, the Client region sits IN FLOW after it, sized in
      // cells (the drawing's px over the cell, rounded up), in a relative Box so it paints above the Svg's frame. An
      // absolute Box passes the pointer to its parent (BoxProps.position): the region must never be inside one.
      // The zones are in the drawing's own px; rows map at CELL_H from the top (the region is whole rows tall).
      if (ctx.mapping === 'A' && fault === null) {
        const regionCols = Math.max(1, Math.round(r.width / cell))
        const regionRows = Math.max(1, Math.ceil(r.height / CELL_H))
        const layoutLine = `card layout look=${look} svg=${r.width}x${r.height}px region=${regionCols}x${regionRows} cells cell=${cell}x${CELL_H}px band=${e.props.bodyColumns} cols`
        if (layoutLine !== lastLayoutLine) {
          lastLayoutLine = layoutLine
          void diag($, layoutLine)
        }
        const props: JsonValue = {
          level: Math.round(view.draft.effort),
          svgWidth: r.width,
          svgHeight: r.height,
          cellW: cell,
          cellH: CELL_H,
          rowPx: CELL_H,
          askRows: regionRows,
          report: true,
          slider: hm.slider,
          rail: hm.rail,
          zones: hm.zones.map(z => ({ id: z.id, x: z.x, y: z.y, w: z.w, h: z.h })),
          measure: { cols: dock?.cols ?? cols, cellPx: cell },
        }
        return (
          <Box flexDirection="row" alignItems="flex-start">
            <Box key="cc-stack" position="relative" flexDirection="column" width={regionCols} height={regionRows}>
              <Box key="cc-art" position="absolute" top={0} left={0}>
                {svg}
              </Box>
              <Box key="cc-hit" position="relative" width={regionCols} height={regionRows}>
                <Client key="cc-region" module="./card/slider.tsx" props={props} width={regionCols} height={regionRows} />
              </Box>
            </Box>
            {gear}
          </Box>
        )
      }

      // Botões, or the Client failed: one compact native row in the band, on the card's content column
      if (look === 'hidden') {
        return (
          <Box flexDirection="row">
            <Button key="cc-show" label="Mostrar crab" plain dimColor onPress={() => setLook($, 'bar')} />
            {gear}
          </Box>
        )
      }
      const px = (n: number): number => Math.round(n / cell)
      const py = (n: number): number => Math.max(1, Math.round(n / CELL_H))
      const grid = layout(W).grid
      const left = px(grid.x)
      const choices = [
        <Select
          key="cc-sel-model"
          options={FAMILIES.map((f, i) => ({ value: f, label: MODEL_NAMES[i] ?? f }))}
          value={view.draft.model}
          onSelect={v => {
            const model = FAMILIES.find(f => f === v)
            if (model) void choose($, { what: 'model', value: model })
          }}
        />,
        <Select
          key="cc-sel-effort"
          options={EFFORTS.map(w => ({ value: w, label: w }))}
          value={EFFORTS[Math.round(view.draft.effort)] ?? 'high'}
          onSelect={v => {
            const level = EFFORTS.findIndex(w => w === v)
            if (level >= 0) void choose($, { what: 'effort', value: level })
          }}
        />,
        <Select
          key="cc-sel-mode"
          options={MODES.map(m => ({ value: m, label: MODE_NAME[m] }))}
          value={view.draft.mode}
          onSelect={v => {
            const mode = MODES.find(m => m === v)
            if (mode) void choose($, { what: 'mode', value: mode })
          }}
        />,
      ]
      return (
        <Box flexDirection="column">
          {svg}
          <Box key="cc-row" flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={1} marginTop={py(2)} paddingLeft={left} width={left + px(grid.w)}>
            <Box flexDirection="row" columnGap={1}>
              {view.collapsed ? null : choices}
            </Box>
            <Box flexDirection="row" columnGap={1}>
              <Button key="cc-hide" label="Ocultar" plain dimColor onPress={() => setLook($, 'hidden')} />
              <Button key="cc-toggle" label={view.collapsed ? 'Expandir' : 'Recolher'} plain onPress={() => toggleDock($)} />
              <Button key="cc-settings" label="⚙" plain dimColor onPress={() => openSettings($)} />
            </Box>
          </Box>
        </Box>
      )
    }

    // the terminal (and any other surface with a band): the comfort bar, once this window has its identity
    const v = await readBarView($)
    if (v.id === null) return next(e)
    if (e.surface === 'terminal' && !(await read($, barFailedAtom))) {
      const { Box, Client } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Client key="bar" module="./comfort/bar.tsx" width="100%" props={barProps(v)} />
        </Box>
      )
    }
    const ui = $.ui.resolve(e)
    const { Box } = ui
    return (
      <Box flexDirection="column">
        {headerRow($, ui, v)}
        {v.isOpen && choiceRow(ui, '    model    ', 'model', MODELS, activeModel(v.model), v.flash, alias => setBarModel($, alias))}
        {v.isOpen &&
          v.effort !== null &&
          choiceRow(ui, '    effort   ', 'effort', v.effort.options, v.effort.value, v.flash, level => setBarEffort($, level))}
      </Box>
    )
  })
}
