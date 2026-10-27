import { describe, expect, it } from 'vitest';
import { lineageTree, type SessionInfo, type SessionOrigin } from '@solline/protocol';

const session = (id: string, origin?: SessionOrigin, raceId?: string): SessionInfo => ({
  id,
  projectId: 'p',
  agent: 'claude',
  cwd: '/p',
  title: id,
  state: 'idle',
  settings: { model: null, effort: null, mode: null },
  agentSessionId: null,
  ...(origin ? { origin } : {}),
  ...(raceId ? { raceId } : {}),
});

describe('lineageTree', () => {
  it('sem sessões, tudo vazio', () => {
    expect(lineageTree([])).toEqual({
      roots: [],
      children: {},
      edges: [],
      groups: [],
      detached: [],
    });
  });

  it('sessões sem origem são raízes, pela ordem da lista, com a lista de filhos vazia', () => {
    const tree = lineageTree([session('b'), session('a')]);
    expect(tree.roots).toEqual(['b', 'a']);
    expect(tree.children).toEqual({ b: [], a: [] });
    expect(tree.edges).toEqual([]);
  });

  it('uma cadeia de passagens e bifurcações: filhos, arestas com o turno e uma só raiz', () => {
    const tree = lineageTree([
      session('a'),
      session('b', { kind: 'handoff', sessionId: 'a', turnId: 't9' }),
      session('c', { kind: 'fork', sessionId: 'a', turnId: 't2' }),
      session('d', { kind: 'fork', sessionId: 'a', turnId: 't4' }),
      session('e', { kind: 'fork', sessionId: 'b', turnId: 't1' }),
    ]);
    expect(tree.roots).toEqual(['a']);
    expect(tree.children).toEqual({ a: ['b', 'c', 'd'], b: ['e'], c: [], d: [], e: [] });
    expect(tree.edges).toEqual([
      { from: 'a', to: 'b', kind: 'handoff', turnId: 't9' },
      { from: 'a', to: 'c', kind: 'fork', turnId: 't2' },
      { from: 'a', to: 'd', kind: 'fork', turnId: 't4' },
      { from: 'b', to: 'e', kind: 'fork', turnId: 't1' },
    ]);
    expect(tree.detached).toEqual([]);
    expect(tree.groups).toEqual([]);
  });

  it('o filho pode vir antes do pai na lista', () => {
    const tree = lineageTree([session('b', { kind: 'fork', sessionId: 'a' }), session('a')]);
    expect(tree.roots).toEqual(['a']);
    expect(tree.children).toEqual({ b: [], a: ['b'] });
    // Sem turnId, a aresta também não o traz.
    expect(tree.edges).toEqual([{ from: 'a', to: 'b', kind: 'fork' }]);
  });

  it('um pai que já não existe: a sessão passa a raiz e guarda o que a origem dizia', () => {
    const tree = lineageTree([
      session('a'),
      session('b', { kind: 'fork', sessionId: 'fechada', turnId: 't3' }),
      session('c', { kind: 'handoff', sessionId: 'desconhecida' }),
      session('d', { kind: 'handoff' }),
    ]);
    expect(tree.roots).toEqual(['a', 'b', 'c', 'd']);
    expect(tree.edges).toEqual([]);
    expect(tree.children).toEqual({ a: [], b: [], c: [], d: [] });
    expect(tree.detached).toEqual([
      { id: 'b', kind: 'fork', parentId: 'fechada', turnId: 't3' },
      { id: 'c', kind: 'handoff', parentId: 'desconhecida' },
    ]);
  });

  it('os netos de um pai em falta continuam ligados ao filho', () => {
    const tree = lineageTree([
      session('b', { kind: 'fork', sessionId: 'fechada' }),
      session('c', { kind: 'handoff', sessionId: 'b' }),
    ]);
    expect(tree.roots).toEqual(['b']);
    expect(tree.children).toEqual({ b: ['c'], c: [] });
    expect(tree.detached.map((d) => d.id)).toEqual(['b']);
  });

  it('um ciclo parte-se na sessão que vem primeiro; nunca fica sem raiz nem em ciclo', () => {
    const two = lineageTree([
      session('a', { kind: 'fork', sessionId: 'b', turnId: 't1' }),
      session('b', { kind: 'handoff', sessionId: 'a' }),
    ]);
    expect(two.roots).toEqual(['a']);
    expect(two.children).toEqual({ a: ['b'], b: [] });
    expect(two.detached).toEqual([{ id: 'a', kind: 'fork', parentId: 'b', turnId: 't1' }]);

    const three = lineageTree([
      session('x'),
      session('c', { kind: 'fork', sessionId: 'b' }),
      session('a', { kind: 'fork', sessionId: 'c' }),
      session('b', { kind: 'fork', sessionId: 'a' }),
      session('d', { kind: 'handoff', sessionId: 'b' }),
    ]);
    // O c vem primeiro dos três: passa a raiz; a cadeia c -> a -> b -> d fica de pé.
    expect(three.roots).toEqual(['x', 'c']);
    expect(three.children).toMatchObject({ c: ['a'], a: ['b'], b: ['d'] });
    expect(three.detached).toEqual([{ id: 'c', kind: 'fork', parentId: 'b' }]);
    // Todas as sessões estão na árvore uma só vez.
    const seen = three.roots.flatMap(function walk(id: string): string[] {
      return [id, ...three.children[id]!.flatMap(walk)];
    });
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'x']);
  });

  it('uma sessão que é origem de si própria é uma raiz (sem ciclo)', () => {
    const tree = lineageTree([session('a', { kind: 'fork', sessionId: 'a' })]);
    expect(tree.roots).toEqual(['a']);
    expect(tree.children).toEqual({ a: [] });
    expect(tree.edges).toEqual([]);
  });

  it('as pistas e as partes de uma corrida ficam no grupo dela', () => {
    const tree = lineageTree([
      session('l1', { kind: 'lane', raceId: 'r1' }),
      session('l2', { kind: 'lane', raceId: 'r1' }),
      // A corrida também pode vir do campo raceId da sessão.
      session('l3', { kind: 'lane' }, 'r1'),
      session('p1', { kind: 'part', raceId: 'r2' }),
      session('p2', { kind: 'part', sessionId: 'p1', raceId: 'r2' }),
      session('p3', { kind: 'part', sessionId: 'p-fechada', raceId: 'r2' }),
      session('solta', { kind: 'lane' }),
    ]);
    expect(tree.groups).toEqual([
      { kind: 'race', id: 'r1', members: ['l1', 'l2', 'l3'] },
      { kind: 'race', id: 'r2', members: ['p1', 'p2', 'p3'] },
    ]);
    // A pista não tem pai de sessão; a parte que recebeu o resultado de outra é filha dela.
    expect(tree.roots).toEqual(['l1', 'l2', 'l3', 'p1', 'p3', 'solta']);
    expect(tree.edges).toEqual([{ from: 'p1', to: 'p2', kind: 'part' }]);
    expect(tree.children.p1).toEqual(['p2']);
    // Um produtor em falta deixa a parte na corrida, como raiz, e fica assinalado.
    expect(tree.detached).toEqual([{ id: 'p3', kind: 'part', parentId: 'p-fechada' }]);
  });

  it('as tarefas dos Espaços agrupam-se pela tarefa', () => {
    const tree = lineageTree([
      session('t1', { kind: 'task', taskId: 'k1' }),
      session('t2', { kind: 'task', taskId: 'k1' }),
      session('t3', { kind: 'task', taskId: 'k2' }),
      session('t4', { kind: 'task' }),
    ]);
    expect(tree.groups).toEqual([
      { kind: 'task', id: 'k1', members: ['t1', 't2'] },
      { kind: 'task', id: 'k2', members: ['t3'] },
    ]);
    expect(tree.roots).toEqual(['t1', 't2', 't3', 't4']);
    expect(tree.edges).toEqual([]);
  });

  it('uma bifurcação de uma pista é filha dela e a pista continua na corrida', () => {
    const tree = lineageTree([
      session('l1', { kind: 'lane', raceId: 'r1' }),
      session('f', { kind: 'fork', sessionId: 'l1', turnId: 't1' }),
    ]);
    expect(tree.roots).toEqual(['l1']);
    expect(tree.children.l1).toEqual(['f']);
    expect(tree.groups).toEqual([{ kind: 'race', id: 'r1', members: ['l1'] }]);
  });

  it('ids repetidos contam uma vez; a lista de entrada não muda', () => {
    const input = [session('a'), session('b', { kind: 'fork', sessionId: 'a' }), session('a')];
    const copy = structuredClone(input);
    const tree = lineageTree(input);
    expect(tree.roots).toEqual(['a']);
    expect(tree.children).toEqual({ a: ['b'], b: [] });
    expect(input).toEqual(copy);
  });
});
