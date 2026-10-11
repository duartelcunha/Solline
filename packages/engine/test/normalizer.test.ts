import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ConversationDelta, ToolBlock } from '@solline/protocol';
import { ClaudeNormalizer, toolSummary } from '../src/index.ts';
import { loadFixture, messagesOf, reduce } from './helpers.ts';

function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

function run(
  name: string,
  prompt = 'pedido',
): { deltas: ConversationDelta[]; normalizer: ClaudeNormalizer } {
  const normalizer = new ClaudeNormalizer({ newId: ids() });
  const deltas = [...normalizer.userTurn('user-1', prompt)];
  for (const message of messagesOf(loadFixture(name))) deltas.push(...normalizer.push(message));
  return { deltas, normalizer };
}

describe('ClaudeNormalizer com mensagens reais', () => {
  it('leitura, edição com permissão e resposta final num só turno do agente', () => {
    const { deltas } = run('edit-with-permission');
    const turns = reduce(deltas);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    const assistant = turns[1]!;
    const tools = assistant.blocks.filter((b): b is ToolBlock => b.kind === 'tool');
    expect(tools.map((t) => [t.name, t.state, t.summary])).toEqual([
      ['Read', 'ok', 'Ler notes.txt'],
      ['Edit', 'ok', 'Editar notes.txt'],
    ]);
    expect(tools[0]!.output).toContain('The quick alpha fox.');
    expect(tools[1]!.input).toMatchObject({
      old_string: expect.stringContaining('alpha'),
      new_string: expect.stringContaining('beta'),
    });
    const text = assistant.blocks.filter((b) => b.kind === 'text');
    expect(text).toHaveLength(1);
    expect(text[0]).toMatchObject({ text: expect.stringMatching(/beta/) });
    expect(deltas.at(-1)).toEqual({ type: 'turn.end', turnId: assistant.id, outcome: 'done' });
  });

  it('o texto em streaming bate certo com a mensagem completa', () => {
    const { deltas } = run('plain-answer');
    const appended = deltas
      .filter((d) => d.type === 'block.append')
      .map((d) => (d.type === 'block.append' ? d.text : ''))
      .join('');
    const finalText = reduce(deltas)[1]!.blocks.find((b) => b.kind === 'text');
    expect(appended.length).toBeGreaterThan(0);
    expect(finalText).toMatchObject({ text: appended });
    expect(appended).toMatch(/\*\*.+\*\*/);
  });

  it('o thinking chega em streaming e fecha como done', () => {
    const turns = reduce(run('thinking').deltas);
    const thinking = turns[1]!.blocks.find((b) => b.kind === 'thinking');
    expect(thinking).toMatchObject({ done: true });
    expect(thinking?.kind === 'thinking' && thinking.text.length).toBeGreaterThan(10);
  });

  it('uma edição recusada fica como ferramenta com erro', () => {
    const turns = reduce(run('denied-edit').deltas);
    const edit = turns[1]!.blocks.find((b) => b.kind === 'tool' && b.name === 'Edit');
    expect(edit).toMatchObject({ state: 'error', output: 'The user refused this action.' });
  });

  it('o init dá o modelo, o modo e o id da sessão do agente', () => {
    const { deltas } = run('edit-with-permission');
    expect(deltas).toContainEqual({
      type: 'settings',
      settings: { model: 'claude-haiku-5-5', mode: 'default' },
    });
    expect(deltas.some((d) => d.type === 'meta' && d.agentSessionId.length > 0)).toBe(true);
  });

  it('o custo é o último total reportado, com o uso por modelo', () => {
    const records = messagesOf(loadFixture('edit-with-permission'));
    const result = records.find((m) => m.type === 'result');
    const { deltas } = run('edit-with-permission');
    const usage = deltas.filter((d) => d.type === 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      usage: { costUsd: result?.type === 'result' ? result.total_cost_usd : -1 },
    });
    expect(usage[0]?.type === 'usage' && usage[0].usage.models?.[0]?.model).toBe(
      'claude-haiku-5-5',
    );
  });

  it('um resultado com erro deixa um aviso e fecha o turno com erro', () => {
    const normalizer = new ClaudeNormalizer({ newId: ids() });
    normalizer.userTurn('u', 'olá');
    const deltas = normalizer.push({
      type: 'result',
      subtype: 'error_during_execution',
      errors: [],
      is_error: true,
      total_cost_usd: 0,
      modelUsage: {},
    } as unknown as SDKMessage);
    expect(deltas).toContainEqual(
      expect.objectContaining({
        type: 'block.upsert',
        block: expect.objectContaining({ kind: 'notice', tone: 'error' }),
      }),
    );
    expect(deltas.at(-1)).toMatchObject({ type: 'turn.end', outcome: 'error' });
  });

  it('depois de interromper, o fim do turno é "interrupted" com um aviso calmo', () => {
    const normalizer = new ClaudeNormalizer({ newId: ids() });
    normalizer.userTurn('u', 'olá');
    normalizer.markInterrupted();
    const deltas = normalizer.push({
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['aborted'],
      is_error: true,
      total_cost_usd: 0.001,
      modelUsage: {},
    } as unknown as SDKMessage);
    expect(deltas).toContainEqual(
      expect.objectContaining({ block: expect.objectContaining({ kind: 'notice', tone: 'info' }) }),
    );
    expect(deltas.at(-1)).toMatchObject({ type: 'turn.end', outcome: 'interrupted' });
  });

  it('mensagens que não conhece não partem nada', () => {
    const normalizer = new ClaudeNormalizer();
    expect(normalizer.push({ type: 'rate_limit_event' } as unknown as SDKMessage)).toEqual([]);
    expect(
      normalizer.push({ type: 'system', subtype: 'commands_changed' } as unknown as SDKMessage),
    ).toEqual([]);
  });
});

describe('toolSummary', () => {
  it('resume cada ferramenta numa linha', () => {
    expect(toolSummary('Bash', { command: 'npm test', description: 'Correr os testes' })).toBe(
      'Correr os testes',
    );
    expect(toolSummary('Bash', { command: 'npm test' })).toBe('Correr npm test');
    expect(toolSummary('Write', { file_path: '/a/b/c.ts' })).toBe('Escrever c.ts');
    expect(toolSummary('Grep', { pattern: 'TODO' })).toBe('Procurar "TODO"');
    expect(toolSummary('mcp__github__create_issue', {})).toBe('github: create_issue');
    expect(toolSummary('Desconhecida', {})).toBe('Desconhecida');
  });
});
