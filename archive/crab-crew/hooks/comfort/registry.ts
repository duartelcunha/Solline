import { POOL } from './emoji'

export const STALE_MS = 60_000
export const MAX_NAME = 40
export const MAX_ICON = 8

export type Entry = {
  sessionId: string
  emoji: string
  name: string
  since: number
  lastSeen: number
}

const isEntry = (value: unknown): value is Entry => {
  const v = value as Record<string, unknown> | null
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.sessionId === 'string' &&
    typeof v.emoji === 'string' &&
    typeof v.name === 'string' &&
    typeof v.since === 'number' &&
    typeof v.lastSeen === 'number'
  )
}

export const parse = (text: string | undefined): Entry[] => {
  try {
    const data = JSON.parse(text ?? '') as { windows?: unknown }
    return Array.isArray(data.windows) ? data.windows.filter(isEntry) : []
  } catch {
    return []
  }
}

export const serialize = (entries: readonly Entry[]): string =>
  JSON.stringify({ windows: entries }, null, 2)

export const live = (entries: readonly Entry[], now: number): Entry[] =>
  entries.filter(entry => now - entry.lastSeen < STALE_MS)

const others = (entries: readonly Entry[], sessionId: string, now: number): Entry[] =>
  live(entries, now).filter(entry => entry.sessionId !== sessionId)

/** First free emoji after `after`; if all are in use, the one of the least recently seen window. */
export const pickEmoji = (
  entries: readonly Entry[],
  sessionId: string,
  now: number,
  after?: string,
): string => {
  const rest = others(entries, sessionId, now)
  const used = new Set(rest.map(entry => entry.emoji))
  const start = after === undefined ? 0 : POOL.indexOf(after) + 1
  for (let i = 0; i < POOL.length; i += 1) {
    const candidate = POOL[(start + i) % POOL.length]
    if (candidate !== undefined && !used.has(candidate)) {
      return candidate
    }
  }
  const oldest = [...rest].sort((a, b) => a.lastSeen - b.lastSeen)[0]
  return oldest?.emoji ?? POOL[0] ?? '🤖'
}

/** This session's entry: reuses the existing one, else picks a free emoji. */
export const claim = (
  entries: readonly Entry[],
  sessionId: string,
  folder: string,
  now: number,
  saved?: { sessionId: string; emoji: string; name: string; since: number },
): Entry => {
  const own = entries.find(entry => entry.sessionId === sessionId)
  const known = own ?? (saved?.sessionId === sessionId ? saved : undefined)
  const taken = new Set(others(entries, sessionId, now).map(entry => entry.emoji))
  const emoji =
    known !== undefined && !taken.has(known.emoji)
      ? known.emoji
      : pickEmoji(entries, sessionId, now)
  return {
    sessionId,
    emoji,
    name: known?.name ?? folder,
    since: known?.since ?? now,
    lastSeen: now,
  }
}

export const upsert = (entries: readonly Entry[], mine: Entry, now: number): Entry[] => [
  ...others(entries, mine.sessionId, now),
  mine,
]

export const remove = (entries: readonly Entry[], sessionId: string, now: number): Entry[] =>
  others(entries, sessionId, now)

/** Another live window has the same emoji and is older: this one gives way. */
export const collides = (entries: readonly Entry[], mine: Entry, now: number): boolean =>
  others(entries, mine.sessionId, now).some(
    entry =>
      entry.emoji === mine.emoji &&
      (entry.since < mine.since ||
        (entry.since === mine.since && entry.sessionId < mine.sessionId)),
  )

export const cleanName = (raw: string, fallback: string): string => {
  const text = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME)
    .trim()
  return text === '' ? fallback : text
}

export const cleanIcon = (raw: string): string | undefined => {
  const text = raw.trim()
  if (text === '' || /[\s\u0000-\u001f\u007f-\u009f]/.test(text)) {
    return undefined
  }
  return [...text].length > MAX_ICON ? undefined : text
}

/** "🦊 dev8" → { emoji: '🦊', name: 'dev8' }: the shape a session already named by comfort or cc has. */
export const splitTitle = (title: string): { emoji: string; name: string } | undefined => {
  const match = /^(\S+)\s+(.+)$/u.exec(title.trim())
  if (match === null) {
    return undefined
  }
  const emoji = cleanIcon(match[1] ?? '')
  if (emoji === undefined || !/\p{Extended_Pictographic}/u.test(emoji)) {
    return undefined
  }
  return { emoji, name: cleanName(match[2] ?? '', 'terminal') }
}

export const folderName = (cwd: string): string => {
  const parts = cwd.split(/[\\/]+/).filter(part => part !== '')
  return cleanName(parts[parts.length - 1] ?? '', 'terminal')
}
