export type Status = 'pending' | 'in_progress' | 'completed'

/** A step inside a task (one level only). */
export type Sub = { text: string; status: Status }

export type Item = {
  id: string
  text: string
  active: string
  status: Status
  subtasks?: readonly Sub[]
}

export type Row = {
  kind: 'done' | 'active' | 'todo' | 'more'
  mark: string
  text: string
}

export const MAX_ROWS = 5

export const fromTodos = (
  todos: readonly { content: string; status: Status; activeForm?: string }[],
): Item[] =>
  todos.map((todo, index) => ({
    id: `t${index}`,
    text: todo.content,
    active: todo.activeForm ?? todo.content,
    status: todo.status,
  }))

export const addTask = (
  items: readonly Item[],
  id: string,
  subject: string,
  activeForm?: string,
): Item[] => [
  ...items.filter(item => item.id !== id),
  { id, text: subject, active: activeForm ?? subject, status: 'pending' },
]

export const updateTask = (
  items: readonly Item[],
  patch: {
    taskId: string
    status?: Status | 'deleted'
    subject?: string
    activeForm?: string
  },
): Item[] =>
  patch.status === 'deleted'
    ? items.filter(item => item.id !== patch.taskId)
    : items.map(item =>
        item.id === patch.taskId
          ? {
              ...item,
              status: patch.status === undefined || patch.status === 'deleted' ? item.status : patch.status,
              text: patch.subject ?? item.text,
              active: patch.activeForm ?? patch.subject ?? item.active,
            }
          : item,
      )

export const counts = (items: readonly Item[]): { done: number; total: number } => ({
  done: items.filter(item => item.status === 'completed').length,
  total: items.length,
})

export const isFinished = (items: readonly Item[]): boolean => {
  const { done, total } = counts(items)
  return total > 0 && done === total
}

export const hasActive = (items: readonly Item[]): boolean =>
  items.some(item => item.status === 'in_progress')

/** The task in progress, or the next pending one when none is in progress. */
export const current = (items: readonly Item[]): Item | undefined =>
  items.find(item => item.status === 'in_progress') ??
  items.find(item => item.status === 'pending')

/** 7-cell bar; only full when everything is done. */
export const bar = (done: number, total: number, width = 7): string => {
  const filled =
    total === 0
      ? 0
      : done >= total
        ? width
        : Math.min(width - 1, Math.floor((done / total) * width))
  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
}

const toRow = (item: Item): Row =>
  item.status === 'completed'
    ? { kind: 'done', mark: '✓', text: item.text }
    : item.status === 'in_progress'
      ? { kind: 'active', mark: '●', text: item.active }
      : { kind: 'todo', mark: '○', text: item.text }

/** Up to `max` rows: done ones collapse into "N done" and whatever does not fit into "+N". */
export const rows = (items: readonly Item[], max = MAX_ROWS): Row[] => {
  const all = items.map(toRow)
  if (all.length <= max) {
    return all
  }
  const done = all.filter(row => row.kind === 'done')
  const rest = all.filter(row => row.kind !== 'done')
  const head: Row[] =
    done.length > 0 ? [{ kind: 'more', mark: '✓', text: `${done.length} done` }] : []
  const room = max - head.length
  if (rest.length <= room) {
    return [...head, ...rest]
  }
  const shown = rest.slice(0, Math.max(0, room - 1))
  return [...head, ...shown, { kind: 'more', mark: '·', text: `+${rest.length - shown.length}` }]
}

/** Which task is unfolded: the user's pick, made while `active` was the task in progress. */
export type Fold = { id: string; active: string }

const activeId = (list: readonly Item[]): string => list.find(item => item.status === 'in_progress')?.id ?? ''

/** The unfolded task: the user's pick while the same task is in progress, otherwise the active one. */
export const openId = (list: readonly Item[], fold: Fold): string =>
  fold.active === activeId(list) ? fold.id : activeId(list)

/** A click on a task: unfolds it, or folds it when it is the open one. */
export const toggleFold = (list: readonly Item[], fold: Fold, id: string): Fold => ({
  id: openId(list, fold) === id ? '' : id,
  active: activeId(list),
})

