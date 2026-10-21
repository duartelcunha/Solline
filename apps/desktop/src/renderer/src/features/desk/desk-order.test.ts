import { describe, expect, it } from 'vitest';
import type { Turn } from '@solline/protocol';
import { deskOrder, lastAction, pendingAsk } from './desk-order.ts';

describe('a mesa', () => {
  it('ordena por urgência e, no mesmo estado, mantém a ordem de chegada', () => {
    const order = deskOrder([
      { id: 'a', state: 'idle' as const },
      { id: 'b', state: 'running' as const },
      { id: 'c', state: 'needs-you' as const },
      { id: 'd', state: 'error' as const },
      { id: 'e', state: 'running' as const },
    ]);
    expect(order.map((s) => s.id)).toEqual(['c', 'b', 'e', 'd', 'a']);
  });

  it('a última ação é a ferramenta mais recente ou a primeira linha do texto', () => {
    const turns: Turn[] = [
      {
        id: 'u',
        role: 'user',
        blocks: [{ kind: 'text', id: 't0', text: 'olá', parentToolId: null }],
      },
      {
        id: 'a',
        role: 'assistant',
        blocks: [{ kind: 'text', id: 't1', text: 'Vou ler.\nDepois edito.', parentToolId: null }],
      },
    ];
    expect(lastAction(turns)).toBe('Vou ler.');
    expect(lastAction([])).toBeNull();
    expect(pendingAsk(turns)).toBeNull();
  });
});
