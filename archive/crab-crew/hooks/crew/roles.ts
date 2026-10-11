/**
 * Subagent roles, routing and crew-state reducers. Pure: no `$`, no I/O.
 *
 * - `roleOf` maps an Agent tool call (subagent_type + description) to a costume role.
 * - `ROUTING` / `routeModel` / `subagentEffort` give the orchestrator's per-role model
 *   alias and effort. Aliases only, never fixed model ids. Only built-in agent
 *   types are routed; forks, workflow agents and teammates never are.
 * - `addEntry` / `setStatus` / `durationOf` / `formatDuration` keep the Crew pane's
 *   list of subagents as immutable data.
 */

import type { Effort, Family } from '../card/parse'

export type Role =
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

/** All roles, in a stable display order. */
export const ROLES: readonly Role[] = [
  'Explorer', 'Architect', 'Builder', 'Guide', 'Designer', 'Coder',
  'Reviewer', 'Tester', 'Security', 'Deployer', 'Researcher', 'Writer',
]

/** Exact subagent_type -> role (compared case-insensitively, trimmed); the built-in agent types. */
export const ROLE_BY_TYPE: Readonly<Record<string, Role>> = {
  'explore': 'Explorer',
  'plan': 'Architect',
  'general-purpose': 'Builder',
  'claude': 'Builder',
  'claude-code-guide': 'Guide',
}

/**
 * Keyword -> role, first match wins; checked in the type, then in the description.
 * Each pattern is anchored and tested against whole tokens (camelCase and any
 * non-alphanumeric split), so 'latest', 'docker', 'decoder' or 'contest' match
 * nothing. `secur` comes before `review` so a security reviewer is Security.
 */
export const ROLE_KEYWORDS: readonly (readonly [RegExp, Role])[] = [
  [/^design/, 'Designer'],
  [/^secur/, 'Security'],
  [/^review/, 'Reviewer'],
  [/^(test|tests|tester|testers|testing)$/, 'Tester'],
  [/^deploy/, 'Deployer'],
  [/^research/, 'Researcher'],
  [/^(doc|docs|documentation|documenter|write|writer|writes|writing|written)$/, 'Writer'],
  [/^(code|coder|coding|implement|implements|implementer|implementation|implementing)$/, 'Coder'],
]