export type SubRow = { kind: 'done' | 'active' | 'todo' | 'more'; mark: string; text: string }

export type TaskView = {
  id: string
  kind: 'done' | 'active' | 'todo' | 'more'
  text: string
  /** Subtasks done and in all (0 when it has none). */
  done: number
  total: number
  isOpen: boolean
  subs: SubRow[]
}

export const MAX_TASKS = 8
export const MAX_SUBS = 6

const subRows = (item: Item, max: number): SubRow[] => {
  const subs = item.subtasks ?? []
  // a finished task shows all its steps done, even if the last update forgot one
  const list = subs.map((sub, at) => ({
    id: `${item.id}.${at}`,
    text: sub.text,
    active: sub.text,
    status: item.status === 'completed' ? ('completed' as const) : sub.status,
  }))
  return rows(list, max).map(row => ({ kind: row.kind, mark: row.mark, text: row.text }))
}

const toView = (item: Item, open: string): TaskView => {
  const subs = item.subtasks ?? []
  const total = subs.length
  const done = item.status === 'completed' ? total : subs.filter(sub => sub.status === 'completed').length
  return {
    id: item.id,
    kind: item.status === 'completed' ? 'done' : item.status === 'in_progress' ? 'active' : 'todo',
    text: item.status === 'in_progress' ? item.active : item.text,
    done,
    total,
    isOpen: total > 0 && item.id === open,
    subs: subRows(item, MAX_SUBS),
  }
}

/** The bar's task rows: every task with its own counts; done ones collapse into "N done" when they do not fit. */
export const taskViews = (list: readonly Item[], fold: Fold, max = MAX_TASKS): TaskView[] => {
  const open = openId(list, fold)
  const all = list.map(item => toView(item, open))
  if (all.length <= max) {
    return all
  }
  const done = all.filter(view => view.kind === 'done')
  const rest = all.filter(view => view.kind !== 'done')
  const head: TaskView[] =
    done.length > 0
      ? [{ id: '', kind: 'more', text: `${done.length} done`, done: 0, total: 0, isOpen: false, subs: [] }]
      : []
  const room = max - head.length
  if (rest.length <= room) {
    return [...head, ...rest]
  }
  const shown = rest.slice(0, Math.max(0, room - 1))
  const more: TaskView = {
    id: '',
    kind: 'more',
    text: `+${rest.length - shown.length}`,
    done: 0,
    total: 0,
   
    isOpen: false,
    subs: [],
  }
  return [...head, ...shown, more]
}

// ── The task line in the chat ──
/** live: this turn is still working on it; done: every task finished; stopped: the turn ended before that. */
export type LineState = 'live' | 'done' | 'stopped'
export type Tone = 'accent' | 'done' | 'warn' | 'dim' | 'text' | 'rule'
export type Piece = { text: string; tone?: Tone; bold?: boolean }
export type TreeRow = { id: string; pieces: Piece[]; hasSteps: boolean }

export const GAUGE = 16
export const STEP_GAUGE = 6

/** `━━━━━━────`: full only when everything is done. */
export const gauge = (done: number, total: number, width: number): string => {
  const filled = total === 0 ? 0 : done >= total ? width : Math.min(width - 1, Math.round((done / total) * width))
  return '━'.repeat(filled) + '─'.repeat(width - filled)
}

export const lineState = (list: readonly Item[], isRunning: boolean): LineState =>
  isFinished(list) ? 'done' : isRunning ? 'live' : 'stopped'

const toneOf = (state: LineState): Tone => (state === 'done' ? 'done' : state === 'live' ? 'accent' : 'warn')

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text)
const pad = (text: string, width: number): string => {
  const shown = cut(text, width)
  return shown + ' '.repeat(Math.max(0, width - shown.length))
}

