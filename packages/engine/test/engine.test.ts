import { describe, expect, it } from 'vitest';
import { Engine, SessionManager } from '../src/index.ts';

describe('SessionManager', () => {
  it('arranca sem sessões', async () => {
    const sessions = new SessionManager();
    expect(sessions.list()).toEqual([]);
    expect(sessions.size).toBe(0);
    await sessions.disposeAll();
  });
});

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

  it('recusa comandos desconhecidos sem rebentar', async () => {
    const engine = new Engine();
    const response = await engine.handle({ kind: 'request', id: 'r2', command: 'nope' });
    expect(response).toEqual({
      kind: 'response',
      id: 'r2',
      ok: false,
      error: { message: 'Pedido inválido' },
    });
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
      id: 'r3',
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
      id: 'r4',
      command: 'engine.sdkCheck',
      payload: {},
    });
    expect(response).toEqual({
      kind: 'response',
      id: 'r4',
      ok: false,
      error: { message: 'sem login' },
    });
  });
});
