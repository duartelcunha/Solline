// Everything the bar drawing needs that can be tested without a screen.

export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const

// Each level its own colour, cool to hot as it rises: cyan, teal, lime, orange, rose. None of them is a
// model's colour (orchid, coral, sky, green below), so the two rows complement each other and never repeat.
export const LEVEL_COLORS: Record<string, string> = {
  low: '#22D3EE',
  medium: '#2DD4BF',
  high: '#A3E635',
  xhigh: '#FB923C',
  max: '#F43F5E',
}

export const MODEL_COLORS: Record<string, string> = {
  fable: '#E879F9',
  opus: '#D97757',
  sonnet: '#60A5FA',
  haiku: '#4ADE80',
}

export const LEVEL_SHORT: Record<string, string> = {
  low: 'low',
  medium: 'med',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

export const INK = '#1B1B1F'
export const MUTED = '#6B7280'
export const ARROW = ['▸', '◢', '▾'] as const
export const BLOCK = 5
export const PARTIALS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const

// Below U+1F000 only these draw 2 cells wide on their own (emoji presentation): the rest of the
// symbol blocks (✓ ✦ ✻ ★ ▸ ●) are 1 cell, as the terminal draws them.
const WIDE_BMP = new Set([
  0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615,
  0x2648, 0x2649, 0x264a, 0x264b, 0x264c, 0x264d, 0x264e, 0x264f, 0x2650, 0x2651, 0x2652, 0x2653,
  0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea,
  0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753,
  0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55,
])

const isZero = (code: number): boolean => code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0x300 && code <= 0x36f)

const isWide = (code: number): boolean =>
  WIDE_BMP.has(code) ||
  (code >= 0x1f300 && code <= 0x1faff) ||
  code === 0x1f004 ||
  code === 0x1f0cf ||
  code === 0x1f18e ||
  (code >= 0x1f191 && code <= 0x1f19a) ||
  (code >= 0x1f200 && code <= 0x1f2ff) ||
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe4f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x20000 && code <= 0x3fffd)

/** The text cut into what the terminal draws as one thing: a character with its joiners and selectors. */
export const graphemes = (text: string): string[] => {
  const out: string[] = []
  let joinNext = false
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (out.length > 0 && (isZero(code) || joinNext)) {
      out[out.length - 1] += char
    } else {
      out.push(char)
    }
    joinNext = code === 0x200d
  }
  return out
}

/** Cells one grapheme takes: 2 for emoji and wide symbols (a selector U+FE0F makes a narrow one wide), else 1. */
const graphemeWidth = (cluster: string): number => {
  const first = cluster.codePointAt(0) ?? 0
  if (isZero(first)) {
    return 0
  }
  return isWide(first) || cluster.includes('️') ? 2 : 1
}

/** Cells the text takes in the terminal. */
export const cellWidth = (text: string): number =>
  graphemes(text).reduce((sum, cluster) => sum + graphemeWidth(cluster), 0)

const channel = (hex: string, at: number): number => parseInt(hex.slice(at, at + 2), 16)

/** Mixes two hex colours: t=0 the first, t=1 the second. */
export const mix = (from: string, to: string, t: number): string => {
  const k = Math.min(1, Math.max(0, t))
  const part = (at: number) =>
    Math.round(channel(from, at) + (channel(to, at) - channel(from, at)) * k)
      .toString(16)
      .padStart(2, '0')
  return `#${part(1)}${part(3)}${part(5)}`.toUpperCase()
}

/** The gradient colour for a fill in cells (0..25): slides from level to level. */
export const levelColorAt = (fill: number): string => {
  const position = Math.max(0, fill / BLOCK - 1)
  const index = Math.min(LEVELS.length - 1, Math.floor(position))
  const next = Math.min(LEVELS.length - 1, index + 1)
  return mix(LEVEL_COLORS[LEVELS[index] ?? 'low'] ?? MUTED, LEVEL_COLORS[LEVELS[next] ?? 'max'] ?? MUTED, position - index)
}

export const levelIndex = (level: string): number => LEVELS.indexOf(level as (typeof LEVELS)[number])

/** Filled cells a level takes: low 5, medium 10, ... max 25; unknown 0. */
export const fillFor = (level: string): number => (levelIndex(level) + 1) * BLOCK

export type Cell = { char: string; isFilled: boolean }

