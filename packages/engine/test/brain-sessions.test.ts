import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCapabilities, EngineEvent } from '@solline/protocol';
import {
  AcpAdapter,
  BRAIN_PIPE_ENV,
  BRAIN_TOKEN_ENV,
  Brain,
  BrainChannel,
  CATALOG,
  ClaudeSdkAdapter,
  CodexAppServerAdapter,
  SessionManager,
  catalogDefinition,
  claudeDefinition,
  codexDefinition,
  fixedMcpCatalog,
  registryOf,
  sourceShimPath,
  withFactories,
  type McpLaunch,
} from '../src/index.ts';
import { Engine } from '../src/engine.ts';
import { DurableJournal } from '../src/recovery/journal.ts';
import type { AgentStartOptions } from '../src/adapters/types.ts';
import { hello } from './brain-client.ts';
import { fakeCodexServer } from './codex-fakes.ts';
import { fakeAcp } from './fakes/acp-transport.ts';
import { fakeQuery, loadFixture, waitFor } from './helpers.ts';

const DOCS: McpLaunch = {
  id: 'docs',
  name: 'docs',
  command: 'C:/node/node.exe',
  args: ['docs.mjs'],
  env: {},
  executesCode: false,
};

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function build(options: { node?: string | null } = {}) {
  const channel = new BrainChannel({ helloTimeoutMs: 300 });
  const warn = vi.fn();
  const brain = new Brain({
    channel,
    shim: sourceShimPath(),
    node: () => (options.node === undefined ? process.execPath : options.node),
    warn,
  });
  const claude: ReturnType<typeof fakeQuery>[] = [];
  const codex: ReturnType<typeof fakeCodexServer>[] = [];
  const acp: ReturnType<typeof fakeAcp>[] = [];
  const started: AgentStartOptions[] = [];
  const events: EngineEvent[] = [];
  const registry = withFactories(
    registryOf([
      claudeDefinition({ isolated: true }),
      codexDefinition(),
      catalogDefinition(CATALOG[0]!),
    ]),
    {
      claude: (start, sink) => {
        started.push(start);
        const fake = fakeQuery(loadFixture('plain-answer'));
        claude.push(fake);
        return new ClaudeSdkAdapter({ ...start, queryFn: fake.queryFn, loadSettings: false }, sink);
      },
      codex: (start, sink) => {
        started.push(start);
        const server = fakeCodexServer();
        codex.push(server);
        return new CodexAppServerAdapter({ ...start, transport: server.transport }, sink);
      },
      [CATALOG[0]!.id]: (start, sink) => {
        started.push(start);
        const fake = fakeAcp();
        acp.push(fake);
        return new AcpAdapter(
          { ...start, label: 'Falso', transport: fake.transport, loginHint: 'x' },
          sink,
        );
      },
    },
  );
  const manager = new SessionManager({
    emit: (event) => events.push(event),
    registry,
    mcp: fixedMcpCatalog([DOCS]),
    brain,
  });
  cleanup.push(async () => {
    await manager.disposeAll();
    await brain.dispose();
  });
  return { manager, channel, brain, warn, claude, codex, acp, started, events };
}

const base = { projectId: 'projeto', cwd: tmpdir(), trusted: true };

/** O servidor "solline" que o Codex recebeu no thread/start. */
function codexBrainConfig(server: ReturnType<typeof fakeCodexServer>) {
  const start = server.received.find(
    (m) => m.method === 'thread/start' || m.method === 'thread/resume',
  ) as { params: { config?: Record<string, unknown> } } | undefined;
  return start?.params.config?.['mcp_servers.solline'] as
    | {
        command: string;
        args: string[];
        env: Record<string, string>;
        default_tools_approval_mode: string;
        tools?: Record<string, { approval_mode: string }>;
      }
    | undefined;
}

type RegisteredTool = { handler: (args: unknown, extra: unknown) => Promise<unknown> };

