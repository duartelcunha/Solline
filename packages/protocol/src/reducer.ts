import type { Block, ConversationDelta, Turn } from './conversation.ts';

/**
 * Aplica um delta à lista de turnos e devolve uma lista nova (sem mutar a anterior).
 * É o único sítio que sabe juntar deltas: a interface usa-o no store e o motor nos testes.
 * Deltas de usage, settings e meta não mexem nos turnos.
 */
export function applyDelta(turns: readonly Turn[], delta: ConversationDelta): Turn[] {
  switch (delta.type) {
    case 'turn.start': {
      if (turns.some((turn) => turn.id === delta.turn.id)) return [...turns];
      return [...turns, delta.turn];
    }
    case 'block.upsert':
      return updateTurn(turns, delta.turnId, (blocks) => {
        const index = blocks.findIndex((block) => block.id === delta.block.id);
        if (index === -1) return [...blocks, delta.block];
        const next = [...blocks];
        next[index] = delta.block;
        return next;
      });
    case 'block.append':
      return updateTurn(turns, delta.turnId, (blocks) =>
        blocks.map((block) =>
          block.id === delta.blockId && (block.kind === 'text' || block.kind === 'thinking')
            ? { ...block, text: block.text + delta.text }
            : block,
        ),
      );
    default:
      return [...turns];
  }
}

function updateTurn(
  turns: readonly Turn[],
  turnId: string,
  update: (blocks: Block[]) => Block[],
): Turn[] {
  return turns.map((turn) =>
    turn.id === turnId ? { ...turn, blocks: update(turn.blocks) } : turn,
  );
}