/** `▸ tasks  ━━━━━━━━────────  2/4 · now: fix the login` */
export const lineHead = (list: readonly Item[], state: LineState, isOpen: boolean, width = 100): Piece[] => {
  const { done, total } = counts(list)
  const now = current(list)
  const doing = now === undefined ? '' : now.status === 'in_progress' ? now.active : now.text
  const tone = toneOf(state)
  const tail =
    state === 'done' ? ' ✓ done' : state === 'live' ? (doing === '' ? '' : ` · now: ${doing}`) : ` · stopped at: ${doing || 'the start'}`
  // the gauge shrinks before anything is cut; the tail takes what is left
  const ratio = `  ${done}/${total}`.length
  const size = Math.max(6, Math.min(GAUGE, width - 2 - 7 - ratio - 14))
  const room = Math.max(0, width - 2 - 7 - size - ratio)
  return [
    { text: isOpen ? '▾ ' : '▸ ', tone: 'dim' },
    { text: 'tasks  ', tone: 'text', bold: true },
    // filled in the state's colour, the rest dim (a stopped list is not "all amber")
    { text: gauge(done, total, size).replace(/─+$/, ''), tone },
    { text: (gauge(done, total, size).match(/─+$/) ?? [''])[0], tone: 'rule' },
    { text: `  ${done}/${total}`, tone: state === 'done' ? 'done' : 'dim' },
    { text: room > 1 ? cut(tail, room) : '', tone: state === 'stopped' ? 'warn' : state === 'done' ? 'done' : 'dim' },
  ]
}

/** The unfolded tree: one row per task (a step gauge when it has steps), the open task's steps under it. */
export const treeRows = (list: readonly Item[], fold: Fold, state: LineState, width = 100): TreeRow[] => {
  const span = Math.min(width, 100)
  const hasGauges = span >= 48
  const views = taskViews(list, fold)
  // the step gauges sit right after the longest task name (never past the width)
  const longest = Math.max(8, ...views.filter(view => view.kind !== 'more').map(view => view.text.length))
  const textWidth = Math.max(8, Math.min(longest + 2, span - 4 - 3 - (hasGauges ? STEP_GAUGE + 7 : 0)))
  const rows: TreeRow[] = []
  for (const view of views) {
    if (view.kind === 'more') {
      rows.push({ id: '', hasSteps: false, pieces: [{ text: `    ${view.text.startsWith('+') ? '·' : '✓'}  ${view.text}`, tone: 'dim' }] })
      continue
    }
    const mark = view.kind === 'done' ? '✓' : view.kind === 'active' ? (state === 'stopped' ? '◌' : '●') : '○'
    const tone: Tone = view.kind === 'done' ? 'done' : view.kind === 'active' ? (state === 'stopped' ? 'warn' : 'accent') : 'dim'
    const pieces: Piece[] = [
      { text: `    ${mark}  `, tone },
      { text: view.total > 0 && hasGauges ? pad(view.text, textWidth) : cut(view.text, textWidth), tone: view.kind === 'active' ? 'text' : 'dim' },
    ]
    if (view.total > 0 && hasGauges) {
      pieces.push({ text: ` ${gauge(view.done, view.total, STEP_GAUGE)}`, tone: view.kind === 'done' ? 'done' : view.kind === 'active' ? tone : 'rule' })
      pieces.push({ text: ` ${view.done}/${view.total}`, tone: 'dim' })
    }
    rows.push({ id: view.id, hasSteps: view.total > 0, pieces })
    if (view.isOpen) {
      view.subs.forEach((sub, at) => {
        const last = at === view.subs.length - 1
        const subMark = sub.kind === 'active' && state === 'stopped' ? '◌' : sub.mark
        const subTone: Tone = sub.kind === 'done' ? 'done' : sub.kind === 'active' ? (state === 'stopped' ? 'warn' : 'accent') : 'dim'
        rows.push({
          id: '',
          hasSteps: false,
          pieces: [
            { text: `       ${last ? '└' : '├'} `, tone: 'rule' },
            { text: `${subMark} `, tone: subTone },
            { text: cut(sub.text, Math.max(8, span - 11)), tone: sub.kind === 'active' ? 'text' : 'dim' },
          ],
        })
      })
    }
  }
  return rows
}
