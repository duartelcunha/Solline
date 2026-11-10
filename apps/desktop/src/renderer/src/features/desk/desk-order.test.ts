import { describe, expect, it } from 'vitest';
import type { Turn } from '@solline/protocol';
import { countNeedsYou, deskOrder, lastAction, pendingAsk } from './desk-order.ts';

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
    const withClosed = deskOrder([
      { id: 'live', state: 'idle' as const },
      { id: 'done', state: 'running' as const, archived: true },
    ]);
    expect(withClosed.map((s) => s.id)).toEqual(['live', 'done']);
  });

  it('conta quem precisa de ti e deixa de fora a sessão arquivada', () => {
    expect(countNeedsYou('')).toBe(0);
    expect(countNeedsYou('s1:needs-you:0')).toBe(1);
    expect(countNeedsYou('s1:needs-you:0|s2:running:0|s3:needs-you:1')).toBe(1);
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
