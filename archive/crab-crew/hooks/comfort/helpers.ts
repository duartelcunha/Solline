/**
 * The terminal comfort features' pure pieces (ported from the comfort mod): the usage bar's readings, the
 * model labels, the bar's message, the system-prompt rules, the progress tool's input, the clean chat's
 * edit line. No `$` here: register.tsx makes every engine call.
 */
import type { Item } from '../../types'
import type { BarProps, Usage } from './bar'
import type { Crab } from './crabs'
import { fromTodos } from './progress'

export const PROGRESS_TOOL = 'mcp__crab-crew__progress'
export const TEACH_ID = 'crab-crew:teach'
export const PROGRESS_ID = 'crab-crew:progress'

export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const

export const isLevel = (value: string): boolean => (LEVELS as readonly string[]).includes(value)

export const activeModel = (name: string): string => MODELS.find(alias => name.toLowerCase().includes(alias)) ?? name

/** One line, no control characters: a label never breaks a row. */
export const flatLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()

/** Time left until a reset: `2h10` within a day, the weekday after that. */
export const timeLeft = (resetsAt: string | undefined, now: number): string => {
  if (resetsAt === undefined) {
    return ''
  }
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at) || at <= now) {
    return ''
  }
  const minutes = Math.round((at - now) / 60_000)
  if (minutes < 60) {
    return `${minutes}m`
  }
  if (minutes < 24 * 60) {
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
  }
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(at).getDay()] ?? ''
}

/** The bar's readings from `$.session.usage()`: rounded, so the bar only redraws when a number moves. */
export const toUsage = (
  u: { context: { percent?: number; tokens?: number; window: number }; rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]; cost?: { usd: number } },
  now: number,
): Usage[] => {
  const ctx = u.context.percent ?? (u.context.tokens !== undefined && u.context.window > 0 ? (u.context.tokens / u.context.window) * 100 : undefined)
  const out: Usage[] = [{ key: 'ctx', percent: ctx === undefined ? null : Math.round(ctx), reset: '' }]
  const five = u.rateLimits.find(one => one.kind === 'five_hour')
  const week = u.rateLimits.find(one => one.kind === 'seven_day')
  if (five === undefined && week === undefined) {
    if (u.cost !== undefined) {
      out.push({ key: 'cost', percent: null, reset: '', usd: Math.round(u.cost.usd * 100) / 100 })
    }
    return out
  }
  out.push({ key: '5h', percent: five === undefined ? null : Math.round(five.percentUsed), reset: timeLeft(five?.resetsAt, now) })
  out.push({ key: 'wk', percent: week === undefined ? null : Math.round(week.percentUsed), reset: timeLeft(week?.resetsAt, now) })
  return out
}

/** `claude-opus-5-5` → `opus 5.5`; follows whatever versions /config offers. */
export const modelLabel = (id: string, alias: string): string => {
  const match = new RegExp(`${alias}[-_ ]?(\\d+)(?:[-.](\\d+))?`, 'i').exec(id)
  return match === null ? alias : `${alias} ${match[1]}${match[2] !== undefined ? `.${match[2]}` : ''}`
}

/**
 * Versions come from the ids Claude Code reports (the session's own model id, or /config options when they
 * are ids), so they follow updates; a model with no id known yet shows its name alone.
 */
export const offeredModels = (currentId: string, options: readonly string[] | undefined): { alias: string; label: string }[] =>
  MODELS.map(alias => {
    const id = currentId.toLowerCase().includes(alias) ? currentId : (options?.find(one => one.toLowerCase().includes(alias) && /\d/.test(one)) ?? '')
    return { alias, label: modelLabel(id, alias) }
  })

/** The one useful line for the middle of the bar: a warning while it is true, otherwise a quiet fact. */
export const barMessage = (list: readonly Usage[], files: number, onBranch: string): BarProps['message'] => {
  const hot = list.filter(one => one.percent !== null && one.percent >= 80).sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0]
  if (hot !== undefined) {
    const what =
      hot.key === 'ctx'
        ? `context ${hot.percent}% · /compact soon`
        : `${hot.key === '5h' ? '5-hour' : 'weekly'} limit at ${hot.percent}%${hot.reset !== '' ? ` · resets ${hot.reset}` : ''}`
    return { text: `⚠ ${what}`, tone: 'warn' }
  }
  const facts = [onBranch !== '' ? `⎇ ${onBranch}` : '', files > 0 ? `✎ ${files} file${files === 1 ? '' : 's'} this session` : ''].filter(Boolean)
  return facts.length === 0 ? null : { text: facts.join('  ·  '), tone: 'dim' }
}

const PROGRESS_RULE = [
  `The user follows your work through one task line in the chat, drawn by the ${PROGRESS_TOOL} tool.`,
  `For every request that takes 2 or more steps, call ${PROGRESS_TOOL} before you start with the full list of tasks`,
  '(short, in English), exactly one of them in_progress. For a big request, give each task its own subtasks (2 to 6',
  'short steps); the user unfolds them in the chat. Call it again after each step with the updated statuses, sending',
  'the whole list every time, and mark everything completed when you finish. Keep it to 8 tasks at most. Skip it for',
  'one-step answers.',
].join(' ')

