import { describe, expect, it } from 'vitest';
import type { Block, Turn } from '@solline/protocol';
import { reduce, waitFor } from '../helpers.ts';
import { ANSWERS, HARNESSES, type ScenarioName } from './harness.ts';

/**
 * O contrato que todos os agentes cumprem, visto pela interface: os mesmos cenários dão
 * conversas com a mesma forma, seja qual for o transporte.
 */
const cases = HARNESSES.flatMap((h) => h.scenarios.map((s) => [h.agent, s, h] as const));

function blocks(turns: Turn[], kind: Block['kind']): Block[] {
  return turns.flatMap((t) => t.blocks.filter((b) => b.kind === kind));
}

describe.each(cases)('%s: %s', (_agent, scenario: ScenarioName, harness) => {
  it('cumpre o contrato da conversa', async () => {
    const { adapter, sink } = harness.open(scenario);
    const started = await adapter.start();
    expect(started.capabilities.models.length).toBeGreaterThan(0);
    expect(Array.isArray(started.capabilities.effortOrder)).toBe(true);

    const answer = ANSWERS[scenario];
    const asked = answer ? sink.nextAsk() : null;
    await adapter.send('olá');
    if (asked && answer) {
      const request = await asked;
      expect(adapter.answerPermission(request.id, answer)).toBe(true);
    }
    await waitFor(() => sink.deltas.some((d) => d.type === 'turn.end'));
    await waitFor(() => sink.states.at(-1)?.state === 'idle');

    const turns = reduce(sink.deltas);
    // A vez do utilizador vem antes da do agente e cada uma tem o seu papel.
    expect(turns[0]?.role).toBe('user');
    expect(turns.some((t) => t.role === 'assistant')).toBe(true);
    // Nenhuma ferramenta fica a correr depois do fim do turno.
    for (const tool of blocks(turns, 'tool')) {
      expect(tool.kind === 'tool' && tool.state).not.toBe('running');
    }
    const end = sink.deltas.find((d) => d.type === 'turn.end');
    expect(end).toMatchObject({ outcome: 'done' });

    const asks = sink.asks.map((a) => a.request);
    if (!answer) {
      expect(asks).toEqual([]);
      const text = blocks(turns, 'text')
        .map((b) => (b.kind === 'text' ? b.text : ''))
        .join('');
      expect(text.trim().length).toBeGreaterThan(0);
    } else {
      expect(asks).toHaveLength(1);
      const resolved = blocks(turns, 'permission')[0];
      expect(resolved).toMatchObject({
        status: answer.decision === 'deny' ? 'denied' : 'allowed',
      });
    }
    await adapter.close();
  });
});
