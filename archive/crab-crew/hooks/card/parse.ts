/**
 * Footer parser for the "Próximo passo" card. Pure: no `$`, no I/O.
 *
 * Claude ends every reply with:
 *
 *   **Próximo passo**
 *   - **Tarefa**: <task text>
 *   - **Modelo**: Opus 5.5
 *   - **Effort**: high
 *   - **Modo**: auto mode        (or Plan / Auto / Ask / Edits, with or without "mode")
 *
 * `parseNextStep` recognises that footer (tolerantly) only when it is the last
 * thing in the text and every field is present and unambiguous.
 */

export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Mode = 'plan' | 'auto' | 'default' | 'acceptEdits'
export type NextStep = { task: string; model: Family; modelLabel: string; effort: Effort; mode: Mode }

/** Model families, in card order: smallest to largest. The single source of the order. */
export const FAMILIES: readonly Family[] = ['haiku', 'sonnet', 'opus', 'fable']
/** Display names and versions, keyed by family. */
export const FAMILY_NAME: Readonly<Record<Family, string>> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' }
export const FAMILY_VERSION: Readonly<Record<Family, string>> = { haiku: '5.5', sonnet: '5.5', opus: '5.5', fable: '5.1' }
/** Effort levels, slider order (index = level). */
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** Permission modes, segment order. The values are what the app's permission-mode tool takes. */
export const MODES: readonly Mode[] = ['plan', 'auto', 'default', 'acceptEdits']
/** Visible names of the modes (card pills, bar tooltip, alt, native buttons); the values above stay internal. */
export const MODE_NAME: Readonly<Record<Mode, string>> = { plan: 'Plan', auto: 'Auto', default: 'Ask', acceptEdits: 'Edits' }

/** Which family a model id or label belongs to (`claude-opus-5-5` -> `opus`); null when none or several match. */
export function familyOf(modelIdOrLabel: string | null | undefined): Family | null {
  if (!modelIdOrLabel) return null
  const s = modelIdOrLabel.toLowerCase()
  const hits = FAMILIES.filter(f => s.includes(f))
  return hits.length === 1 ? (hits[0] ?? null) : null
}

/** Slider index of an effort name, or -1. */
export function effortIndex(effort: string | null | undefined): number {
  return effort ? EFFORTS.indexOf(effort as Effort) : -1
}

type Field = 'task' | 'model' | 'effort' | 'mode'

const LABELS: Record<string, Field> = {
  tarefa: 'task',
  task: 'task',
  modelo: 'model',
  model: 'model',
  effort: 'effort',
  esforco: 'effort',
  modo: 'mode',
  mode: 'mode',
}

const HEADINGS = new Set(['proximo passo', 'proximos passos', 'next step', 'next steps'])

const EFFORT_WORDS: Record<string, Effort> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  extrahigh: 'xhigh',
  max: 'max',
  maximum: 'max',
  baixo: 'low',
  medio: 'medium',
  alto: 'high',
  maximo: 'max',
}

/** Old spellings (plan mode, default, acceptEdits, accept edits) and the visible names (Ask, Edits). */
const MODE_WORDS: Record<string, Mode> = {
  plan: 'plan',
  auto: 'auto',
  default: 'default',
  ask: 'default',
  acceptedits: 'acceptEdits',
  edits: 'acceptEdits',
}

/** Lowercase, strip accents, collapse whitespace. */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Remove markdown emphasis markers (`**`, `__`) from a line. */
function unbold(s: string): string {
  return s.replace(/\*\*|__/g, '')
}

function isHeading(line: string): boolean {
  const s = fold(unbold(line).replace(/^\s*#{1,6}\s*/, '').replace(/[:.]\s*$/, ''))
  return HEADINGS.has(s)
}

/**
 * `- **Tarefa**: x` / `* Task: x` / `1. **Modo:** plan` -> [field, raw value].
 * Emphasis is stripped around the label only; the value keeps its own `**` and
 * `__` (dunder names, `**kwargs`, `2**10`), see `unwrap`.
 */
function fieldLine(line: string): [Field, string] | null {
  const m = /^\s*(?:[-*+•]|\d+[.)])?\s*(\*\*|__)?([^:*_]+?)\s*(\*\*|__)?\s*:(.*)$/.exec(line)
  if (!m) return null
  const field = LABELS[fold(m[2] ?? '')]
  if (!field) return null
  const open = m[1]
  let rest = (m[4] ?? '').trim()
  // `**Modo:** plan`: the bold opened before the label closes after the colon
  if (open && !m[3] && rest.startsWith(open)) rest = rest.slice(open.length).trim()
  return [field, rest]
}

/** Removes one emphasis pair that wraps the whole value (`**x**`; `__x y__`), nothing inside. */
function unwrap(v: string): string {
  const b = /^\*\*(.+)\*\*$/.exec(v)
  if (b && !(b[1] ?? '').includes('**')) return (b[1] ?? '').trim()
  const u = /^__(.+)__$/.exec(v)
  if (u && /\s/.test(u[1] ?? '') && !(u[1] ?? '').includes('__')) return (u[1] ?? '').trim()
  return v
}

function plain(v: string): string {
  return unbold(v).replace(/`/g, '').trim()
}

function parseEffort(v: string): Effort | null {
  const key = fold(plain(v)).replace(/[\s_-]/g, '')
  return EFFORT_WORDS[key] ?? null
}

function parseMode(v: string): Mode | null {
  let s = fold(plain(v))
  s = s.replace(/^(?:modo|mode)\s+/, '').replace(/\s+(?:mode|modo)$/, '')
  return MODE_WORDS[s.replace(/[\s_-]/g, '')] ?? null
}

function parseModel(v: string): { model: Family; modelLabel: string } | null {
  const label = plain(v)
  const model = familyOf(label)
  return model ? { model, modelLabel: label } : null
}

export function parseNextStep(text: string): { step: NextStep; body: string } | null {
  const lines = text.split(/\r?\n/)
  let i = lines.length - 1
  while (i >= 0 && (lines[i] ?? '').trim() === '') i--

  const found: Partial<Record<Field, string>> = {}
  let count = 0
  for (; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    if (isHeading(line)) {
      // an indented (4+ spaces or tab) heading is a code block, not a footer
      if (/^(?: {4}|\t)/.test(line)) return null
      break
    }
    const f = fieldLine(line)
    if (!f) return null
    const [field, value] = f
    if (found[field] !== undefined) return null
    found[field] = value
    count++
  }
  if (i < 0 || count !== 4) return null

  const task = unwrap((found.task ?? '').trim())
  const model = parseModel(found.model ?? '')
  const effort = parseEffort(found.effort ?? '')
  const mode = parseMode(found.mode ?? '')
  if (!task || !model || !effort || !mode) return null

  // A footer inside a fenced block that is never closed is code, not a footer.
  const before = lines.slice(0, i)
  if (before.filter(l => /^\s{0,3}(?:```|~~~)/.test(l)).length % 2 === 1) return null
  // Line endings in the body are normalised to \n.
  const body = before.join('\n').trimEnd()
  return { step: { task, model: model.model, modelLabel: model.modelLabel, effort, mode }, body }
}
