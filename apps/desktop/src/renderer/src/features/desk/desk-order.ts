import type { AskBlock, SessionState, Turn } from '@solline/protocol';

/** A ordem da mesa: primeiro o que precisa de ti, depois o que trabalha, o que caiu e o parado. */
const RANK: Record<SessionState, number> = {
  'needs-you': 0,
  running: 1,
  starting: 1,
  error: 2,
  idle: 3,
};

/**
 * Ordena por urgência. Dentro do mesmo estado mantém a ordem de chegada (a mais recente
 * primeiro), para os cartões não andarem às voltas sem razão.
 */
export function deskOrder<T extends { id: string; state: SessionState; archived?: boolean }>(
  sessions: readonly T[],
): T[] {
  const rank = (session: T) => (session.archived ? 4 : RANK[session.state]);
  return sessions
    .map((s, index) => ({ s, index }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.index - b.index)
    .map(({ s }) => s);
}

/** A última coisa que o agente fez, numa linha: a ferramenta ou o começo do texto. */
export function lastAction(turns: readonly Turn[]): string | null {
  for (let t = turns.length - 1; t >= 0; t--) {
    const turn = turns[t];
    if (!turn || turn.role !== 'assistant') continue;
    for (let b = turn.blocks.length - 1; b >= 0; b--) {
      const block = turn.blocks[b];
      if (!block) continue;
      if (block.kind === 'tool') return block.summary;
      if (block.kind === 'text' && block.text.trim()) {
        return block.text.trim().split('\n')[0]?.slice(0, 120) ?? null;
      }
    }
  }
  return null;
}

/** O pedido ainda à espera de resposta, se houver. */
export function pendingAsk(turns: readonly Turn[]): AskBlock | null {
  for (let t = turns.length - 1; t >= 0; t--) {
    const turn = turns[t];
    if (!turn) continue;
    for (let b = turn.blocks.length - 1; b >= 0; b--) {
      const block = turn.blocks[b];
      if (
        block &&
        (block.kind === 'permission' || block.kind === 'plan' || block.kind === 'question') &&
        block.status === 'pending'
      )
        return block;
    }
  }
  return null;
}
