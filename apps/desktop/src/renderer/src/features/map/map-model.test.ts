import { describe, expect, it } from 'vitest';
import type { Turn } from '@solline/protocol';
import {
  GAP_X,
  NODE_H,
  NODE_W,
  defaultMapProject,
  edgePath,
  handoffPreview,
  layoutLineage,
  projectsWithLinks,
  type MapSession,
} from './map-model.ts';

const s = (id: string, over: Partial<MapSession> = {}): MapSession => ({
  id,
  title: `Sessão ${id}`,
  agent: 'claude',
  state: 'idle',
  projectId: 'p',
  ...over,
});
const child = (id: string, parent: string, kind: 'handoff' | 'fork' = 'handoff') =>
  s(id, { origin: { kind, sessionId: parent } });
const at = (layout: ReturnType<typeof layoutLineage>, id: string) => {
  const node = layout.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`sem nó ${id}`);
  return node;
};

describe('mapa: layout', () => {
  it('sem ligações está vazio e as sessões soltas não se desenham', () => {
    const layout = layoutLineage([s('a'), s('b')]);
    expect(layout).toMatchObject({ empty: true, loose: 2, nodes: [], width: 0 });
  });

  it('cadeia: cada sessão por baixo da anterior, no mesmo eixo, com linhas retas', () => {
    const layout = layoutLineage([s('a'), child('b', 'a'), child('c', 'b')]);
    expect(layout.nodes.map((n) => [n.id, n.depth])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
    expect(at(layout, 'a').x).toBe(at(layout, 'b').x);
    expect(at(layout, 'b').x).toBe(at(layout, 'c').x);
    expect(at(layout, 'b').y).toBeGreaterThan(at(layout, 'a').y + NODE_H);
    expect(layout.edges).toHaveLength(2);
    expect(layout.edges[0]?.points).toHaveLength(2);
    expect(layout.edges[0]).toMatchObject({ kind: 'handoff', label: 'passagem' });
  });

  it('centro com várias pontas: o pai fica centrado sobre os filhos, lado a lado', () => {
    const layout = layoutLineage([
      s('hub'),
      child('x', 'hub'),
      child('y', 'hub', 'fork'),
      child('z', 'hub'),
    ]);
    const x = at(layout, 'x');
    const y = at(layout, 'y');
    const z = at(layout, 'z');
    const hub = at(layout, 'hub');
    expect(y.x - x.x).toBe(NODE_W + GAP_X);
    expect(z.x - y.x).toBe(NODE_W + GAP_X);
    expect(x.y).toBe(y.y);
    expect(hub.x).toBe(y.x);
    expect(layout.edges.find((e) => e.to === 'y')).toMatchObject({
      kind: 'fork',
      label: 'bifurcação',
    });
    // Cotovelo: desce, anda de lado, desce.
    expect(layout.edges.find((e) => e.to === 'x')?.points).toHaveLength(4);
  });

  it('uma sessão sem pai aberto aparece como raiz com o fio a tracejado', () => {
    const layout = layoutLineage([s('a'), child('b', 'a'), child('d', 'fechada', 'fork')]);
    const d = at(layout, 'd');
    expect(d).toMatchObject({ depth: 0, stub: { kind: 'fork', parentId: 'fechada' } });
    expect(at(layout, 'a').stub).toBeNull();
    // As duas árvores não se tocam.
    expect(d.x).toBeGreaterThan(at(layout, 'a').x + NODE_W);
  });

  it('corrida: as pistas ficam lado a lado dentro de um grupo', () => {
    const layout = layoutLineage([
      s('l1', { origin: { kind: 'lane', raceId: 'r' } }),
      s('solta'),
      s('l2', { origin: { kind: 'lane', raceId: 'r' } }),
    ]);
    expect(layout.clusters).toHaveLength(1);
    expect(layout.clusters[0]).toMatchObject({
      kind: 'race',
      label: 'Corrida',
      members: ['l1', 'l2'],
    });
    expect(at(layout, 'l2').x - at(layout, 'l1').x).toBe(NODE_W + GAP_X * 2);
    expect(layout.loose).toBe(1);
  });

  it('é determinístico: a mesma lista dá sempre o mesmo desenho', () => {
    const list = [s('a'), child('b', 'a'), child('c', 'a', 'fork'), child('d', 'b')];
    expect(layoutLineage(list)).toEqual(layoutLineage([...list]));
  });

  it('a largura e a altura cobrem todas as caixas', () => {
    const layout = layoutLineage([s('a'), child('b', 'a'), child('c', 'a')]);
    for (const n of layout.nodes) {
      expect(n.x + NODE_W).toBeLessThanOrEqual(layout.width);
      expect(n.y + NODE_H).toBeLessThanOrEqual(layout.height);
    }
  });

  it('o caminho do cotovelo para o SVG', () => {
    expect(
      edgePath([
        [0, 0],
        [0, 10],
        [5, 10],
      ]),
    ).toBe('M0 0 L0 10 L5 10');
  });
});

describe('mapa: projetos', () => {
  const sessions = [
    s('a', { projectId: 'p1' }),
    { ...child('b', 'a'), projectId: 'p1' },
    s('c', { projectId: 'p2' }),
  ];

  it('só os projetos com ligações; o ativo é o que abre, se tiver; senão o primeiro que tenha', () => {
    const linked = projectsWithLinks([{ id: 'p1' }, { id: 'p2' }], sessions);
    expect(linked).toEqual(['p1']);
    expect(defaultMapProject('p2', linked, ['p1', 'p2'])).toBe('p1');
    expect(defaultMapProject('p2', ['p1', 'p2'], ['p1', 'p2'])).toBe('p2');
    expect(defaultMapProject('p1', linked, ['p1', 'p2'])).toBe('p1');
    expect(defaultMapProject(null, linked, ['p1', 'p2'])).toBe('p1');
    expect(defaultMapProject(null, [], ['p2'])).toBe('p2');
    expect(defaultMapProject(null, [], [])).toBeNull();
  });
});

describe('mapa: o que foi passado', () => {
  const turn = (role: Turn['role'], text: string): Turn => ({
    id: role,
    role,
    blocks: [{ kind: 'text', id: 'x', text, parentToolId: null }],
  });

  it('as primeiras linhas da primeira mensagem do utilizador', () => {
    expect(
      handoffPreview([
        turn('user', 'Passagem de testemunho\n\n## Objetivo\nExecutar a fase 1\nmais\nmais'),
      ]),
    ).toBe('Passagem de testemunho\n## Objetivo\nExecutar a fase 1');
  });

  it('sem mensagem não há nada; texto longo corta-se', () => {
    expect(handoffPreview([])).toBeNull();
    expect(handoffPreview([turn('assistant', 'olá')])).toBeNull();
    expect(handoffPreview([turn('user', 'x'.repeat(500))])?.length).toBe(280);
  });
});