const TEACH_RULE = [
  'How to write to this user (clean chat): the chat hides your tool calls; the user reads only your messages,',
  'to learn about the task and the project. Write few messages, only when something meaningful happened (a finding,',
  'a decision, a finished step). Shape each as up to four short lines: "Did:" what you did; "Why:" the reason or the',
  'decision; "For the project:" what it changes or means for the project; "New term:" only when a new idea appears,',
  'explained in plain words. Do not narrate tool calls or announce what you are about to run. Flag something only if',
  "it needs the user's decision, cannot be undone, or is a real risk. Keep lines short so they fit a narrow terminal.",
  "The user's own instructions (CLAUDE.md, memory: e.g. a required closing footer, the reply language) always win over this.",
].join(' ')

/** The system prompt's sections with the teaching rule added last (session scope), once. */
export const withTeachRule = <T extends { id: string }>(sections: readonly T[]): (T | { id: string; text: string; scope: 'session' })[] =>
  sections.some(s => s.id === TEACH_ID) ? [...sections] : [...sections, { id: TEACH_ID, text: TEACH_RULE, scope: 'session' as const }]

/** The system prompt's sections with the progress rule added last (session scope, after every shared one), once. */
export const withProgressRule = <T extends { id: string }>(sections: readonly T[]): (T | { id: string; text: string; scope: 'session' })[] =>
  sections.some(s => s.id === PROGRESS_ID) ? [...sections] : [...sections, { id: PROGRESS_ID, text: PROGRESS_RULE, scope: 'session' as const }]

export type ProgressInput = {
  tasks?: { text?: unknown; active?: unknown; status?: unknown; subtasks?: { text?: unknown; status?: unknown }[] }[]
}

const STATUSES = ['pending', 'in_progress', 'completed'] as const
const toStatus = (status: unknown): Item['status'] => ((STATUSES as readonly string[]).includes(String(status)) ? (status as Item['status']) : 'pending')
const isText = (text: unknown): text is string => typeof text === 'string' && text.trim() !== ''

export const fromProgress = (input: ProgressInput): Item[] =>
  (Array.isArray(input.tasks) ? input.tasks : [])
    .filter(task => isText(task.text))
    .slice(0, 12)
    .map((task, index) => {
      const subtasks = (Array.isArray(task.subtasks) ? task.subtasks : [])
        .filter(sub => isText(sub.text))
        .slice(0, 12)
        .map(sub => ({ text: String(sub.text), status: toStatus(sub.status) }))
      return {
        id: `p${index}`,
        text: String(task.text),
        active: isText(task.active) ? task.active : String(task.text),
        status: toStatus(task.status),
        ...(subtasks.length > 0 ? { subtasks } : {}),
      }
    })

/** The list a task row shows when nothing was recorded for it (a chat from before this session). */
export const listFromInput = (tool: string, input: unknown): Item[] => {
  const data = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  if (tool === PROGRESS_TOOL) {
    return fromProgress(data as ProgressInput)
  }
  if (tool === 'TodoWrite' && Array.isArray(data.todos)) {
    return fromTodos(data.todos as Parameters<typeof fromTodos>[0])
  }
  return []
}

export const editPath = (input: unknown): string => {
  const data = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const path = data.file_path ?? data.notebook_path
  return typeof path === 'string' ? path : ''
}

/** A path as the user reads it: relative to the session's folder when it is inside it. */
export const shortPath = (path: string, root: string): string => {
  const norm = (text: string) => text.replace(/\\/g, '/')
  const p = norm(path)
  const r = norm(root).replace(/\/+$/, '')
  return r !== '' && p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : p
}

const baseName = (path: string): string => path.split(/[\\/]+/).filter(Boolean).pop() ?? path

/** `✎ 3 files changed · bar.tsx, register.tsx +1` */
export const editsLine = (files: readonly string[]): string => {
  if (files.length === 0) {
    return '✎ changing files…'
  }
  const names = files.map(baseName)
  const shown = names.slice(0, 2).join(', ')
  const more = names.length > 2 ? ` +${names.length - 2}` : ''
  return `✎ ${files.length} file${files.length === 1 ? '' : 's'} changed · ${shown}${more}`
}

/** A crab as stored, checked field by field (anything else is dropped). */
export const saneCrab = (c: unknown): Crab | undefined => {
  const o = c as Partial<Crab> | null
  if (o === null || typeof o !== 'object' || typeof o.name !== 'string' || typeof o.color !== 'string' || typeof o.accessory !== 'string') {
    return undefined
  }
  return {
    name: o.name,
    color: o.color,
    accessory: o.accessory,
    keywords: Array.isArray(o.keywords) ? o.keywords.filter((k): k is string => typeof k === 'string') : [],
    kinds: Array.isArray(o.kinds) ? o.kinds.filter((k): k is string => typeof k === 'string') : [],
  }
}

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'what', 'look', 'about', 'make', 'some', 'then', 'them', 'they', 'your', 'have', 'does'])

/** Words of a task worth remembering for a crab: 4 letters or more, no stopwords. */
export const taskWords = (description: string): string[] =>
  description
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(' ')
    .filter(w => w.length >= 4 && !STOPWORDS.has(w))
