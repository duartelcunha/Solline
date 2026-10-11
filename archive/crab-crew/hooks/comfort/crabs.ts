// Agent crabs: one little crab per kind of task an agent does, designed once (by Haiku) and reused after.
// Pure pieces only: designs, matching a task to a crab, the sprite, the design prompt and its answer.

/** A crab's look and what it is for. */
export type Crab = {
  name: string
  color: string
  accessory: string
  /** Words that send a task to this crab without asking Haiku again. */
  keywords: readonly string[]
  /** Agent types (`Explore`, a plugin's agent) this crab stands for. */
  kinds: readonly string[]
}

/** One agent the crew row shows. */
export type Member = {
  id: string
  toolUseId: string
  label: string
  crab: Crab | null
  status: 'egg' | 'running' | 'done' | 'failed'
  durationMs: number
  /** Runs in the background: its Agent call returns at once, its own run's end is what counts. */
  background: boolean
  /** Started by a workflow script (its call is the Workflow's, shared by the run's agents). */
  workflow: boolean
  /** When it started and ended, on the host's clock (0 until it ends). */
  startedAt: number
  endedAt: number
}

/** The colours a crab may wear: bright enough on a dark terminal, none of them the band's own reds. */
export const CRAB_COLORS: readonly string[] = [
  '#F97316', '#38BDF8', '#A3E635', '#F472B6', '#FACC15', '#2DD4BF', '#C084FC', '#FB7185', '#60A5FA', '#34D399', '#FDBA74', '#E879F9',
]

/** Accessories: emoji drawn 2 cells wide on every terminal (emoji presentation by default, outside the basic plane). */
export const ACCESSORIES: readonly string[] = [
  '🔎', '📐', '🔧', '🔬', '🧪', '📜', '📚', '🐞', '🧭', '🎯', '🧹', '🧩', '📦', '🧠', '🎨', '🚀', '🧰', '💡', '🔭', '🎒',
]

/** The crew a fresh session starts with: the usual kinds of task, so most agents need no design call. */
export const SEED_CRABS: readonly Crab[] = [
  { name: 'scout', color: '#38BDF8', accessory: '🔎', keywords: ['explore', 'search', 'find', 'locate', 'look for', 'where', 'scan', 'sweep'], kinds: ['explore'] },
  { name: 'planner', color: '#C084FC', accessory: '📐', keywords: ['plan', 'design', 'architect', 'approach', 'strategy', 'propose'], kinds: ['plan'] },
  { name: 'builder', color: '#F97316', accessory: '🔧', keywords: ['implement', 'build', 'create', 'write code', 'refactor', 'migrate'], kinds: [] },
  { name: 'reviewer', color: '#34D399', accessory: '🔬', keywords: ['review', 'audit', 'verify', 'check', 'refute', 'inspect', 'critique'], kinds: ['code-reviewer'] },
  { name: 'tester', color: '#A3E635', accessory: '🧪', keywords: ['test', 'tests', 'testing', 'qa', 'e2e', 'reproduce', 'repro'], kinds: [] },
  { name: 'scribe', color: '#FDBA74', accessory: '📜', keywords: ['doc', 'docs', 'documentation', 'readme', 'summar*', 'write up', 'notes', 'changelog'], kinds: [] },
  { name: 'researcher', color: '#60A5FA', accessory: '📚', keywords: ['research', 'investigate', 'learn', 'compare', 'evaluate', 'web'], kinds: [] },
  { name: 'fixer', color: '#FB7185', accessory: '🐞', keywords: ['fix', 'bug', 'bugs', 'debug', 'diagnose', 'crash', 'error'], kinds: [] },
]

export const MAX_CRABS = 24

const norm = (text: string): string => text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

/** Agent types that say nothing about the task (the description decides then). */
const GENERIC_KINDS = new Set(['general-purpose', 'general', 'fork', 'teammate', 'claude', 'agent', ''].map(norm))

/**
 * The crab for a task, without asking anyone: the one standing for its agent type, else the first whose
 * keyword the description holds (whole words at the start), else undefined (a new kind: design one).
 */
