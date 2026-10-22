import { expect, test } from 'vitest';
import { findNavigationEntries, type NavigationEntry } from './search-model';

const rows: NavigationEntry[] = [
  {
    id: 'p',
    title: 'Aplicação',
    detail: 'Projeto pessoal',
    kind: 'project',
    target: { view: 'spaces', projectId: 'p' },
  },
  {
    id: 't',
    title: 'Rever autenticação',
    detail: 'Aplicação · Para rever',
    kind: 'task',
    target: { view: 'spaces', projectId: 'p', taskId: 't' },
  },
  {
    id: 's',
    title: 'Autenticação',
    detail: 'Outro projeto · Conversa',
    kind: 'session',
    target: { view: 'session', sessionId: 's' },
  },
];
test('accent-insensitive search ranks exact titles and keeps project context', () => {
  expect(findNavigationEntries(rows, 'AUTENTICACAO').entries.map((x) => x.id)).toEqual(['s', 't']);
  expect(findNavigationEntries(rows, 'autenticacao aplicacao').entries.map((x) => x.id)).toEqual([
    't',
  ]);
  expect(findNavigationEntries(rows, 'desconhecido').total).toBe(0);
});
test('empty and repeated queries stay deterministic; large lists remain bounded', () => {
  expect(findNavigationEntries(rows, '  ').entries).toEqual(rows);
  expect(findNavigationEntries(rows, 'rever rever').entries.map((x) => x.id)).toEqual(['t']);
  const first = rows[0];
  if (!first) throw new Error('Expected search fixture');
  const many = Array.from({ length: 100 }, (_, i) => ({ ...first, id: String(i) }));
  expect(findNavigationEntries(many, '').entries).toHaveLength(40);
  expect(findNavigationEntries(many, '').total).toBe(100);
});
