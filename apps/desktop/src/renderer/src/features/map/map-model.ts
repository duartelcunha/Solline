import {
  lineageTree,
  type LineageKind,
  type SessionInfo,
  type SessionState,
  type Turn,
} from '@solline/protocol';

/**
 * O Mapa em modelo puro: da linhagem das sessões para posições no plano. Árvore de cima para
 * baixo, tudo determinístico (a mesma lista dá sempre o mesmo desenho). Cadeias e centros com
 * várias pontas saem da própria árvore; não há desenho à mão, só caixas e linhas retas.
 */

export const NODE_W = 184;
export const NODE_H = 56;
export const GAP_X = 28;
export const GAP_Y = 64;
/** Margem à volta do desenho. */
export const PAD = 24;
/** Espaço por cima da primeira linha: o rótulo de um grupo e o fio de uma sessão sem pai. */
export const TOP = 56;
export const GROUP_PAD = 10;

/** O que o Mapa precisa de cada sessão. */
export type MapSession = Pick<
  SessionInfo,
  'id' | 'title' | 'agent' | 'state' | 'projectId' | 'origin' | 'raceId'
>;

export interface MapNode {
  id: string;
  title: string;
  agent: string;
  state: SessionState;
  x: number;
  y: number;
  depth: number;
  /** Sem pai (já não está aberto): fio a tracejado para cima, com o tipo da ligação. */
  stub: { kind: LineageKind; parentId: string } | null;
}

export interface MapEdge {
  from: string;
  to: string;
  kind: LineageKind;
  turnId?: string;
  label: string;
  /** Cotovelo: sai do centro de baixo do pai e entra pelo centro de cima do filho. */
  points: [number, number][];
  labelAt: { x: number; y: number };
}

export interface MapCluster {
  kind: 'race' | 'task';
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  members: string[];
}

export interface MapLayout {
  nodes: MapNode[];
  edges: MapEdge[];
  clusters: MapCluster[];
  width: number;
  height: number;
  /** Sessões sem ligação nenhuma: não aparecem no Mapa. */
  loose: number;
  /** Nada está ligado a nada. */
  empty: boolean;
}

export const EDGE_LABEL: Record<LineageKind, string> = {
  handoff: 'passagem',
  fork: 'bifurcação',
  part: 'parte',
  lane: 'pista',
  task: 'tarefa',
};

const GROUP_LABEL = { race: 'Corrida', task: 'Tarefa' } as const;