export function matchCrab(crabs: readonly Crab[], subagentType: string, description: string): Crab | undefined {
  const kind = norm(subagentType)
  if (!GENERIC_KINDS.has(kind)) {
    const byKind = crabs.find(c => c.kinds.map(norm).includes(kind))
    if (byKind !== undefined) {
      return byKind
    }
  }
  const words = ` ${norm(description)} `
  let best: { crab: Crab; at: number } | undefined
  for (const crab of crabs) {
    for (const key of crab.keywords) {
      // whole words ("doc" never matches "dockerize"); a keyword ending in * is a stem ("summar*")
      const at = key.endsWith('*') ? words.indexOf(` ${norm(key.slice(0, -1))}`) : words.indexOf(` ${norm(key)} `)
      if (at >= 0 && (best === undefined || at < best.at)) {
        best = { crab, at }
      }
    }
  }
  return best?.crab
}

/** A stable design from a name alone (no model, or the model failed): the same name always looks the same. */
export function hashCrab(name: string, kind: string, keywords: readonly string[]): Crab {
  let h = 2166136261
  for (const ch of name) {
    h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0
  }
  return {
    name: name.slice(0, 12) || 'crab',
    color: CRAB_COLORS[h % CRAB_COLORS.length]!,
    accessory: ACCESSORIES[(h >>> 8) % ACCESSORIES.length]!,
    keywords: keywords.slice(0, 6),
    kinds: GENERIC_KINDS.has(norm(kind)) ? [] : [norm(kind)],
  }
}

/** The one tiny request that designs a crab (or picks an existing one for this task). */
export function designPrompt(crabs: readonly Crab[], subagentType: string, description: string): { system: string; prompt: string } {
  const crew = crabs.map(c => `- ${c.name}: ${c.keywords.slice(0, 6).join(', ')}`).join('\n')
  return {
    system:
      'You name little crab mascots for the kinds of task an AI coding agent does. Answer with one JSON object and nothing else.',
    prompt: [
      `Task the agent got: "${description.slice(0, 200)}" (agent type: ${subagentType || 'general-purpose'}).`,
      '',
      'Existing crabs and what they do:',
      crew || '(none)',
      '',
      'If one existing crab clearly fits this kind of task, answer {"reuse":"<its name>"}.',
      'Otherwise design a new crab for this KIND of task (not this exact task), answering',
      `{"name":"<one lowercase word, a role like scout or tester, max 12 letters>","color":"<one of ${CRAB_COLORS.join(' ')}>","accessory":"<one of ${ACCESSORIES.join(' ')}>","keywords":["<3 to 6 lowercase words a future task of this kind would contain>"]}`,
    ].join('\n'),
  }
}

/** Reads the model's answer: a crab to reuse, a new valid design, or undefined (then the hash design). */
export function parseDesign(text: string, crabs: readonly Crab[], subagentType: string): { reuse: Crab } | { crab: Crab } | undefined {
  const at = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (at < 0 || end <= at) {
    return undefined
  }
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text.slice(at, end + 1)) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (typeof data.reuse === 'string') {
    const hit = crabs.find(c => c.name === data.reuse)
    return hit === undefined ? undefined : { reuse: hit }
  }
  const name = typeof data.name === 'string' ? norm(data.name).replace(/ /g, '').slice(0, 12) : ''
  const color = typeof data.color === 'string' ? data.color.toUpperCase() : ''
  const accessory = typeof data.accessory === 'string' ? data.accessory : ''
  const keywords = Array.isArray(data.keywords) ? data.keywords.filter((k): k is string => typeof k === 'string').map(norm).filter(k => k !== '').slice(0, 6) : []
  if (name === '') {
    return undefined
  }
  const taken = crabs.find(c => c.name === name)
  if (taken !== undefined) {
    return { reuse: taken }   // it named one we have: that crab, not a duplicate
  }
  return {
    crab: {
      name,
      color: CRAB_COLORS.includes(color) ? color : hashCrab(name, subagentType, keywords).color,
      accessory: ACCESSORIES.includes(accessory) ? accessory : hashCrab(name, subagentType, keywords).accessory,
      keywords,
      kinds: GENERIC_KINDS.has(norm(subagentType)) ? [] : [norm(subagentType)],
    },
  }
}

/** Adds a crab to the crew (never past MAX_CRABS: the oldest designed one makes room; seeds stay). */
export function addCrab(crabs: readonly Crab[], crab: Crab): Crab[] {
  const next = [...crabs.filter(c => c.name !== crab.name), crab]
  while (next.length > MAX_CRABS) {
    const at = next.findIndex(c => !SEED_CRABS.some(s => s.name === c.name))
    next.splice(at < 0 ? 0 : at, 1)
  }
  return next
}