describe('o cérebro nas sessões: Claude, em processo', () => {
  it('recebe um servidor SDK ao lado dos do catálogo e as ferramentas só de leitura já aprovadas', async () => {
    const { manager, claude, events } = build();
    const { session, capabilities } = await manager.create({
      ...base,
      agent: 'claude',
      mcpServerIds: ['docs'],
    });
    const options = claude[0]!.options();
    const servers = options.mcpServers as Record<string, { type: string; instance?: unknown }>;
    expect(Object.keys(servers).sort()).toEqual(['docs', 'solline']);
    expect(servers.docs).toMatchObject({ type: 'stdio', command: 'C:/node/node.exe' });
    expect(servers.solline).toMatchObject({ type: 'sdk', name: 'solline' });
    // Só as ferramentas de leitura da Solline correm sem pedir autorização.
    expect(options.allowedTools).toBeUndefined();
    const ask = (tool: string) =>
      options.canUseTool!(tool, {}, {
        signal: new AbortController().signal,
        toolUseID: 't1',
        requestId: 'r1',
      } as Parameters<NonNullable<typeof options.canUseTool>>[2]);
    expect(await ask('mcp__solline__solline_context')).toEqual({
      behavior: 'allow',
      updatedInput: {},
    });
    // O resto, incluindo ferramentas de outros servidores, continua a pedir.
    void ask('mcp__docs__run');
    await waitFor(() => events.some((e) => e.type === 'permission.request'));
    expect(events.filter((e) => e.type === 'permission.request')).toHaveLength(1);
    // Os servidores do catálogo continuam a ser só os pedidos: o cérebro não conta.
    expect(session.mcpServers).toEqual(['docs']);
    expect(capabilities.features.brain).toBe(true);
  });

  it('a ferramenta corre com a identidade da sessão', async () => {
    const { manager, claude } = build();
    const { session } = await manager.create({ ...base, agent: 'claude' });
    const servers = claude[0]!.options().mcpServers as Record<string, { instance: object }>;
    const tools = (
      servers.solline!.instance as unknown as { _registeredTools: Record<string, RegisteredTool> }
    )._registeredTools;
    const handler = tools.solline_context!.handler;
    const result = (await handler({}, {})) as { content: { text: string }[]; isError?: boolean };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      project: 'projeto',
      agent: 'claude',
      session: 'Nova sessão',
    });
    expect(result.isError).toBe(false);
    expect(session.id).toBeTruthy();
  });

  it('sem cérebro configurado a sessão fica como era', async () => {
    const plain = new SessionManager({
      emit: () => undefined,
      registry: withFactories(registryOf([claudeDefinition({ isolated: true })]), {
        claude: (start, sink) => {
          const fake = fakeQuery(loadFixture('plain-answer'));
          return new ClaudeSdkAdapter(
            { ...start, queryFn: fake.queryFn, loadSettings: false },
            sink,
          );
        },
      }),
    });
    const { capabilities } = await plain.create({ ...base, agent: 'claude' });
    expect(capabilities.features.brain).toBeUndefined();
    await plain.disposeAll();
  });
});

