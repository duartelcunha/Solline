/**
 * The crew's pure decisions (no `$`, no I/O); register.tsx makes the calls.
 *
 * - Plan-mode model switch (decision 5): entering plan mode -> Fable (Opus when
 *   the config row 'model' does not offer Fable), an approved ExitPlanMode ->
 *   Opus. Only at those transitions; the person's choices in between stand.
 * - Crew status: from the Agent tool's result, a subagent's turn.complete and
 *   the ToolUse row's props.
 * - Labels for the inline row and the Crew pane.
 */
import { FAMILY_NAME, familyOf, type Family } from '../card/parse'
import type { CrewStatus, Role } from './roles'

export const CREW_PANE = 'crab-crew'
export const CREW_TITLE = 'Crew'
/** The Crew pane's durations move this often while a subagent works (nothing ticks at rest). */
export const CREW_TICK_MS = 5000
/** Entries kept in the session's crew list (oldest dropped). */
export const CREW_MAX = 48

/* ================= plan mode -> model ================= */

export type PlanEdge = 'enter' | 'exit'
export type PlanTarget = { model: Family; fallback: boolean }

/** Whether the config row 'model' offers Fable; true when the row lists no options (unknown: try it). */
export function offersFable(options: readonly string[] | null | undefined): boolean {
  if (!options || options.length === 0) return true
  return options.some(o => typeof o === 'string' && familyOf(o) === 'fable')
}

/**
 * The model a plan-mode edge switches to: Fable on entering (Opus, `fallback`,
 * when the row does not offer Fable), Opus on an approved exit.
 */
export function planTarget(edge: PlanEdge, options: readonly string[] | null | undefined): PlanTarget {
  if (edge === 'exit') return { model: 'opus', fallback: false }
  return offersFable(options) ? { model: 'fable', fallback: false } : { model: 'opus', fallback: true }
}

/**
 * Whether the plan state moved into plan: `prev` is what was last seen (null:
 * nothing yet), `now` whether the session is in plan mode now.
 */
export const entersPlan = (prev: boolean | null, now: boolean): boolean => now && prev !== true

/** The quiet toast of a switch: "Fable → Opus" (the target alone when the old model is unknown). */
export function switchToast(from: Family | null, to: Family): string {
  return from && from !== to ? `${FAMILY_NAME[from]} → ${FAMILY_NAME[to]}` : `→ ${FAMILY_NAME[to]}`
}

export const FABLE_MISSING_TOAST = 'Crab: Fable não está disponível aqui; o Orquestrador usa Opus no plan mode.'

/* ================= crew status ================= */

const INTERRUPT_RE = /interrupt|abort|cancel/i

/**
 * What an Agent tool call's result says of its subagent: null while it still
 * runs (launched in the background: its own turn.complete ends it), else the
 * status it ended with.
 */
export function agentCallStatus(r: unknown): CrewStatus | null {
  if (!r || typeof r !== 'object') return 'error'
  const o = r as { deny?: unknown; isError?: unknown; text?: unknown; result?: unknown }
  if (typeof o.deny === 'string') return 'error'
  if (o.isError === true) return typeof o.text === 'string' && INTERRUPT_RE.test(o.text) ? 'interrupted' : 'error'
  const status = o.result && typeof o.result === 'object' ? (o.result as { status?: unknown }).status : undefined
  if (status === 'async_launched') return null
  return 'done'
}

/** The model an Agent result names (`resolvedModel`), if any. */
export function agentResultModel(r: unknown): string | null {
  const res = r && typeof r === 'object' ? (r as { result?: unknown }).result : undefined
  const m = res && typeof res === 'object' ? (res as { resolvedModel?: unknown }).resolvedModel : undefined
  return typeof m === 'string' && m.trim() ? m : null
}

/** The model a stored Agent output names (`resolvedModel`, the ToolUse row's `output`), if any. */
export function outputModel(output: unknown): string | null {
  const m = output && typeof output === 'object' ? (output as { resolvedModel?: unknown }).resolvedModel : undefined
  return typeof m === 'string' && m.trim() ? m : null
}

/** Whether a tool call's result says it went through: no deny, no error (an approved ExitPlanMode, an EnterPlanMode that ran). */
export function toolOk(r: unknown): boolean {
  if (!r || typeof r !== 'object') return false
  const o = r as { deny?: unknown; isError?: unknown }
  return typeof o.deny !== 'string' && o.isError !== true
}

/** How a subagent's run ended, from its turn.complete. */
export function turnEndStatus(e: { isAborted?: boolean; reason?: string }): CrewStatus {
  if (e.isAborted || e.reason === 'aborted') return 'interrupted'
  if (e.reason === 'error' || e.reason === 'refusal') return 'error'
  return 'done'
}

/**
 * The status the ToolUse row shows: the row's own interrupt / error first, then
 * what the crew recorded (a background agent's row is no longer running while
 * the agent works), else the row's running flag.
 */
export function rowStatus(recorded: CrewStatus | null | undefined, p: { isRunning: boolean; isErrored: boolean; isInterrupted: boolean }): CrewStatus {
  if (p.isInterrupted) return 'interrupted'
  if (p.isErrored) return 'error'
  if (recorded) return recorded
  return p.isRunning ? 'working' : 'done'
}

/* ================= labels ================= */

export const STATUS_LABEL: Readonly<Record<CrewStatus, string>> = {
  working: 'a trabalhar',
  done: 'feito',
  error: 'erro',
  interrupted: 'interrompido',
}

/** Theme keys for the status word. */
export const STATUS_COLOR: Readonly<Record<CrewStatus, 'claude' | 'success' | 'error' | 'inactive'>> = {
  working: 'claude',
  done: 'success',
  error: 'error',
  interrupted: 'inactive',
}

/** "Opus", "Haiku", ... for an alias or id; a short raw string otherwise; '…' when not known yet. */
export function modelLabel(model: string | null | undefined): string {
  const f = familyOf(model)
  if (f) return FAMILY_NAME[f]
  const m = (model ?? '').trim()
  if (!m) return '…'
  return m.length > 18 ? `${m.slice(0, 17)}…` : m
}

/** The role's name, or the subagent type for an unknown role (capped). */
export function roleLabel(role: Role | null, type: string): string {
  if (role) return role
  const t = type.trim() || 'agent'
  return t.length > 24 ? `${t.slice(0, 23)}…` : t
}

/** One line, capped: an Agent's description as the row shows it. */
export function oneLine(s: unknown, max = 80): string {
  const t = typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : ''
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Short stable id prefix per row or pane cell, so pets never share SVG ids. */
export function petPrefix(id: string): string {
  let h = 5381
  for (let i = 0; i < id.length; i++) h = ((h * 33) ^ id.charCodeAt(i)) >>> 0
  return `p${h.toString(36)}`
}
