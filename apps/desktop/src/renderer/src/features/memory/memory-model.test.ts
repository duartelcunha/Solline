import { describe, expect, it } from 'vitest';
import { SpaceMemory } from '@solline/protocol';
import {
  batchSelectable,
  citationCopy,
  citationLabel,
  pendingCounts,
  pendingFor,
  planApproval,
  ruleProjectOf,
  staleLabel,
  toConfirmFor,
} from './memory-model.ts';

const memory = (over: Partial<SpaceMemory> & { id: string }): SpaceMemory =>
  SpaceMemory.parse({
    projectId: 'p1',
    text: 'texto',
    source: 'fonte',
    sourceId: null,
    state: 'pending',
    createdAt: 1,
    ...over,
  });

describe('caixa de memórias', () => {
  const all = [
    memory({ id: 'a', createdAt: 1 }),
    memory({ id: 'b', createdAt: 3 }),
    memory({ id: 'c', projectId: 'p2', createdAt: 2 }),
    memory({ id: 'd', state: 'active' }),
    memory({ id: 'e', state: 'toConfirm', stale: 'age' }),
    memory({ id: 'f', projectId: null, state: 'pending' }),
  ];

  it('num projeto só as suas propostas, as mais recentes primeiro; em Geral, todas', () => {
    expect(pendingFor(all, 'p1').map((m) => m.id)).toEqual(['b', 'a']);
    expect(pendingFor(all, null).map((m) => m.id)).toEqual(['b', 'c', 'a', 'f']);
    expect(toConfirmFor(all, 'p1').map((m) => m.id)).toEqual(['e']);
    expect(toConfirmFor(all, 'p2')).toEqual([]);
  });

  it('o contador conta propostas, não memórias a confirmar nem ativas', () => {
    const counts = pendingCounts(all);
    expect(counts.total).toBe(4);
    expect(counts.byProject.get('p1')).toBe(2);
    expect(counts.byProject.get('p2')).toBe(1);
    expect(counts.byProject.size).toBe(2);
  });

  it('as de origem externa não se aprovam em lote', () => {
    expect(batchSelectable(memory({ id: 'x' }))).toBe(true);
    expect(batchSelectable(memory({ id: 'y', external: true }))).toBe(false);
  });
});

describe('prova', () => {
  it('lê-se como ficheiro:linhas ou commit', () => {
    expect(citationLabel({ path: 'a/b.ts' })).toBe('a/b.ts');
    expect(citationLabel({ path: 'a/b.ts', line: 4 })).toBe('a/b.ts:4');
    expect(citationLabel({ path: 'a/b.ts', line: 4, endLine: 4 })).toBe('a/b.ts:4');
    expect(citationLabel({ path: 'a/b.ts', line: 4, endLine: 9 })).toBe('a/b.ts:4-9');
    expect(citationLabel({ commit: 'a1b2c3d4e5f6a7b8' })).toBe('commit a1b2c3d4e5');
    expect(citationCopy({ commit: 'a1b2c3d' })).toBe('a1b2c3d');
    expect(citationCopy({ path: 'x.ts', line: 2 })).toBe('x.ts:2');
  });

  it('diz porque está a confirmar', () => {
    expect(staleLabel(memory({ id: 'a', state: 'toConfirm', stale: 'age' }))).toContain('28 dias');
    expect(staleLabel(memory({ id: 'a', state: 'toConfirm', stale: 'evidence' }))).toContain(
      'prova',
    );
  });
});

describe('aprovar em lote', () => {
  it('uma chamada por âmbito, com as edições de cada uma', () => {
    expect(
      planApproval([
        { id: 'a', scope: 'project' },
        { id: 'b', scope: 'global', text: 'novo texto' },
        { id: 'c', scope: 'project', text: 'outro' },
      ]),
    ).toEqual([
      { scope: 'project', ids: ['a', 'c'], edits: { c: { text: 'outro' } } },
      { scope: 'global', ids: ['b'], edits: { b: { text: 'novo texto' } } },
    ]);
    expect(planApproval([])).toEqual([]);
  });

  it('a regra vai para o projeto da memória ou, na falta, o da prova', () => {
    expect(ruleProjectOf(memory({ id: 'a' }))).toBe('p1');
    expect(
      ruleProjectOf(
        memory({
          id: 'b',
          projectId: null,
          origin: { agent: 'claude', sessionId: 's', projectId: 'p9' },
        }),
      ),
    ).toBe('p9');
    expect(ruleProjectOf(memory({ id: 'c', projectId: null }))).toBeNull();
  });
});