describe('o cérebro nas sessões: Codex e ACP, pelo shim', () => {
  it('o Codex recebe o shim na config do thread, com o token e o canal desta sessão', async () => {
    const { manager, codex, channel } = build();
    const { capabilities } = await manager.create({ ...base, agent: 'codex', mode: 'ask' });
    const config = codexBrainConfig(codex[0]!);
    expect(config).toMatchObject({
      command: process.execPath,
      args: [sourceShimPath()],
      default_tools_approval_mode: 'prompt',
      tools: { solline_context: { approval_mode: 'approve' } },
    });
    expect(Buffer.from(config!.env[BRAIN_TOKEN_ENV]!, 'base64url').length).toBeGreaterThanOrEqual(
      32,
    );
    expect(config!.env[BRAIN_PIPE_ENV]).toBeTruthy();
    expect(channel.activeTokens).toBe(1);
    expect(capabilities.features.brain).toBe(true);
    // O token abre mesmo o canal desta sessão.
    expect(await hello(config!.env[BRAIN_PIPE_ENV]!, config!.env[BRAIN_TOKEN_ENV]!)).toMatchObject({
      type: 'ready',
    });
  });

  it('o ACP recebe o shim no session/new, com o ambiente como [{name, value}]', async () => {
    const { manager, acp } = build();
    const { capabilities } = await manager.create({ ...base, agent: CATALOG[0]!.id });
    const params = acp[0]!.received.find((m) => m.method === 'session/new')?.params as {
      mcpServers: {
        name: string;
        command: string;
        args: string[];
        env: { name: string; value: string }[];
      }[];
    };
    expect(params.mcpServers).toHaveLength(1);
    const server = params.mcpServers[0]!;
    expect(server).toMatchObject({
      name: 'solline',
      command: process.execPath,
      args: [sourceShimPath()],
    });
    expect(server.env.map((e) => e.name).sort()).toEqual([BRAIN_PIPE_ENV, BRAIN_TOKEN_ENV]);
    expect(capabilities.features.brain).toBe(true);
  });

  it('com servidores do catálogo, o shim vai a seguir e não conta para eles', async () => {
    const { manager, codex } = build();
    const { session } = await manager.create({
      ...base,
      agent: 'codex',
      mode: 'ask',
      mcpServerIds: ['docs'],
    });
    const config = (
      codex[0]!.received.find((m) => m.method === 'thread/start') as {
        params: { config: Record<string, unknown> };
      }
    ).params.config;
    expect(Object.keys(config)).toEqual(['mcp_servers.docs', 'mcp_servers.solline']);
    expect(session.mcpServers).toEqual(['docs']);
  });

  it('sem Node de sistema não há cérebro para estes agentes e a sessão abre na mesma', async () => {
    const { manager, codex, acp, warn } = build({ node: null });
    const first = await manager.create({ ...base, agent: 'codex', mode: 'ask' });
    const second = await manager.create({ ...base, agent: CATALOG[0]!.id });
    expect(codexBrainConfig(codex[0]!)).toBeUndefined();
    expect(first.capabilities.features.brain).toBeUndefined();
    expect(second.capabilities.features.brain).toBeUndefined();
    expect(acp[0]!.received.find((m) => m.method === 'session/new')?.params).toMatchObject({
      mcpServers: [],
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('onde o cérebro fica desligado', () => {
  it('as pistas, as partes e quem resolve a integração não o têm: continuam independentes', async () => {
    const { manager, claude, codex, channel } = build();
    await manager.create({ ...base, agent: 'claude', raceId: 'corrida' });
    await manager.create({
      ...base,
      agent: 'claude',
      origin: { kind: 'lane', raceId: 'corrida' },
    });
    await manager.create({
      ...base,
      agent: 'claude',
      origin: { kind: 'part', raceId: 'divisao' },
    });
    await manager.create({ ...base, agent: 'codex', mode: 'ask', raceId: 'corrida' });
    for (const fake of claude) {
      expect(fake.options().mcpServers).toBeUndefined();
      expect(fake.options().allowedTools).toBeUndefined();
    }
    expect(codexBrainConfig(codex[0]!)).toBeUndefined();
    expect(channel.activeTokens).toBe(0);
  });

  it('as sessões normais, as passagens de testemunho e as bifurcações têm-no', async () => {
    const { manager, claude, channel } = build();
    await manager.create({ ...base, agent: 'claude' });
    await manager.create({
      ...base,
      agent: 'claude',
      origin: { kind: 'handoff', sessionId: 'outra' },
    });
    await manager.create({
      ...base,
      agent: 'claude',
      origin: { kind: 'fork', sessionId: 'outra' },
    });
    await manager.create({ ...base, agent: 'claude', origin: { kind: 'task', taskId: 't' } });
    for (const fake of claude) {
      expect(Object.keys(fake.options().mcpServers ?? {})).toEqual(['solline']);
    }
    expect(channel.activeTokens).toBe(0); // em processo: sem token
  });

  it('um agente sem suporte a MCP por sessão nunca o recebe', async () => {
    const channel = new BrainChannel();
    const brain = new Brain({ channel });
    const created: AgentStartOptions[] = [];
    const capabilities: AgentCapabilities = {
      models: [],
      modes: [],
      effort: false,
      effortOrder: [],
      features: { cost: false, context: false, resume: false, rewind: false },
    };
    const manager = new SessionManager({
      emit: () => undefined,
      brain,
      registry: registryOf([
        {
          id: 'simples',
          label: 'Simples',
          transport: 'acp',
          defaultMode: null,
          staticModes: [],
          untrustedProjects: 'allowed',
          envPolicy: { base: 'no-secrets' },
          detect: async () => ({ status: 'ready' }),
          create: (options) => {
            created.push(options);
            return {
              start: async () => ({
                capabilities,
                settings: { model: null, effort: null, mode: null },
              }),
              send: async () => 'turn',
              interrupt: async () => undefined,
              close: async () => undefined,
              setMode: async () => undefined,
              setModel: async () => undefined,
              answerPermission: () => false,
              capabilities: () => capabilities,
              agentSessionId: () => null,
            };
          },
        },
      ]),
    });
    const { capabilities: result } = await manager.create({ ...base, agent: 'simples' });
    expect(created[0]!.mcpServers).toBeUndefined();
    expect(created[0]!.brain).toBeUndefined();
    expect(result.features.brain).toBeUndefined();
    await manager.disposeAll();
    await brain.dispose();
  });
});

describe('o ciclo de vida dos tokens', () => {
  async function tokenOf(server: ReturnType<typeof fakeCodexServer>) {
    const config = codexBrainConfig(server)!;
    return { pipe: config.env[BRAIN_PIPE_ENV]!, token: config.env[BRAIN_TOKEN_ENV]! };
  }

  it('fechar a sessão invalida o token', async () => {
    const { manager, codex, channel } = build();
    const { session } = await manager.create({ ...base, agent: 'codex', mode: 'ask' });
    const { pipe, token } = await tokenOf(codex[0]!);
    expect(channel.activeTokens).toBe(1);
    await manager.close(session.id, 'discard');
    expect(channel.activeTokens).toBe(0);
    expect(await hello(pipe, token)).toEqual({ type: 'error', message: 'unauthorized' });
  });

  it('retomar arranca o agente de novo com um token novo e o antigo morre', async () => {
    const { manager, codex, channel } = build();
    const { session } = await manager.create({ ...base, agent: 'codex', mode: 'ask' });
    const first = await tokenOf(codex[0]!);
    await manager.resume(session.id);
    expect(codex).toHaveLength(2);
    const second = await tokenOf(codex[1]!);
    expect(second.token).not.toBe(first.token);
    expect(channel.activeTokens).toBe(1);
    expect(await hello(first.pipe, first.token)).toEqual({
      type: 'error',
      message: 'unauthorized',
    });
    expect(await hello(second.pipe, second.token)).toMatchObject({ type: 'ready' });
  });

  it('desligar o motor invalida todos', async () => {
    const { manager, codex, acp, channel } = build();
    await manager.create({ ...base, agent: 'codex', mode: 'ask' });
    await manager.create({ ...base, agent: CATALOG[0]!.id });
    expect(codex).toHaveLength(1);
    expect(acp).toHaveLength(1);
    expect(channel.activeTokens).toBe(2);
    await manager.disposeAll();
    expect(channel.activeTokens).toBe(0);
  });

  it('uma sessão que não arranca não deixa o token vivo', async () => {
    const { manager, codex, channel } = build();
    const starting = manager.create({ ...base, agent: 'codex', mode: 'ask' });
    await starting;
    expect(channel.activeTokens).toBe(1);
    // Uma segunda que falha no arranque (o Codex sem login) devolve o token.
    const broken = fakeCodexServer({ account: { account: null, requiresOpenaiAuth: true } });
    const registry = withFactories(registryOf([codexDefinition()]), {
      codex: (start, sink) =>
        new CodexAppServerAdapter({ ...start, transport: broken.transport }, sink),
    });
    const failing = new SessionManager({
      emit: () => undefined,
      registry,
      brain: new Brain({
        channel,
        shim: sourceShimPath(),
        node: () => process.execPath,
        warn: () => undefined,
      }),
    });
    await expect(failing.create({ ...base, agent: 'codex', mode: 'ask' })).rejects.toThrow();
    expect(channel.activeTokens).toBe(1);
    expect(codex).toHaveLength(1);
  });
});

describe('o token nunca sai do motor', () => {
  it('não está nos eventos nem no resumo da sessão', async () => {
    const { manager, codex, events } = build();
    const { session } = await manager.create({ ...base, agent: 'codex', mode: 'ask' });
    const { pipe, token } = {
      pipe: codexBrainConfig(codex[0]!)!.env[BRAIN_PIPE_ENV]!,
      token: codexBrainConfig(codex[0]!)!.env[BRAIN_TOKEN_ENV]!,
    };
    await manager.send(session.id, 'olá');
    const everything = JSON.stringify([events, session, manager.recovery()]);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(pipe);
    expect(everything).not.toContain(BRAIN_TOKEN_ENV);
  });

  it('não está no estado do motor nem no diário de recuperação', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'solline-brain-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, 'project');
    mkdirSync(project);
    const dataDir = path.join(root, 'data');
    const key = Buffer.alloc(32, 7);
    const starts: AgentStartOptions[] = [];
    const capabilities: AgentCapabilities = {
      models: [],
      modes: [],
      effort: false,
      effortOrder: [],
      features: { cost: false, context: false, resume: true, rewind: false },
    };
    const events: EngineEvent[] = [];
    const engine = new Engine({
      registry: registryOf([
        {
          id: 'scripted',
          label: 'Scripted',
          transport: 'acp',
          defaultMode: null,
          staticModes: [],
          untrustedProjects: 'allowed',
          envPolicy: { base: 'no-secrets' },
          mcp: true,
          brain: 'stdio',
          detect: async () => ({ status: 'ready' }),
          create: (options, sink) => {
            starts.push(options);
            return {
              start: async () => {
                sink.delta({ type: 'meta', agentSessionId: 'historico' });
                return { capabilities, settings: { model: null, effort: null, mode: null } };
              },
              send: async () => 'turn',
              interrupt: async () => undefined,
              close: async () => undefined,
              setMode: async () => undefined,
              setModel: async () => undefined,
              answerPermission: () => false,
              capabilities: () => capabilities,
              agentSessionId: () => 'historico',
            };
          },
        },
      ]),
      dataDir,
      recoveryKey: key,
      isolated: true,
      checkpoints: false,
      checks: false,
      reviewer: false,
      worktrees: false,
      brain: { shim: sourceShimPath(), node: () => process.execPath },
      emit: (event) => events.push(event),
    });
    const started = await engine.handle({
      kind: 'request',
      id: 'a',
      command: 'session.start',
      payload: { projectId: 'project', cwd: project, agent: 'scripted', trusted: true },
    });
    expect(started.ok).toBe(true);
    const launch = starts[0]!.mcpServers?.find((s) => s.name === 'solline');
    const token = launch!.env[BRAIN_TOKEN_ENV]!;
    const pipe = launch!.env[BRAIN_PIPE_ENV]!;
    const snapshot = await engine.handle({
      kind: 'request',
      id: 'b',
      command: 'engine.snapshot',
      payload: {},
    });
    await engine.dispose();
    const journal = new DurableJournal(
      path.join(dataDir, 'recovery', 'engine-v1'),
      (value) => value,
      key,
    );
    const text = JSON.stringify([events, snapshot, journal.records]);
    journal.close();
    expect(journal.records.length).toBeGreaterThan(0);
    expect(text).not.toContain(token);
    expect(text).not.toContain(pipe);
    expect(text).toContain('historico');
  });
});