export function layoutLineage(sessions: readonly MapSession[]): MapLayout {
  const tree = lineageTree(sessions as SessionInfo[]);
  const byId = new Map(sessions.map((s) => [s.id, s]));

  // Só se desenha o que está ligado: arestas, sessões sem pai com origem e grupos com 2 ou mais.
  const connected = new Set<string>();
  for (const edge of tree.edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  for (const item of tree.detached) connected.add(item.id);
  const groups = tree.groups.filter((g) => g.members.length >= 2);
  for (const group of groups) for (const id of group.members) connected.add(id);

  const stubs = new Map(tree.detached.map((d) => [d.id, d]));
  const rootSet = new Set(tree.roots.filter((id) => connected.has(id)));

  // As raízes, com as de um mesmo grupo (pistas de uma corrida, tarefas) lado a lado.
  const rootOrder: string[] = [];
  const placed = new Set<string>();
  for (const id of tree.roots) {
    if (!rootSet.has(id) || placed.has(id)) continue;
    rootOrder.push(id);
    placed.add(id);
    for (const group of groups) {
      if (!group.members.includes(id)) continue;
      for (const mate of group.members) {
        if (rootSet.has(mate) && !placed.has(mate)) {
          rootOrder.push(mate);
          placed.add(mate);
        }
      }
    }
  }

  const widths = new Map<string, number>();
  const widthOf = (id: string): number => {
    const known = widths.get(id);
    if (known !== undefined) return known;
    const kids = tree.children[id] ?? [];
    const own = kids.length
      ? kids.reduce((sum, kid) => sum + widthOf(kid), 0) + GAP_X * (kids.length - 1)
      : NODE_W;
    const width = Math.max(NODE_W, own);
    widths.set(id, width);
    return width;
  };

  const positions = new Map<string, { x: number; depth: number }>();
  const put = (id: string, left: number, depth: number): void => {
    const kids = tree.children[id] ?? [];
    if (kids.length === 0) {
      positions.set(id, { x: left + (widthOf(id) - NODE_W) / 2, depth });
      return;
    }
    let cursor = left;
    for (const kid of kids) {
      put(kid, cursor, depth + 1);
      cursor += widthOf(kid) + GAP_X;
    }
    const first = positions.get(kids[0] ?? '');
    const last = positions.get(kids[kids.length - 1] ?? '');
    const center = first && last ? (first.x + last.x) / 2 : left;
    positions.set(id, { x: center, depth });
  };

  let cursor = PAD;
  for (const id of rootOrder) {
    put(id, cursor, 0);
    cursor += widthOf(id) + GAP_X * 2;
  }

  const yOf = (depth: number) => TOP + depth * (NODE_H + GAP_Y);
  const nodes: MapNode[] = [...positions.entries()]
    .map(([id, at]) => {
      const session = byId.get(id);
      const stub = stubs.get(id);
      return {
        id,
        title: session?.title ?? id,
        agent: session?.agent ?? '',
        state: session?.state ?? 'idle',
        x: at.x,
        y: yOf(at.depth),
        depth: at.depth,
        stub: stub ? { kind: stub.kind, parentId: stub.parentId } : null,
      } satisfies MapNode;
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const nodeOf = new Map(nodes.map((n) => [n.id, n]));

  const edges: MapEdge[] = [];
  for (const edge of tree.edges) {
    const from = nodeOf.get(edge.from);
    const to = nodeOf.get(edge.to);
    if (!from || !to) continue;
    const px = from.x + NODE_W / 2;
    const py = from.y + NODE_H;
    const cx = to.x + NODE_W / 2;
    const cy = to.y;
    const mid = py + (cy - py) / 2;
    edges.push({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      ...(edge.turnId ? { turnId: edge.turnId } : {}),
      label: EDGE_LABEL[edge.kind],
      points:
        px === cx
          ? [
              [px, py],
              [cx, cy],
            ]
          : [
              [px, py],
              [px, mid],
              [cx, mid],
              [cx, cy],
            ],
      labelAt: { x: cx, y: cy - GAP_Y / 4 },
    });
  }

  const clusters: MapCluster[] = groups.flatMap((group) => {
    const members = group.members.flatMap((id) => nodeOf.get(id) ?? []);
    if (members.length < 2) return [];
    const left = Math.min(...members.map((n) => n.x)) - GROUP_PAD;
    const right = Math.max(...members.map((n) => n.x + NODE_W)) + GROUP_PAD;
    const top = Math.min(...members.map((n) => n.y)) - GROUP_PAD - 20;
    const bottom = Math.max(...members.map((n) => n.y + NODE_H)) + GROUP_PAD;
    return [
      {
        kind: group.kind,
        id: group.id,
        label: GROUP_LABEL[group.kind],
        x: left,
        y: top,
        w: right - left,
        h: bottom - top,
        members: members.map((n) => n.id),
      },
    ];
  });

  const width = nodes.length ? Math.max(...nodes.map((n) => n.x + NODE_W)) + PAD : 0;
  const height = nodes.length ? Math.max(...nodes.map((n) => n.y + NODE_H)) + PAD : 0;
  const loose = sessions.filter((s) => !connected.has(s.id)).length;
  return { nodes, edges, clusters, width, height, loose, empty: nodes.length === 0 };
}

/** O caminho de um cotovelo para um `<path d>` do SVG (só linhas retas). */
export function edgePath(points: readonly [number, number][]): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');
}

/** Os projetos que têm alguma ligação para mostrar, pela ordem da lista. */
export function projectsWithLinks(
  projects: readonly { id: string }[],
  sessions: readonly MapSession[],
): string[] {
  return projects
    .filter((p) => !layoutLineage(sessions.filter((s) => s.projectId === p.id)).empty)
    .map((p) => p.id);
}

/** O projeto que o Mapa abre por omissão: o ativo se tiver ligações, senão o primeiro que tenha. */
export function defaultMapProject(
  active: string | null,
  linked: readonly string[],
  all: readonly string[],
): string | null {
  if (active && linked.includes(active)) return active;
  return linked[0] ?? (active && all.includes(active) ? active : (all[0] ?? null));
}

/**
 * As primeiras linhas da primeira mensagem do utilizador de uma sessão (o texto da passagem),
 * para o rato mostrar o que foi passado. null se não houver.
 */
export function handoffPreview(
  turns: readonly Turn[],
  maxLines = 3,
  maxChars = 280,
): string | null {
  const first = turns.find((t) => t.role === 'user');
  const text = first?.blocks.find((b) => b.kind === 'text');
  if (!text || text.kind !== 'text') return null;
  const lines = text.text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, maxLines);
  if (lines.length === 0) return null;
  const joined = lines.join('\n');
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
}