/** Lowercase whole-word tokens: camelCase split, then any run of non [a-z0-9]. */
export function tokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function keywordRole(text: string): Role | null {
  const toks = tokens(text)
  if (!toks.length) return null
  for (const [re, role] of ROLE_KEYWORDS) if (toks.some(t => re.test(t))) return role
  return null
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** The exact-map role of a type (own keys only: 'constructor' or '__proto__' are no role). */
export function exactRole(subagentType: string | null | undefined): Role | null {
  const type = (subagentType ?? '').trim().toLowerCase()
  return type && hasOwn(ROLE_BY_TYPE, type) ? (ROLE_BY_TYPE[type] ?? null) : null
}

/**
 * The costume role of a subagent: exact type map first, then keywords in the type,
 * then keywords in the description. Null when nothing matches (unknown role).
 *
 * Callers pass the resolved type: an Agent call without `subagent_type` runs
 * `general-purpose`, so they pass that (Builder), not an empty string.
 */
export function roleOf(subagentType: string | null | undefined, description?: string | null): Role | null {
  return exactRole(subagentType) ?? keywordRole((subagentType ?? '').trim()) ?? keywordRole((description ?? '').trim())
}

export type RoleModel = Exclude<Family, 'fable'>
export type Route = { readonly model: RoleModel; readonly effort: Effort }

const HAIKU: Route = { model: 'haiku', effort: 'low' }
const SONNET: Route = { model: 'sonnet', effort: 'medium' }
const OPUS: Route = { model: 'opus', effort: 'high' }

/** Orchestrator routing: role -> model alias and effort. */
export const ROUTING: Readonly<Record<Role, Route>> = {
  Explorer: HAIKU,
  Researcher: HAIKU,
  Guide: HAIKU,
  Tester: HAIKU,
  Builder: SONNET,
  Coder: SONNET,
  Designer: SONNET,
  Writer: SONNET,
  Deployer: SONNET,
  Architect: OPUS,
  Reviewer: OPUS,
  Security: OPUS,
}

/**
 * The facts of one spawn (agent.spawn's input) that decide whether the
 * orchestrator may pick its model.
 */
export type SpawnFacts = {
  /** The Agent tool's `model` as given; any non-blank value (an alias, an id, 'inherit') is the caller's choice. */
  readonly model?: string | null
  /** A fork always inherits the parent's model. */
  readonly fork?: boolean
  /** A workflow agent's content cannot be rewritten. */
  readonly workflow?: unknown
  /** A teammate is a long-lived member of the team: left alone. */
  readonly isTeammate?: boolean
  /**
   * True only for a built-in agent type (no frontmatter that may pin a model).
   * A plugin's or a user's agent definition may carry its own `model:`, which
   * an empty `model` lets decide, so those are never routed.
   */
  readonly builtIn?: boolean
}

/**
 * The model alias to set on a spawning subagent, or null to leave it untouched:
 * null when the main agent already chose a model (non-blank, the explicit choice
 * wins), for a fork, a workflow agent, a teammate, any agent that is not a
 * built-in type (its definition may pin a model), and for an unknown role.
 */
export function routeModel(role: Role | null | undefined, spawn: SpawnFacts): RoleModel | null {
  if (spawn.model && spawn.model.trim()) return null
  if (spawn.fork || spawn.workflow || spawn.isTeammate || spawn.builtIn !== true) return null
  if (!role) return null
  return ROUTING[role]?.model ?? null
}

/** The effort for a subagent of this role, or null for an unknown role. */
export function effortForRole(role: Role | null | undefined): Effort | null {
  if (!role) return null
  return ROUTING[role]?.effort ?? null
}

const EFFORT_BY_FAMILY: Readonly<Record<Family, Effort>> = { haiku: 'low', sonnet: 'medium', opus: 'high', fable: 'high' }

/**
 * The effort a crew subagent runs at, from the model it actually runs on
 * (haiku low, sonnet medium, opus/fable high): a routed agent gets its role's
 * effort, and an agent the main agent put on opus is not held at its role's
 * `low`. Null when the role is unknown, the model is unknown, or the caller
 * asked for an effort itself (`explicitEffort`).
 */
export function subagentEffort(role: Role | null | undefined, family: Family | null, explicitEffort = false): Effort | null {
  if (!role || explicitEffort || !family) return null
  return EFFORT_BY_FAMILY[family] ?? null
}

// ---------------------------------------------------------------------------
// Crew state

export type CrewStatus = 'working' | 'done' | 'error' | 'interrupted'

export type CrewEntry = {
  readonly id: string
  readonly type: string
  readonly role: Role | null
  readonly model: string
  readonly description: string
  /** Epoch ms when the subagent started. */
  readonly start: number
  readonly status: CrewStatus
  /** Epoch ms when it stopped (done / error / interrupted); absent while working. */
  readonly end?: number
  /** The subagent's loop id once agent.spawn started it (its turn.step / turn.complete carry it). */
  readonly agentId?: string
  /** The orchestrator picked its model at spawn. */
  readonly routed?: boolean
  /** The Agent call named an effort itself: the orchestrator leaves it. */
  readonly explicitEffort?: boolean
  /** The effort the orchestrator holds this subagent's requests at; null/absent leaves them. */
  readonly effort?: Effort | null
}

/** Appends an entry; an entry with the same id is replaced in place (no duplicates). */
export function addEntry(entries: readonly CrewEntry[], entry: CrewEntry): CrewEntry[] {
  const i = entries.findIndex(e => e.id === entry.id)
  if (i < 0) return [...entries, entry]
  const next = entries.slice()
  next[i] = entry
  return next
}

/**
 * Sets an entry's status. Leaving 'working' stamps `end = now` (kept if already set);
 * going back to 'working' clears it. Unknown id or unchanged status returns the same array.
 */
export function setStatus(entries: readonly CrewEntry[], id: string, status: CrewStatus, now: number): readonly CrewEntry[] {
  const i = entries.findIndex(e => e.id === id)
  const cur = i < 0 ? undefined : entries[i]
  if (!cur || cur.status === status) return entries
  const { end: _end, ...rest } = cur
  const updated: CrewEntry = status === 'working' ? { ...rest, status } : { ...rest, status, end: cur.end ?? now }
  const next = entries.slice()
  next[i] = updated
  return next
}

/** Merges `patch` into the entry with this id; an unknown id returns the same array. */
export function patchEntry(entries: readonly CrewEntry[], id: string, patch: Partial<Omit<CrewEntry, 'id'>>): readonly CrewEntry[] {
  const i = entries.findIndex(e => e.id === id)
  const cur = i < 0 ? undefined : entries[i]
  if (!cur) return entries
  const next = entries.slice()
  next[i] = { ...cur, ...patch }
  return next
}

/** Elapsed ms for an entry: to `end` when stopped, to `now` while working; never negative. */
export function durationOf(entry: CrewEntry, now: number): number {
  return Math.max(0, (entry.end ?? now) - entry.start)
}

/** Compact duration: `0s`, `42s`, `3m 05s`, `1h 02m`. Non-finite or negative -> `0s`. */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (h > 0) return `${h}h ${pad(m)}m`
  if (m > 0) return `${m}m ${pad(s)}s`
  return `${s}s`
}