/** The 25 cells of the 5 blocks, the last one half-filled during the animation. */
export const blockCells = (fill: number): Cell[] => {
  const cells: Cell[] = []
  for (let at = 0; at < LEVELS.length * BLOCK; at += 1) {
    const amount = fill - at
    if (amount >= 1) {
      cells.push({ char: '█', isFilled: true })
    } else if (amount > 0) {
      const step = Math.min(PARTIALS.length - 1, Math.floor(amount * (PARTIALS.length + 1)) - 1)
      cells.push(step >= 0 ? { char: PARTIALS[step] ?? '▏', isFilled: true } : { char: '░', isFilled: false })
    } else {
      cells.push({ char: '░', isFilled: false })
    }
  }
  return cells
}

/** A value on its way from `from` to `to`, started at `at`, over `ms`, with an easing. */
export type Motion = { from: number; to: number; at: number; ms: number; ease: 'out' | 'inout' }

export const easeOut = (t: number): number => 1 - (1 - t) ** 3
export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/** The motion's value at `now`: time-based, so it looks the same at any frame rate. */
export const tweenValue = (m: Motion, now: number): number => {
  if (m.ms <= 0 || now >= m.at + m.ms) {
    return m.to
  }
  const t = Math.max(0, (now - m.at) / m.ms)
  return m.from + (m.to - m.from) * (m.ease === 'out' ? easeOut(t) : easeInOut(t))
}

/** A new target mid-flight starts from where the value is now, so nothing jumps. */
export const retarget = (m: Motion, to: number, now: number, ms: number, ease: Motion['ease'] = 'out'): Motion =>
  m.to === to ? m : { from: tweenValue(m, now), to, at: now, ms, ease }

export const still = (value: number): Motion => ({ from: value, to: value, at: 0, ms: 0, ease: 'out' })

export const isMoving = (m: Motion, now: number): boolean => m.from !== m.to && now < m.at + m.ms

/** Moves an animated value towards its target: fast when far, gentle when close, snaps at the end. */
export const approach = (value: number, target: number, rate = 0.28, least = 0.35): number => {
  const gap = target - value
  if (Math.abs(gap) <= least) {
    return target
  }
  const step = Math.sign(gap) * Math.max(least, Math.abs(gap) * rate)
  return value + step
}

export type Action =
  | { kind: 'toggle' }
  | { kind: 'model'; value: string }
  | { kind: 'effort'; value: string }
  | { kind: 'ultra' }
  | { kind: 'back' }
  | { kind: 'settings' }
  | { kind: 'open'; value: string }

export type Seg = {
  text: string
  color?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  action?: Action
  hoverColor?: string
}

export type Region = { y: number; x0: number; x1: number; id: string; action: Action }

export const actionId = (action: Action): string =>
  'value' in action ? `${action.kind}:${action.value}` : action.kind

/** Where each clickable region is, from the drawn rows. */
export const place = (rows: readonly (readonly Seg[])[]): Region[] => {
  const regions: Region[] = []
  rows.forEach((row, y) => {
    let x = 0
    for (const seg of row) {
      const width = cellWidth(seg.text)
      if (seg.action !== undefined && width > 0) {
        regions.push({ y, x0: x, x1: x + width, id: actionId(seg.action), action: seg.action })
      }
      x += width
    }
  })
  return regions
}

export const hitAt = (regions: readonly Region[], x: number, y: number): Region | undefined =>
  regions.find(region => region.y === y && x >= region.x0 && x < region.x1)

/** For dragging on effort: the level under x, on any row of the blocks. */
export const effortAtX = (regions: readonly Region[], x: number): string | undefined => {
  const blocks = regions.filter(region => region.action.kind === 'effort')
  const inside = blocks.find(region => x >= region.x0 && x < region.x1)
  if (inside !== undefined && 'value' in inside.action) {
    return inside.action.value
  }
  if (blocks.length === 0) {
    return undefined
  }
  const first = blocks.reduce((a, b) => (b.x0 < a.x0 ? b : a))
  const last = blocks.reduce((a, b) => (b.x1 > a.x1 ? b : a))
  const edge = x < first.x0 ? first : x >= last.x1 ? last : undefined
  return edge !== undefined && 'value' in edge.action ? edge.action.value : undefined
}

export const segWidth = (segs: readonly Seg[]): number =>
  segs.reduce((sum, seg) => sum + cellWidth(seg.text), 0)

