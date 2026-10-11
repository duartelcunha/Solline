import { expect, test } from 'claude-code/testing'

import { POOL } from '../hooks/comfort/emoji'
import {
  STALE_MS,
  claim,
  cleanIcon,
  cleanName,
  collides,
  folderName,
  live,
  parse,
  pickEmoji,
  remove,
  serialize,
  upsert,
} from '../hooks/comfort/registry'
import type { Entry } from '../hooks/comfort/registry'

const entry = (sessionId: string, emoji: string, since: number, lastSeen = since): Entry => ({
  sessionId,
  emoji,
  name: sessionId,
  since,
  lastSeen,
})

test('windows open at the same time get different emojis', () => {
  const now = 1_000_000
  let entries: Entry[] = []
  const seen = new Set<string>()
  for (let i = 0; i < 5; i += 1) {
    const mine = claim(entries, `s${i}`, 'folder', now)
    seen.add(mine.emoji)
    entries = upsert(entries, mine, now)
  }
  expect(seen.size).toBe(5)
})

test('an expired window’s emoji becomes free again', () => {
  const now = 1_000_000
  const old = entry('old', POOL[0]!, 0, now - STALE_MS - 1)
  expect(live([old], now)).toEqual([])
  expect(claim([old], 'new', 'folder', now).emoji).toBe(POOL[0])
})

test('the same session keeps its emoji and name when claiming again', () => {
  const now = 1_000_000
  const mine: Entry = { ...entry('s1', POOL[3]!, 5, now), name: 'my-name' }
  const again = claim([mine], 's1', 'folder', now + 1000)
  expect([again.emoji, again.name, again.since]).toEqual([POOL[3], 'my-name', 5])
})

test('rotating moves to the next free emoji and skips taken ones', () => {
  const now = 1_000_000
  const other = entry('b', POOL[1]!, now)
  expect(pickEmoji([other], 'a', now, POOL[0])).toBe(POOL[2])
})

test('with every emoji taken, reuses the least recently seen window’s', () => {
  const now = 1_000_000
  const all = POOL.map((emoji, i) => entry(`w${i}`, emoji, now, now - i))
  expect(pickEmoji(all, 'new', now)).toBe(POOL[POOL.length - 1])
})

test('collision: the newer window gives way', () => {
  const now = 1_000_000
  const older = entry('a', POOL[0]!, 1, now)
  const newer = entry('b', POOL[0]!, 2, now)
  expect(collides([older, newer], newer, now)).toBe(true)
  expect(collides([older, newer], older, now)).toBe(false)
})

test('removing takes out only the requested session', () => {
  const now = 1_000_000
  const a = entry('a', POOL[0]!, now)
  const b = entry('b', POOL[1]!, now)
  expect(remove([a, b], 'a', now)).toEqual([b])
})

test('a corrupt or wrongly shaped file gives an empty list', () => {
  expect(parse(undefined)).toEqual([])
  expect(parse('{not json')).toEqual([])
  expect(parse('{"windows":[1,"x",{"emoji":"a"}]}')).toEqual([])
  const good = entry('a', POOL[0]!, 1)
  expect(parse(serialize([good]))).toEqual([good])
})

test('the name is cleaned: one line, 40 characters, no control characters', () => {
  expect(cleanName('  a\n\tb\u0007c  ', 'x')).toBe('a b c')
  expect(cleanName('   ', 'x')).toBe('x')
  expect(cleanName('a'.repeat(100), 'x')).toHaveLength(40)
})

test('icon: a single short token with no spaces', () => {
  expect(cleanIcon('🦊')).toBe('🦊')
  expect(cleanIcon('two emojis')).toBeUndefined()
  expect(cleanIcon('')).toBeUndefined()
  expect(cleanIcon('abcdefghi')).toBeUndefined()
})

test('the folder name comes from the last path segment', () => {
  expect(folderName('C:\\Users\\me\\project')).toBe('project')
  expect(folderName('/home/x/app/')).toBe('app')
  expect(folderName('')).toBe('terminal')
})
