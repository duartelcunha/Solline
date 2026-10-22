import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { defaultNavigation, resolveStartupTarget, NavigationUpdate } from '@solline/protocol';
import { NavigationPreferencesStore } from './navigation-preferences';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const available = {
  projects: ['p'],
  sessions: ['s'],
  races: ['r'],
  tasks: [{ id: 't', projectId: 'p' }],
};
test('old installs open Geral; startup choices and missing targets never execute work', () => {
  expect(resolveStartupTarget(defaultNavigation(), available)).toEqual({
    view: 'spaces',
    projectId: null,
  });
  const preferences = {
    ...defaultNavigation(),
    lastTarget: { view: 'session' as const, sessionId: 's' },
  };
  expect(resolveStartupTarget(preferences, available)).toEqual(preferences.lastTarget);
  expect(resolveStartupTarget({ ...preferences, startupView: 'desk' }, available)).toEqual({
    view: 'desk',
  });
  expect(resolveStartupTarget({ ...preferences, startupView: 'general-tasks' }, available)).toEqual(
    { view: 'spaces', projectId: null },
  );
  expect(resolveStartupTarget(preferences, { ...available, sessions: [] })).toEqual({
    view: 'spaces',
    projectId: null,
  });
  expect(
    resolveStartupTarget(
      { ...preferences, lastTarget: { view: 'spaces', projectId: 'gone' } },
      available,
    ),
  ).toEqual({ view: 'spaces', projectId: null });
  expect(
    resolveStartupTarget(
      { ...preferences, lastTarget: { view: 'spaces', projectId: 'p', taskId: 'gone' } },
      available,
    ),
  ).toEqual({ view: 'spaces', projectId: 'p' });
});
test('serial updates preserve startup choice and restore exact destination from disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'solline-navigation-'));
  roots.push(root);
  const file = join(root, 'navigation.json');
  const store = new NavigationPreferencesStore(file);
  expect(await store.read()).toEqual(defaultNavigation());
  await Promise.all([
    store.update({ startupView: 'desk' }),
    store.update({ lastTarget: { view: 'spaces', projectId: 'p', taskId: 't' } }),
  ]);
  const saved = await new NavigationPreferencesStore(file).read();
  expect(saved.startupView).toBe('desk');
  expect(saved.lastTarget).toEqual({ view: 'spaces', projectId: 'p', taskId: 't' });
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(saved);
});
test('invalid preferences are preserved and unsafe payloads are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'solline-navigation-'));
  roots.push(root);
  const file = join(root, 'navigation.json');
  await writeFile(file, 'truncated');
  await expect(new NavigationPreferencesStore(file).read()).rejects.toThrow();
  expect(await readFile(file, 'utf8')).toBe('truncated');
  expect(NavigationUpdate.safeParse({ startupView: 'auto-run' }).success).toBe(false);
  expect(
    NavigationUpdate.safeParse({ lastTarget: { view: 'session', sessionId: 's', command: 'run' } })
      .success,
  ).toBe(false);
});