/**
 * Keeps the rightmost `n` cells of a row (for a strip growing leftward from a fixed right edge). A wide
 * character the cut falls inside becomes spaces, so the row is always exactly `n` cells.
 */
export const cutLeft = (segs: readonly Seg[], n: number): Seg[] => {
  let drop = segWidth(segs) - Math.max(0, n)
  if (drop <= 0) {
    return [...segs]
  }
  const out: Seg[] = []
  for (const seg of segs) {
    const width = cellWidth(seg.text)
    if (drop >= width) {
      drop -= width
      continue
    }
    if (drop > 0) {
      let text = ''
      let skipped = 0
      for (const cluster of graphemes(seg.text)) {
        const w = cellWidth(cluster)
        if (skipped < drop) {
          if (skipped + w > drop) {
            text += ' '.repeat(skipped + w - drop)
          }
          skipped += w
          continue
        }
        text += cluster
      }
      out.push({ ...seg, text })
      drop = 0
      continue
    }
    out.push(seg)
  }
  return out
}

/** Cuts text by cells (never mid-emoji), with … when it cuts. */
export const fitCells = (text: string, max: number, mark = '…'): string => {
  if (cellWidth(text) <= max) {
    return text
  }
  const room = Math.max(0, max - cellWidth(mark))
  let out = ''
  let used = 0
  for (const cluster of graphemes(text)) {
    const width = graphemeWidth(cluster)
    if (used + width > room) {
      break
    }
    out += cluster
    used += width
  }
  return max <= 0 ? '' : out + (max >= cellWidth(mark) ? mark : '')
}

/** The row with exactly `width` cells: cuts the excess, pads with spaces. */
export const exactRow = (segs: readonly Seg[], width: number): Seg[] => {
  const out: Seg[] = []
  let used = 0
  for (const seg of segs) {
    const w = cellWidth(seg.text)
    if (used + w <= width) {
      out.push(seg)
      used += w
    } else {
      const text = fitCells(seg.text, width - used, '')
      if (text !== '') {
        out.push({ ...seg, text })
        used += cellWidth(text)
      }
      break
    }
  }
  if (used < width) {
    out.push({ text: ' '.repeat(width - used) })
  }
  return out
}

export type Frame = {
  width: number
  title: readonly Seg[]
  corner: readonly Seg[]
  rows: readonly (readonly Seg[])[]
  color: string
  edgeAction?: Action
}

/** Rounded frame drawn cell by cell: every row the same width. */
export const framed = (f: Frame): Seg[][] => {
  const inner = f.width - 2
  const edge = (text: string): Seg => ({ text, color: f.color, action: f.edgeAction })
  const room = inner - 2 - 2 - segWidth(f.corner) - 2
  const title = exactRow(f.title, Math.max(0, Math.min(segWidth(f.title), room)))
  const dashes = Math.max(1, inner - 2 - segWidth(title) - 1 - segWidth(f.corner) - 2)
  const top: Seg[] = [edge('╭─ '), ...title, edge(` ${'─'.repeat(dashes - 1)} `), ...f.corner, edge(' ─╮')]
  const fixedTop = exactRow(top, f.width)
  const middle = f.rows.map(row => [edge('│'), ...exactRow(row, inner), edge('│')])
  const bottom = [edge(`╰${'─'.repeat(inner)}╯`)]
  return [fixedTop, ...middle, bottom]
}

/** Text centred in a fixed number of cells. */
export const center = (text: string, width: number): string => {
  const fitted = fitCells(text, width, '')
  const gap = width - cellWidth(fitted)
  const left = Math.floor(gap / 2)
  return ' '.repeat(left) + fitted + ' '.repeat(gap - left)
}

/** Only truly wide emoji go in the frame; anything else could misalign the border. */
export const isSafeEmoji = (text: string): boolean => {
  const chars = [...text].filter(char => {
    const code = char.codePointAt(0) ?? 0
    return code !== 0x200d && !(code >= 0xfe00 && code <= 0xfe0f)
  })
  return chars.length === 1 && (chars[0]?.codePointAt(0) ?? 0) >= 0x1f300
}

/** Exactly `width` cells: cut with … or padded with spaces, so the columns after it never move. */
export const padCells = (text: string, width: number): string => {
  const fitted = fitCells(text, width)
  return fitted + ' '.repeat(Math.max(0, width - cellWidth(fitted)))
}
