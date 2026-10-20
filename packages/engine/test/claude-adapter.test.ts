import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@solline/protocol';
import {
  CRASH_MESSAGE,
  ClaudeSdkAdapter,
  SessionManager,
  askBlockFor,
  toPermissionMode,
  toPermissionResult,
} from '../src/index.ts';
import { fakeQuery, loadFixture, recordingSink, reduce, waitFor } from './helpers.ts';

function adapterFor(fixture: string, extra: { mode?: string; model?: string } = {}) {
  const fake = fakeQuery(loadFixture(fixture));
  const sink = recordingSink();
  const adapter = new ClaudeSdkAdapter(
    {
      cwd: 'C:/tmp/proj',
      mode: extra.mode ?? 'default',
      model: extra.model,
      queryFn: fake.queryFn,
      loadSettings: false,
    },
    sink,
  );
  return { fake, sink, adapter };
}

describe('ClaudeSdkAdapter', () => {
  it('arranca com as opções obrigatórias e ambiente limpo', async () => {
    const { fake, adapter, sink } = adapterFor('plain-answer');
    const started = await adapter.start();
    const options = fake.options();
    expect(options.permissionMode).toBe('default');
    expect(options.includePartialMessages).toBe(true);
    expect(options.settingSources).toEqual([]);
    expect(options.env?.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('solline');
    expect(Object.keys(options.env ?? {}).some((k) => /^CLAUDECODE$|^CLAUDE_CODE_/.test(k))).toBe(
      false,
    );
    expect(started.capabilities.models.map((m) => m.id)).toEqual(['default', 'haiku']);
    expect(started.capabilities.modes.map((m) => m.id)).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'auto',
    ]);
    expect(started.capabilities.models[1]?.efforts).toEqual(['low', 'medium', 'high']);
    expect(started.settings.model).toBe('default');
    expect(sink.states.map((s) => s.state)).toEqual(['starting', 'idle']);
    await adapter.close();
  });

  it('pede permissão, espera pela resposta e devolve allow com o input', async () => {
    const { fake, adapter, sink } = adapterFor('edit-with-permission');
    await adapter.start();
    const ask = sink.nextAsk();
    await adapter.send('edita o ficheiro');
    const request = await ask;
    expect(request).toMatchObject({
      kind: 'permission',
      toolName: 'Edit',
      title: 'Editar notes.txt',
      canAlwaysAllow: true,
    });
    expect(sink.states.at(-1)?.state).toBe('needs-you');
    expect(adapter.answerPermission(request.id, { decision: 'allow-once' })).toBe(true);
    await waitFor(() => sink.states.at(-1)?.state === 'idle');
    expect(fake.permissionResults[0]).toMatchObject({
      behavior: 'allow',
      updatedInput: { old_string: expect.any(String) },
    });
    expect(fake.permissionResults[0]).not.toHaveProperty('updatedPermissions');
    const turns = reduce(sink.deltas);
    const answered = turns[1]!.blocks.find((b) => b.kind === 'permission');
    expect(answered).toMatchObject({ status: 'allowed' });
    expect(sink.states.map((s) => s.state)).toEqual([
      'starting',
      'idle',
      'running',
      'needs-you',
      'running',
      'idle',
    ]);
    await waitFor(() =>
      sink.deltas.some((d) => d.type === 'usage' && d.usage.context !== undefined),
    );
    await adapter.close();
  });

  it('"Permitir sempre" devolve as sugestões do agente em updatedPermissions', async () => {
    const { fake, adapter, sink } = adapterFor('edit-with-permission');
    await adapter.start();
    const ask = sink.nextAsk();
    await adapter.send('edita');
    const request = await ask;
    adapter.answerPermission(request.id, { decision: 'allow-always' });
    await waitFor(() => fake.permissionResults.length === 1);
    expect(fake.permissionResults[0]).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
    await adapter.close();
  });

  it('negar devolve deny com mensagem', async () => {
    const { fake, adapter, sink } = adapterFor('edit-with-permission');
    await adapter.start();
    const ask = sink.nextAsk();
    await adapter.send('edita');
    adapter.answerPermission((await ask).id, { decision: 'deny' });
    await waitFor(() => fake.permissionResults.length === 1);
    expect(fake.permissionResults[0]).toEqual({
      behavior: 'deny',
      message: 'The user denied this action.',
    });
    await adapter.close();
  });

  it('modo, modelo e effort vão pelos métodos de controlo e atualizam as definições', async () => {
    const { fake, adapter, sink } = adapterFor('plain-answer');
    await adapter.start();
    await adapter.setMode('plan');
    await adapter.setModel('haiku');
    await adapter.setEffort('low');
    expect(fake.calls).toEqual([
      { method: 'setPermissionMode', args: ['plan'] },
      { method: 'setModel', args: ['haiku'] },
      { method: 'applyFlagSettings', args: [{ effortLevel: 'low' }] },
    ]);
    expect(sink.deltas.filter((d) => d.type === 'settings')).toEqual([
      { type: 'settings', settings: { mode: 'plan' } },
      { type: 'settings', settings: { model: 'haiku' } },
      { type: 'settings', settings: { effort: 'low' } },
    ]);
    await adapter.close();
  });

  it('interromper sem turno a correr não chama o SDK (#444)', async () => {
    const { fake, adapter } = adapterFor('plain-answer');
    await adapter.start();
    await adapter.interrupt();
    expect(fake.calls).toEqual([]);
    await adapter.close();
  });

  it('se o canal cai, a sessão fica em erro com mensagem calma e cancela o pedido aberto', async () => {
    const { fake, adapter, sink } = adapterFor('edit-with-permission');
    await adapter.start();
    const ask = sink.nextAsk();
    await adapter.send('edita');
    await ask;
    fake.crash('Stream closed');
    await waitFor(() => sink.states.at(-1)?.state === 'error');
    expect(sink.states.at(-1)).toEqual({ state: 'error', error: CRASH_MESSAGE });
    const turns = reduce(sink.deltas);
    expect(turns[1]!.blocks.find((b) => b.kind === 'permission')).toMatchObject({
      status: 'cancelled',
    });
    await expect(adapter.send('outra')).rejects.toThrow('não está ligada');
    await adapter.close();
  });
});

