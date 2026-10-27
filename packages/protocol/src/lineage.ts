import type { SessionInfo, SessionOrigin } from './conversation.ts';

/**
 * A linhagem das sessões, para o Mapa: quem nasceu de quem. Função pura sobre as sessões
 * abertas; só usa ids (a origem de cada sessão), nunca conteúdo.
 *
 * - handoff, fork, ask e delegate: filha da sessão de origem (`origin.sessionId`); ask é a consulta
 *   que um agente abriu (só de leitura) e delegate a tarefa que um agente entregou.
 * - part: filha da sessão que lhe entregou o resultado, se existir; a parte também pertence
 *   ao grupo da sua corrida.
 * - lane: sem pai de sessão; só pertence ao grupo da sua corrida.
 * - task: sem pai de sessão; pertence ao grupo da sua tarefa.
 *
 * Um pai que já não existe (fechado, desconhecido) não parte nada: a sessão passa a raiz mas fica
 * em `detached` com o que a origem dizia. Ciclos (dados estragados) partem-se na sessão que vem
 * primeiro na lista, que passa a raiz.
 */
export type LineageKind = NonNullable<SessionOrigin['kind']>;

export interface LineageEdge {
  from: string;
  to: string;
  kind: LineageKind;
  /** O turno de onde partiu (numa bifurcação ou passagem). */
  turnId?: string;
}

export interface LineageGroup {
  kind: 'race' | 'task';
  /** O id da corrida ou da tarefa. */
  id: string;
  /** As sessões do grupo, pela ordem da lista. */
  members: string[];
}

export interface LineageDetached {
  /** A sessão que ficou sem pai. */
  id: string;
  kind: LineageKind;
  /** O pai que a origem nomeia e já não está na lista (ou foi o corte de um ciclo). */
  parentId: string;
  turnId?: string;
}

export interface LineageTree {
  /** As sessões sem pai (incluindo as sem origem), pela ordem da lista. */
  roots: string[];
  /** Cada sessão (mesmo sem filhos) com os ids dos filhos, pela ordem da lista. */
  children: Record<string, string[]>;
  edges: LineageEdge[];
  groups: LineageGroup[];
  detached: LineageDetached[];
}

const PARENT_KINDS = new Set<LineageKind>(['handoff', 'fork', 'part', 'ask', 'delegate']);

export function lineageTree(sessions: readonly SessionInfo[]): LineageTree {
  const byId = new Map<string, SessionInfo>();
  for (const session of sessions) if (!byId.has(session.id)) byId.set(session.id, session);
  const order = [...byId.keys()];
  const position = new Map(order.map((id, index) => [id, index]));
  const at = (id: string) => position.get(id) ?? 0;

  // Quem é o pai de quem, antes de cortar ciclos.
  const link = new Map<string, LineageEdge>();
  const detached = new Map<string, LineageDetached>();
  for (const [id, session] of byId) {
    const origin = session.origin;
    if (!origin || !PARENT_KINDS.has(origin.kind) || !origin.sessionId) continue;
    // Uma sessão não é pai de si própria (e não há nada a mostrar sobre isso).
    if (origin.sessionId === id) continue;
    const turn = origin.turnId ? { turnId: origin.turnId } : {};
    if (byId.has(origin.sessionId))
      link.set(id, { from: origin.sessionId, to: id, kind: origin.kind, ...turn });
    else detached.set(id, { id, kind: origin.kind, parentId: origin.sessionId, ...turn });
  }

  // Cortar ciclos: em cada um, a sessão que vem primeiro na lista passa a raiz.
  const done = new Set<string>();
  for (const start of order) {
    const path: string[] = [];
    const inPath = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined && !done.has(current)) {
      if (inPath.has(current)) {
        const cycle = path.slice(path.indexOf(current));
        const first = cycle.reduce((a, b) => (at(b) < at(a) ? b : a));
        const cut = link.get(first);
        if (cut) {
          link.delete(first);
          detached.set(first, {
            id: first,
            kind: cut.kind,
            parentId: cut.from,
            ...(cut.turnId ? { turnId: cut.turnId } : {}),
          });
        }
        break;
      }
      inPath.add(current);
      path.push(current);
      current = link.get(current)?.from;
    }
    for (const id of path) done.add(id);
  }

  const children: Record<string, string[]> = Object.fromEntries(order.map((id) => [id, []]));
  const edges: LineageEdge[] = [];
  for (const id of order) {
    const edge = link.get(id);
    if (!edge) continue;
    children[edge.from]?.push(id);
    edges.push(edge);
  }
  // As arestas ficam pela ordem dos pais (e dos filhos dentro de cada um), estável para desenhar.
  edges.sort((a, b) => at(a.from) - at(b.from) || at(a.to) - at(b.to));

  const groups = new Map<string, LineageGroup>();
  for (const [id, session] of byId) {
    const origin = session.origin;
    let group: Pick<LineageGroup, 'kind' | 'id'> | undefined;
    if (origin?.kind === 'lane' || origin?.kind === 'part') {
      const raceId = origin.raceId ?? session.raceId;
      if (raceId) group = { kind: 'race', id: raceId };
    } else if (origin?.kind === 'task' && origin.taskId) {
      group = { kind: 'task', id: origin.taskId };
    }
    if (!group) continue;
    const key = `${group.kind}\0${group.id}`;
    const existing = groups.get(key);
    if (existing) existing.members.push(id);
    else groups.set(key, { ...group, members: [id] });
  }

  return {
    roots: order.filter((id) => !link.has(id)),
    children,
    edges,
    groups: [...groups.values()],
    detached: order.flatMap((id) => detached.get(id) ?? []),
  };
}
