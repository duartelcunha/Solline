import { expect, test } from 'claude-code/testing'

import { type Item, openId, taskViews, toggleFold } from '../hooks/comfort/progress'

const item = (id: string, status: Item['status'], subs: Item['status'][] = []): Item => ({
  id,
  text: `Task ${id}`,
  active: `Doing ${id}`,
  status,
  ...(subs.length > 0 ? { subtasks: subs.map((s, at) => ({ text: `step ${at}`, status: s })) } : {}),
})

test('the active task is open by itself; a click on it folds it until another task starts', () => {
  const list = [item('p0', 'completed', ['completed']), item('p1', 'in_progress', ['completed', 'pending'])]
  const auto = { id: '', active: '' }
  expect(openId(list, auto)).toBe('p1')
  const shut = toggleFold(list, auto, 'p1')
  expect(openId(list, shut)).toBe('')
  const other = toggleFold(list, shut, 'p0')
  expect(openId(list, other)).toBe('p0')
  // the next task starts: the pick expires and the new active one opens
  const later = [item('p0', 'completed'), item('p1', 'completed'), item('p2', 'in_progress', ['pending'])]
  expect(openId(later, other)).toBe('p2')
})

test('views count steps, and a finished task shows every step done', () => {
  const list = [item('p0', 'completed', ['completed', 'pending']), item('p1', 'in_progress', ['completed', 'in_progress', 'pending'])]
  const views = taskViews(list, { id: '', active: '' })
  expect(views.map(v => `${v.done}/${v.total}`)).toEqual(['2/2', '1/3'])
  expect(views[0]?.subs.every(s => s.kind === 'done')).toBe(true)
  expect(views[1]?.isOpen).toBe(true)
  expect(views[1]?.text).toBe('Doing p1')
})

test('past 8 tasks, done ones collapse into one row', () => {
  const list = Array.from({ length: 11 }, (_, at) => item(`p${at}`, at < 5 ? 'completed' : at === 5 ? 'in_progress' : 'pending'))
  const views = taskViews(list, { id: '', active: '' })
  expect(views.length).toBeLessThanOrEqual(8)
  expect(views[0]).toMatchObject({ kind: 'more', text: '5 done' })
})
