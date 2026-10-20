import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { EngineEvent, ResponseEnvelope } from '@solline/protocol';
import {
  ClaudeSdkAdapter,
  DEEPSEEK,
  Engine,
  claudeDefinition,
  profileDefinition,
  registryOf,
  type AgentDefinition,
} from '../src/index.ts';
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

  it('agents.list mostra os agentes do registo e o estado de cada um', async () => {
    const registry = registryOf([
      claudeDefinition({ isolated: true }),
      profileDefinition(DEEPSEEK, { readCredential: async () => false, env: {} }),
    ]);
    const engine = new Engine({ registry });
    const listed = await call(engine, 'agents.list', {});
    expect(listed).toMatchObject({
      ok: true,
      result: {
        agents: [
          {
            id: 'claude',
            label: 'Claude',
            transport: 'claude-sdk',
            experimental: false,
            untrustedProjects: 'allowed',
            status: expect.stringMatching(/^(ready|not-found)$/),
          },
          {
            id: 'claude:deepseek',
            label: 'DeepSeek',
            transport: 'claude-sdk',
            experimental: true,
            status: expect.stringMatching(/^(needs-key|not-found)$/),
          },
        ],
      },
    });
  });

  it('um detect que rebenta aparece como erro, não parte a lista', async () => {
    const broken: AgentDefinition = {
      ...claudeDefinition(),
      id: 'partido',
      detect: () => Promise.reject(new Error('sem PATH')),
    };
    const engine = new Engine({ registry: registryOf([broken]) });
    const listed = await call(engine, 'agents.list', {});
    expect(listed).toMatchObject({
      ok: true,
      result: { agents: [{ id: 'partido', status: 'error', detail: 'sem PATH' }] },
    });
  });

  it('um agente desconhecido não abre sessão', async () => {
    const { engine } = fakeEngine();
    await expect(start(engine, { agent: 'nao-existe' })).rejects.toThrow('Agente desconhecido');
  });

  it('um agente que lê config do projeto não abre em projetos sem confiança', async () => {
    const fakes: ReturnType<typeof fakeQuery>[] = [];
    const strict: AgentDefinition = {
      ...claudeDefinition({ isolated: true }),
      id: 'estrito',
      label: 'Estrito',
      untrustedProjects: 'refused',
      create: (options, sink) => {
        const fake = fakeQuery(loadFixture('plain-answer'));
        fakes.push(fake);
        return new ClaudeSdkAdapter(
          { ...options, queryFn: fake.queryFn, loadSettings: false },
          sink,
        );
      },
    };
    const engine = new Engine({ registry: registryOf([strict]) });
    await expect(start(engine, { agent: 'estrito', trusted: false })).rejects.toThrow(
      'só corre em projetos de confiança',
    );
    expect(fakes).toHaveLength(0);
    await start(engine, { agent: 'estrito', trusted: true });
    expect(fakes).toHaveLength(1);
    await engine.dispose();
  });

  it('setMode recusa um modo que o agente não anuncia (Auto sem suporte)', async () => {
    const { engine, fakes } = fakeEngine([], {
      models: [
        {
          value: 'haiku',
          displayName: 'Haiku',
          description: 'Haiku 5.5',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium'],
        },
      ],
    });
    const sessionId = await start(engine);
    const auto = await call(engine, 'session.setMode', { sessionId, mode: 'auto' });
    expect(auto).toMatchObject({ ok: false, error: { message: expect.stringContaining('Modo') } });
    expect(fakes[0]!.calls).toEqual([]);
    await engine.dispose();
  });

  it('modelo e effort pedidos no arranque têm de existir; senão fecha o agente', async () => {
    const { engine, fakes } = fakeEngine([], {
      models: [
        {
          value: 'haiku',
          displayName: 'Haiku',
          description: 'Haiku 5.5',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium'],
        },
      ],
    });
    await expect(start(engine, { model: 'gpt-6' })).rejects.toThrow('Modelo desconhecido');
    expect(fakes.at(-1)!.closed()).toBe(true);
    await expect(start(engine, { model: 'haiku', effort: 'max' })).rejects.toThrow('effort max');
    expect(fakes.at(-1)!.closed()).toBe(true);
    await expect(start(engine, { effort: 'turbo' })).rejects.toThrow('effort turbo');
    const ok = await call(engine, 'session.start', {
      projectId: 'p',
      agent: 'claude',
      cwd: tmpdir(),
      trusted: true,
      model: 'haiku',
      effort: 'medium',
    });
    expect(ok).toMatchObject({
      ok: true,
      result: { session: { settings: { model: 'haiku', effort: 'medium' } } },
    });
    await engine.dispose();
  });

  it('se a troca de modo falha depois do arranque, o agente é fechado', async () => {
    const fakes: ReturnType<typeof fakeQuery>[] = [];
    const engine = new Engine({
      adapters: {
        claude: (options, sink) => {
          const fake = fakeQuery(loadFixture('plain-answer'), {
            models: [
              {
                value: 'haiku',
                displayName: 'Haiku',
                description: 'Haiku 5.5',
                supportsEffort: true,
                supportedEffortLevels: ['low', 'medium'],
              },
            ],
          });
          fakes.push(fake);
          const adapter = new ClaudeSdkAdapter(
            { ...options, queryFn: fake.queryFn, loadSettings: false },
            sink,
          );
          adapter.setMode = () => Promise.reject(new Error('Mudar o modo: sem resposta'));
          return adapter;
        },
      },
    });
    await expect(start(engine, { mode: 'auto' })).rejects.toThrow('sem resposta');
    expect(fakes[0]!.closed()).toBe(true);
    await engine.dispose();
  });

  it('tirar a confiança fecha a retoma a um agente que lê config do projeto', async () => {
    const fakes: ReturnType<typeof fakeQuery>[] = [];
    const strict: AgentDefinition = {
      ...claudeDefinition({ isolated: true }),
      id: 'estrito',
      label: 'Estrito',
      untrustedProjects: 'refused',
      create: (options, sink) => {
        const fake = fakeQuery(loadFixture('plain-answer'));
        fakes.push(fake);
        return new ClaudeSdkAdapter(
          { ...options, queryFn: fake.queryFn, loadSettings: false },
          sink,
        );
      },
    };
    const events: EngineEvent[] = [];
    const engine = new Engine({ registry: registryOf([strict]), emit: (e) => events.push(e) });
    const sessionId = await start(engine, { agent: 'estrito', trusted: true });
    await call(engine, 'session.send', { sessionId, text: 'olá' });
    await waitFor(() =>
      events.some((e) => e.type === 'session.event' && e.delta.type === 'turn.end'),
    );
    await call(engine, 'projects.trustChanged', { projectId: 'p', trusted: false });
    fakes[0]!.crash();
    const resumed = await call(engine, 'session.resume', { sessionId });
    expect(resumed).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('só corre em projetos de confiança') },
    });
    expect(fakes).toHaveLength(1);
    await engine.dispose();
  });
});