describe('modos e effort que chegam ao SDK', () => {
  it('só os modos da Solline passam; bypassPermissions e dontAsk nunca', () => {
    expect(toPermissionMode('plan')).toBe('plan');
    expect(() => toPermissionMode('bypassPermissions')).toThrow('Modo desconhecido');
    expect(() => toPermissionMode('dontAsk')).toThrow('Modo desconhecido');
  });

  it('um modo pedido que não existe cai para default no arranque', async () => {
    const { fake, adapter } = adapterFor('plain-answer', { mode: 'bypassPermissions' });
    await adapter.start();
    expect(fake.options().permissionMode).toBe('default');
    await adapter.close();
  });

  it('setMode e setEffort recusam valores fora da lista sem chamar o SDK', async () => {
    const { fake, adapter } = adapterFor('plain-answer');
    await adapter.start();
    await expect(adapter.setMode('bypassPermissions')).rejects.toThrow('Modo desconhecido');
    await expect(adapter.setEffort('turbo')).rejects.toThrow('Effort desconhecido');
    expect(fake.calls).toEqual([]);
    await adapter.close();
  });
});

describe('pedidos especiais', () => {
  const base = { signal: new AbortController().signal, toolUseID: 'tu1', requestId: 'r1' };

  it('ExitPlanMode vira cartão de plano e aprovar devolve allow', () => {
    const block = askBlockFor('ExitPlanMode', { plan: '1. Ler\n2. Editar' }, base);
    expect(block).toEqual({ kind: 'plan', id: 'r1', plan: '1. Ler\n2. Editar', status: 'pending' });
    const entry = { block, input: { plan: 'x' }, suggestions: undefined };
    expect(toPermissionResult(entry, { decision: 'allow-once' })).toEqual({
      behavior: 'allow',
      updatedInput: { plan: 'x' },
    });
    expect(toPermissionResult(entry, { decision: 'deny' })).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('plan'),
    });
  });

  it('AskUserQuestion vira cartão de pergunta e a resposta vai em updatedInput.answers', () => {
    const input = {
      questions: [
        {
          question: 'Qual?',
          header: 'Lib',
          multiSelect: false,
          options: [
            { label: 'A', description: 'a' },
            { label: 'B', description: 'b' },
          ],
        },
      ],
    };
    const block = askBlockFor('AskUserQuestion', input, base);
    expect(block).toMatchObject({
      kind: 'question',
      questions: [{ question: 'Qual?', options: [{ label: 'A' }, { label: 'B' }] }],
    });
    const result = toPermissionResult(
      { block, input, suggestions: undefined },
      { decision: 'answer', answers: { 'Qual?': 'B' } },
    );
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { ...input, answers: { 'Qual?': 'B' } },
    });
  });

  it('esconde "sempre" quando o agente o proíbe', () => {
    const block = askBlockFor(
      'Bash',
      { command: 'rm -rf x' },
      {
        ...base,
        suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
        suppressAlwaysAllowRule: true,
        defaultToNo: true,
      },
    );
    expect(block).toMatchObject({ kind: 'permission', canAlwaysAllow: false, defaultToNo: true });
  });
});

describe('SessionManager', () => {
  it('liga o adaptador aos eventos da Ponte e retoma com resume', async () => {
    const events: EngineEvent[] = [];
    const fakes: ReturnType<typeof fakeQuery>[] = [];
    const manager = new SessionManager({
      emit: (event) => events.push(event),
      adapters: {
        claude: (options, sink) => {
          const fake = fakeQuery(loadFixture('plain-answer'));
          fakes.push(fake);
          return new ClaudeSdkAdapter(
            { ...options, queryFn: fake.queryFn, loadSettings: false },
            sink,
          );
        },
      },
    });
    const created = await manager.create({
      projectId: 'p',
      agent: 'claude',
      cwd: tmpdir(),
      mode: 'default',
      model: 'haiku',
      effort: 'low',
    });
    const id = created.session.id;
    expect(created.session).toMatchObject({
      state: 'idle',
      settings: { model: 'haiku', effort: 'low', mode: 'default' },
    });
    await manager.send(id, 'O que é um monorepo?');
    await waitFor(() =>
      events.some((e) => e.type === 'session.state' && e.state === 'idle' && events.indexOf(e) > 3),
    );
    const meta = events.find((e) => e.type === 'session.event' && e.delta.type === 'meta');
    const agentSessionId =
      meta?.type === 'session.event' && meta.delta.type === 'meta'
        ? meta.delta.agentSessionId
        : null;
    expect(agentSessionId).toBeTruthy();
    expect(events.some((e) => e.type === 'session.event' && e.delta.type === 'usage')).toBe(true);

    fakes[0]!.crash();
    await manager.resume(id);
    expect(fakes[1]!.options().resume).toBe(agentSessionId);
    expect(fakes[1]!.options().model).toBe('claude-haiku-5-5');
    await manager.disposeAll();
  });

  it('erros de sessão desconhecida são claros', async () => {
    const manager = new SessionManager({
      emit: () => undefined,
      adapters: {
        claude: () => {
          throw new Error('não');
        },
      },
    });
    expect(() => manager.send('x', 'olá')).toThrow('Sessão desconhecida');
  });
});
