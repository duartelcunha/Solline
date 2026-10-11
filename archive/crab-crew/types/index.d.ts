// The state contract of crab-crew. Self-contained (the engine requires it):
// these shapes mirror hooks/card/parse.ts (Family, Effort, Mode, NextStep),
// hooks/card/effort-icon.ts (EffortIconKind) and hooks/card/svg.ts (Mapping);
// tsc checks that the two stay assignable to each other wherever register.tsx
// stores them. The card's motion is not state: the render hook derives it.

export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Mode = 'plan' | 'auto' | 'default' | 'acceptEdits'
/** svg.ts Mapping: 'A' = Client region over the card ("Direto", default), 'B' = native buttons ("Botões"). */
export type Mapping = 'A' | 'B'
/** effort-icon.ts EffortIconKind: `/crab icon`, default pet (since 0.7.0; a stored choice is kept). */
export type EffortIconKind = 'star' | 'pet' | 'moon' | 'dumbbell' | 'wave'

export type CardStep = { task: string; model: Family; modelLabel: string; effort: Effort; mode: Mode }
/** svg.ts Control: what a person changes on the card. */
export type CardControl = 'model' | 'effort' | 'mode'

/** The docked card's look: the full card, the slim bar (default) or hidden down to a handle; remembered in $.store ('dock'). */
export type DockLook = 'expanded' | 'bar' | 'hidden'

/** The outcome of the last click sound (audio.play resolved or rejected). */
export type SoundLast = { ok: boolean; at: number; error: string | null }

/** A change in flight: since when (ms), and the value chosen (what the card shows until the session confirms or refuses it). */
export type Applying = { at: number; value: string }

/** `/crab theme`: 'auto' follows the config row 'theme'. */
export type ThemePref = 'auto' | 'light' | 'dark'

/** hooks/crew/roles.ts Role: a subagent's costume role. */
export type CrewRole =
  | 'Explorer'
  | 'Architect'
  | 'Builder'
  | 'Guide'
  | 'Designer'
  | 'Coder'
  | 'Reviewer'
  | 'Tester'
  | 'Security'
  | 'Deployer'
  | 'Researcher'
  | 'Writer'
/** hooks/crew/roles.ts CrewStatus. */
export type CrewStatus = 'working' | 'done' | 'error' | 'interrupted'

/** hooks/crew/roles.ts CrewEntry: one subagent of the session, keyed by its Agent call's tool_use_id. */
export type CrewEntry = {
  id: string
  type: string
  role: CrewRole | null
  /** what it runs on: the Agent call's model, then the one agent.spawn resolved ('' until known) */
  model: string
  description: string
  /** epoch ms */
  start: number
  status: CrewStatus
  /** epoch ms, once it stopped */
  end?: number
  /** its loop's id once started (turn.step / turn.complete carry it) */
  agentId?: string
  /** the orchestrator picked its model */
  routed?: boolean
  /** the Agent call named an effort itself */
  explicitEffort?: boolean
  /** the effort the orchestrator holds its requests at */
  effort?: Effort | null
}

/** hooks/crew/costumes.ts: a generated costume as stored (re-validated on every draw), or 'plain'. */
export type StoredCostume = { rows: string[]; colors: Record<string, string>; anchor: 'head' | 'face' | 'body' } | 'plain'

// ── The terminal comfort features (ported from the comfort mod). They mirror hooks/comfort/*:
// Item (progress.ts), the band crew Member (crabs.ts), Usage (bar.tsx).

/** This window's identity: its emoji and name (the tab title), kept in ~/.claude/comfort/windows.json. */
export type Identity = {
  sessionId: string
  emoji: string
  name: string
  since: number
}

/** One task of the task line. */
export type Item = {
  id: string
  text: string
  active: string
  status: 'pending' | 'in_progress' | 'completed'
  subtasks?: readonly { text: string; status: 'pending' | 'in_progress' | 'completed' }[]
}

/** The terminal bar's effort reading. */
export type BarEffort = {
  key: string
  value: string
  options: readonly string[]
}

