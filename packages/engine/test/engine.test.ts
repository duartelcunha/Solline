import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { EngineEvent, ResponseEnvelope } from '@solline/protocol';
import { ClaudeSdkAdapter, Engine } from '../src/index.ts';
import { fakeQuery, loadFixture, waitFor } from './helpers.ts';

function fakeEngine(
  events: EngineEvent[] = [],
  extra: { models?: ModelInfo[]; fixture?: string } = {},
) {
  const fakes: ReturnType<typeof fakeQuery>[] = [];
  const engine = new Engine({
    emit: (event) => events.push(event),
    adapters: {
      claude: (options, sink) => {
        const fake = fakeQuery(loadFixture(extra.fixture ?? 'edit-with-permission'), extra);
        fakes.push(fake);
        return new ClaudeSdkAdapter(
          { ...options, queryFn: fake.queryFn, loadSettings: false },
          sink,
        );
      },
    },
  });
  return { engine, fakes };
}

let next = 0;
function call(engine: Engine, command: string, payload: unknown): Promise<ResponseEnvelope> {
  return engine.handle({ kind: 'request', id: `r${++next}`, command, payload });
}

async function start(engine: Engine, payload: Record<string, unknown> = {}): Promise<string> {
  const created = await call(engine, 'session.start', {
    projectId: 'p',
    agent: 'claude',
    cwd: tmpdir(),
    trusted: true,
    ...payload,
  });
  if (!created.ok) throw new Error(created.error.message);
  return (created.result as { session: { id: string } }).session.id;
}

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
    // O session.create é do main (troca o projeto pela pasta); o motor só aceita session.start.
    expect(
      await engine.handle({
        kind: 'request',
        id: 'r5',
        command: 'session.create',
        payload: { projectId: 'p', agent: 'claude' },
      }),
    ).toEqual({ ...invalid, id: 'r5' });
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

  it('cria uma sessão, envia, recebe eventos validados e responde a uma permissão', async () => {
    const events: EngineEvent[] = [];
    const { engine, fakes } = fakeEngine(events);
    const sessionId = await start(engine);
    expect(fakes[0]!.options().permissionMode).toBe('default');
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

  it('a pasta da sessão tem de ser absoluta e existir', async () => {
    const { engine } = fakeEngine();
    await expect(start(engine, { cwd: 'relativa' })).rejects.toThrow('caminho absoluto');
    await expect(
      start(engine, { cwd: path.join(tmpdir(), 'nao-existe-solline-xyz') }),
    ).rejects.toThrow('já não existe');
  });

  it('o pedido de arranque é estrito: só os campos do contrato passam', async () => {
    const { engine } = fakeEngine();
    await expect(start(engine, { extra: true })).rejects.toThrow();
  });

  it('recusa modos que o agente não tem, no arranque e depois', async () => {
    const { engine, fakes } = fakeEngine();
    await expect(start(engine, { mode: 'bypassPermissions' })).rejects.toThrow('Modo desconhecido');
    const sessionId = await start(engine, { mode: 'plan' });
    expect(fakes.at(-1)!.options().permissionMode).toBe('plan');
    const bypass = await call(engine, 'session.setMode', { sessionId, mode: 'bypassPermissions' });
    expect(bypass).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('Modo') },
    });
    expect(fakes.at(-1)!.calls).toEqual([]);
    await engine.dispose();
  });

  it('recusa modelos e effort que o agente não anunciou', async () => {
    const { engine, fakes } = fakeEngine();
    const sessionId = await start(engine, { model: 'haiku' });
    const model = await call(engine, 'session.setModel', { sessionId, model: 'gpt-6' });
    expect(model).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('Modelo') },
    });
    // O Haiku da fixture só tem low, medium e high.
    const effort = await call(engine, 'session.setEffort', { sessionId, effort: 'max' });
    expect(effort).toMatchObject({ ok: false, error: { message: expect.stringContaining('max') } });
    const ok = await call(engine, 'session.setEffort', { sessionId, effort: 'high' });
    expect(ok.ok).toBe(true);
    expect(fakes[0]!.calls.map((c) => c.method)).toEqual(['applyFlagSettings']);
    await engine.dispose();
  });

  it('um texto gigante não passa', async () => {
    const { engine } = fakeEngine();
    const sessionId = await start(engine);
    const big = await call(engine, 'session.send', { sessionId, text: 'x'.repeat(200_001) });
    expect(big.ok).toBe(false);
    await engine.dispose();
  });

  it('Auto pedido num modelo sem Auto volta ao modo por omissão', async () => {
    const { engine, fakes } = fakeEngine([], {
      models: [
        {
          value: 'haiku',
          displayName: 'Haiku',
          description: 'Haiku 5.5',
          supportsEffort: false,
        },
      ],
    });
    const created = await call(engine, 'session.start', {
      projectId: 'p',
      agent: 'claude',
      cwd: tmpdir(),
      trusted: true,
      mode: 'auto',
    });
    expect(created).toMatchObject({
      ok: true,
      result: { session: { settings: { mode: 'default' } } },
    });
    expect(fakes[0]!.calls).toEqual([{ method: 'setPermissionMode', args: ['default'] }]);
    await engine.dispose();
  });
});
