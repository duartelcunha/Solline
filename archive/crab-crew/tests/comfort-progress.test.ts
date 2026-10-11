import { expect, test } from 'claude-code/testing'

import { describe, groupLine, shorten } from '../hooks/comfort/compact'
import {
  addTask,
  bar,
  counts,
  current,
  fromTodos,
  hasActive,
  isFinished,
  rows,
  updateTask,
} from '../hooks/comfort/progress'
import type { Item } from '../hooks/comfort/progress'

const item = (id: string, status: Item['status']): Item => ({
  id,
  text: `task ${id}`,
  active: `doing ${id}`,
  status,
})

test('the bar only fills completely when everything is done', () => {
  expect(bar(0, 7)).toBe('▱▱▱▱▱▱▱')
  expect(bar(3, 7)).toBe('▰▰▰▱▱▱▱')
  expect(bar(6, 7)).toBe('▰▰▰▰▰▰▱')
  expect(bar(7, 7)).toBe('▰▰▰▰▰▰▰')
  expect(bar(0, 0)).toBe('▱▱▱▱▱▱▱')
})

test('TodoWrite becomes a list, using the active form only when it exists', () => {
  const list = fromTodos([
    { content: 'Read', status: 'completed', activeForm: 'Reading' },
    { content: 'Write', status: 'in_progress', activeForm: 'Writing' },
    { content: 'Validate', status: 'pending' },
  ])
  expect(counts(list)).toEqual({ done: 1, total: 3 })
  expect(hasActive(list)).toBe(true)
  expect(rows(list).map(row => `${row.mark} ${row.text}`)).toEqual([
    '✓ Read',
    '● Writing',
    '○ Validate',
  ])
})

test('TaskCreate and TaskUpdate keep the list by id', () => {
  let list = addTask([], '1', 'First', 'Doing the first')
  list = addTask(list, '2', 'Second')
  list = updateTask(list, { taskId: '1', status: 'in_progress' })
  expect(list.map(entry => entry.status)).toEqual(['in_progress', 'pending'])
  list = updateTask(list, { taskId: '1', status: 'completed' })
  list = updateTask(list, { taskId: '2', status: 'deleted' })
  expect(list).toHaveLength(1)
  expect(isFinished(list)).toBe(true)
})

test('the current task is the one in progress, else the next pending one', () => {
  expect(current([item('1', 'completed'), item('2', 'in_progress'), item('3', 'pending')])?.id).toBe('2')
  expect(current([item('1', 'completed'), item('2', 'pending')])?.id).toBe('2')
  expect(current([item('1', 'completed')])).toBeUndefined()
})

test('an empty list never counts as finished', () => {
  expect(isFinished([])).toBe(false)
})

test('with more than 5 tasks the done ones collapse and the rest becomes +N', () => {
  const list = [
    item('1', 'completed'),
    item('2', 'completed'),
    item('3', 'completed'),
    item('4', 'in_progress'),
    item('5', 'pending'),
    item('6', 'pending'),
    item('7', 'pending'),
  ]
  const shown = rows(list).map(row => `${row.mark} ${row.text}`)
  expect(shown).toHaveLength(5)
  expect(shown[0]).toBe('✓ 3 done')
  expect(shown[1]).toBe('● doing 4')
  expect(shown[shown.length - 1]).toBe('○ task 7')
})

test('when the rest does not fit, the excess becomes +N and the active task stays visible', () => {
  const list = [
    item('1', 'completed'),
    item('2', 'in_progress'),
    item('3', 'pending'),
    item('4', 'pending'),
    item('5', 'pending'),
    item('6', 'pending'),
    item('7', 'pending'),
  ]
  const shown = rows(list).map(row => `${row.mark} ${row.text}`)
  expect(shown).toHaveLength(5)
  expect(shown[0]).toBe('✓ 1 done')
  expect(shown[1]).toBe('● doing 2')
  expect(shown[shown.length - 1]).toBe('· +3')
})

test('compact tool rows', () => {
  expect(describe('Read', { file_path: 'C:\\x\\y\\register.tsx' })).toBe('Read register.tsx')
  expect(describe('Bash', { command: 'git status\nls' })).toBe('Bash git status')
  expect(describe('Grep', { pattern: 'abc' })).toBe('Grep abc')
  expect(describe('mcp__srv__do_it', {})).toBe('do_it')
  expect(describe('Read', undefined)).toBe('Read')
  expect(shorten('a'.repeat(100), 10)).toHaveLength(10)
})

test('group summary counts per tool in order of appearance', () => {
  expect(groupLine([{ tool: 'Read' }, { tool: 'Grep' }, { tool: 'Read' }, { tool: 'Read' }])).toBe(
    'Read ×3 · Grep',
  )
})