/** One agent whose crab walks in the terminal bar. */
export type BandCrewMember = {
  id: string
  toolUseId: string
  label: string
  crab: { name: string; color: string; accessory: string; keywords: readonly string[]; kinds: readonly string[] } | null
  status: 'egg' | 'running' | 'done' | 'failed'
  durationMs: number
  background: boolean
  workflow: boolean
  startedAt: number
  endedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'crab-crew': {
      /** Effort chosen on a card; null leaves the session's own. */
      effort: Effort | null
      /** The session's effort as last seen on a main-thread request. */
      sessionEffort: string | null
      /** The session's permission mode as last reported (classic hooks, or a mode chosen on a card). */
      sessionMode: Mode | null
      /** The model id last seen on a main-thread request: a redraw trigger; `$.session.model()` is the truth. */
      sessionModel: string | null
      /** The model last set through config.set (any caller), and when (ms): shown for a moment while `/model` catches up. */
      modelSet: { value: string; at: number } | null
      /** The docked card's look; null until read from $.store. */
      look: DockLook | null
      /** The knob under the pointer (fractional effort 0..4) while dragging; null otherwise. */
      drag: number | null
      /** The latest reply's "Próximo passo" recommendation (the outline on the docked card); null before any. */
      rec: CardStep | null
      /** A Client of ours failed (ui.fault): the compact native row replaces the click region. The reason, or null. */
      clientFault: string | null
      /** The desktop cell width (px) as the Client region measured it over the docked Svg; null: the 8 px default. */
      cellPx: number | null
      /** Fingerprints of footers whose block has fully arrived (appended), newest last. */
      done: string[]
      /** Turns running (turn.start .. turn.complete), by turnId: footers not yet appended may still be streaming. */
      turns: string[]
      /** Model and mode changes in flight (one of each at a time): the card shows their value; null when idle. */
      applying: { model: Applying | null; mode: Applying | null }
      /** `/crab motion reduced`: OR-ed with the config row 'reduceMotion'. */
      reducedMotion: boolean
      /** `/crab theme`. */
      themePref: ThemePref
      /** The last click's outcome, reported by `/crab sound`. */
      soundLast: SoundLast | null
      /** Clicks on the card: 'A' Client region over the Svg ("Direto", default), 'B' compact native row ("Botões"). */
      mapping: Mapping
      /** Click when a change takes effect. */
      sound: boolean
      /** `/crab icon star|pet|moon|dumbbell|wave`: the effort icon. */
      effortIcon: EffortIconKind
      /** The session's subagents (Agent tool calls), oldest first. */
      crew: CrewEntry[]
      /** The Crew pane opened by itself at the session's first subagent. */
      crewOpened: boolean
      /** Bumped while a subagent works so the Crew pane's durations move; still at rest. */
      crewTick: number
      /** Generated costumes by `costume:<type>` (mirrors $.store), drawn by the row and the pane. */
      costumes: Record<string, StoredCostume>
      /** "Orquestrador": plan mode -> Fable, approved plan -> Opus, subagent model/effort by role. */
      orchestrator: boolean
      /** Whether the session is in plan mode as the orchestrator last saw it (null: not seen yet). */
      planActive: boolean | null
      /** The "Fable is not offered" toast was shown this session. */
      fableNoted: boolean
      /** Chime when a turn or subagent of 2 min or more finishes. */
      chime: boolean
      /** Gentle tap when the app needs the person's approval. */
      tap: boolean
      /** "Diagnóstico": the rolling log at ~/.claude/crab-crew/diag.log (default on). */
      diag: boolean
      /** When the pointer last came over the card's effort rail (ms): the pet plays once from then; null before any. */
      petHover: number | null

      // ── the terminal comfort features
      /** This window's emoji and name; null until session.start claims one. */
      identity: Identity | null
      /** The running task list (progress tool, TodoWrite, TaskCreate/TaskUpdate). */
      items: readonly Item[]
      /** The clean chat: tool rows hidden, one task line and one edits line per turn. */
      isClean: boolean
      /** The session's model id as the terminal bar last read it. */
      barModel: string
      /** The session's effort as the terminal bar shows it. */
      barEffort: BarEffort | null
      /** The terminal bar's picker is unfolded. */
      isOpen: boolean
      /** The choice the bar's fallback rows just confirmed (a brief ✓). */
      flash: string
      /** The animated terminal bar (a Client) failed: the plain rows draw instead. */
      barFailed: boolean
      /** The usage bar's readings (context, 5-hour, weekly, or cost). */
      usage: readonly { key: 'ctx' | '5h' | 'wk' | 'cost'; percent: number | null; reset: string; usd?: number }[]
      /** Ultracode on or off, as settings say. */
      ultra: boolean
      /** Files changed per turn, keyed by the turn's first edit (its tool_use_id). */
      edits: Readonly<Record<string, readonly string[]>>
      /** The turn whose file list is unfolded in the chat. */
      openEdits: string
      /** Each task call's list (by tool_use_id), so its row never depends on a list cleared since. */
      snaps: Readonly<Record<string, readonly Item[]>>
      /** Which turn each task call belongs to. */
      taskTurn: Readonly<Record<string, string>>
      /** Each turn's latest task call: the only row of that turn that draws the task line. */
      turnLast: Readonly<Record<string, string>>
      /** The running main turn's id; '' between turns (lines are frozen then). */
      turnNow: string
      /** Task lines the user unfolded. */
      openLines: readonly string[]
      /** Each line's own fold: which task's steps are open inside it. */
      lineFolds: Readonly<Record<string, { id: string; active: string }>>
      /** The current turn's first edit (its tool_use_id); '' until the turn edits a file. */
      turnEdit: string
      /** Every edit's turn owner (the first edit of its turn), so a reload keeps the one-line-per-turn rule. */
      editOwners: Readonly<Record<string, string>>
      /** Calls a turn ended on while they had failed: only these rows draw a ✗ line. */
      fatal: readonly string[]
      /** What Claude is doing now, in plain words, for the spinner line; '' between turns. */
      doing: string
      /** The agents at work: their crabs walk in the terminal bar until a little after they finish. */
      bandCrew: readonly BandCrewMember[]
      /** Each Agent call's crab (by tool_use_id), for its terminal row in the chat. */
      agentCrabs: Readonly<Record<string, { name?: string; color?: string; accessory?: string; ms?: number; failed?: boolean }>>
    }
  }
}
