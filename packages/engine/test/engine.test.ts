import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@solline/protocol';
import { ClaudeSdkAdapter, Engine } from '../src/index.ts';
import { fakeQuery, loadFixture, waitFor } from './helpers.ts';

describe('Engine', () => {
  it('responde ao engine.ping', async () => {
    const engine = new Engine();
    const response = await engine.handle({
      kind: 'request',
      id: 'r1',
      command: 'engine.ping',
      payload: {},
    });
    expect(response).toMatchObject({ kind: 'response', id: 'r1', ok: true });
    expect(response.ok && response.result).toMatchObject({ pong: true, pid: process.pid });
  });

  it('recusa comandos desconhecidos e os que são do main', async () => {
    const engine = new Engine();
    const invalid = { kind: 'response', ok: false, error: { message: 'Pedido inválido' } };
    expect(await engine.handle({ kind: 'request', id: 'r2', command: 'nope' })).toEqual({
      ...invalid,
      id: 'r2',
    });
    expect(
      await engine.handle({ kind: 'request', id: 'r3', command: 'projects.add', payload: {} }),
    ).toEqual({ ...invalid, id: 'r3' });
  });

  it('valida o payload antes de chegar ao motor', async () => {
    const engine = new Engine();
    const response = await engine.handle({
      kind: 'request',
      id: 'r4',
      command: 'session.send',
      payload: { sessionId: 's', text: '' },
    });
    expect(response.ok).toBe(false);
  });

  it('valida o resultado do sdkCheck e passa o executável', async () => {
    const seen: (string | undefined)[] = [];
    const engine = new Engine({
      claudeExecutable: 'C:\\app\\resources\\app.asar.unpacked\\claude.exe',
      sdkCheck: async (options) => {
        seen.push(options?.claudeExecutable);
        return {
          model: 'claude-haiku',
          apiKeySource: 'none',
          result: 'ok',
          isError: false,
          totalCostUsd: 0.001,
          durationMs: 10,
          claudeExecutable: options?.claudeExecutable ?? null,
        };
      },
    });
    const response = await engine.handle({
      kind: 'request',
      id: 'r5',
      command: 'engine.sdkCheck',
      payload: {},
    });
    expect(response.ok).toBe(true);
    expect(seen).toEqual(['C:\\app\\resources\\app.asar.unpacked\\claude.exe']);
  });

  it('devolve o erro do sdkCheck como resposta falhada', async () => {
    const engine = new Engine({
      sdkCheck: async () => {
        throw new Error('sem login');
      },
    });
    const response = await engine.handle({
      kind: 'request',
      id: 'r6',
      command: 'engine.sdkCheck',
      payload: {},
    });
    expect(response).toEqual({
      kind: 'response',
      id: 'r6',
      ok: false,
      error: { message: 'sem login' },
    });
  });

  it('cria uma sessão, envia, recebe eventos validados e responde a uma permissão', async () => {
    const events: EngineEvent[] = [];
    const engine = new Engine({
      emit: (event) => events.push(event),
      adapters: {
        claude: (options, sink) =>
          new ClaudeSdkAdapter(
            {
              ...options,
              queryFn: fakeQuery(loadFixture('edit-with-permission')).queryFn,
              loadSettings: false,
            },
            sink,
          ),
      },
    });
    const created = await engine.handle({
      kind: 'request',
      id: 'c',
      command: 'session.create',
      payload: { agent: 'claude', cwd: 'C:/p', mode: 'default' },
    });
    expect(created.ok).toBe(true);
    const sessionId = created.ok ? (created.result as { session: { id: string } }).session.id : '';
    await engine.handle({
      kind: 'request',
      id: 's',
      command: 'session.send',
      payload: { sessionId, text: 'edita' },
    });
    await waitFor(() => events.some((e) => e.type === 'permission.request'));
    const request = events.find((e) => e.type === 'permission.request');
    const requestId = request?.type === 'permission.request' ? request.request.id : '';
    const answered = await engine.handle({
      kind: 'request',
      id: 'a',
      command: 'permission.answer',
      payload: { sessionId, requestId, answer: { decision: 'allow-once' } },
    });
    expect(answered.ok).toBe(true);
    await waitFor(() =>
      events.some((e) => e.type === 'session.event' && e.delta.type === 'turn.end'),
    );
    const again = await engine.handle({
      kind: 'request',
      id: 'a2',
      command: 'permission.answer',
      payload: { sessionId, requestId, answer: { decision: 'allow-once' } },
    });
    expect(again).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('já não está') },
    });
    await engine.dispose();
  });
});
