import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MemorySecretStore,
  mcpSecretTarget,
  type AgentCapabilities,
  type EngineEvent,
  type McpServerSpec,
} from '@solline/protocol';
import {
  AcpAdapter,
  CATALOG,
  ClaudeSdkAdapter,
  CodexAppServerAdapter,
  SessionManager,
  UserMcpCatalog,
  catalogDefinition,
  claudeDefinition,
  codexDefinition,
  combinedCatalog,
  fixedMcpCatalog,
  registryOf,
  secretReaderFrom,
  withFactories,
  type McpLaunch,
  type ProbeFn,
} from '../src/index.ts';
import { Engine } from '../src/engine.ts';
import { DurableJournal } from '../src/recovery/journal.ts';
import type { AgentStartOptions } from '../src/adapters/types.ts';
import { toolPrint, toolsFingerprint } from '../src/mcp/spec.ts';
import { fakeCodexServer } from './codex-fakes.ts';
import { fakeAcp } from './fakes/acp-transport.ts';
import { fakeQuery, loadFixture } from './helpers.ts';

const SECRET = 'segredo-de-sessao-987654';
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

function spec(label: string, over: Partial<McpServerSpec> = {}): McpServerSpec {
  return {
    label,
    command: process.execPath,
    args: [`${label}.mjs`],
    env: [
      { name: 'API_TOKEN', secret: true, required: true },
      { name: 'REGIAO', secret: false, required: false, value: 'eu' },
    ],
    source: { kind: 'manual' },
    ...over,
  };
}

/** Um catálogo do utilizador com a sonda trocada: o hash vem da lista que o teste escolher. */
function userCatalog(dataDir?: string, store = new MemorySecretStore()) {
  const control = { tools: ['ler'], fail: '' };
  const probes: string[] = [];
  const probe: ProbeFn = async (target) => {
    probes.push(target.args.join(' '));
    if (control.fail) throw new Error(control.fail);
    const tools = control.tools.map((name) => toolPrint({ name, description: name }));
    return { tools, hash: toolsFingerprint(tools) };
  };
  const make = (override: ProbeFn = probe) =>
    new UserMcpCatalog({
      dataDir,
      secrets: secretReaderFrom(store),
      probe: override,
      node: () => process.execPath,
      builtinIds: async () => ['docs'],
    });
  const user = make();
  const approve = async (id: string, label: string, over: Partial<McpServerSpec> = {}) => {
    await store.set(mcpSecretTarget(id, 'API_TOKEN'), SECRET);
    const added = user.add(id, spec(label, over));
    await user.approve(id, { fingerprint: added.fingerprint });
  };
  return { user, store, control, probes, approve, make };
}

function build(
  options: {
    dataDir?: string;
    store?: MemorySecretStore;
    user?: (env: ReturnType<typeof userCatalog>) => UserMcpCatalog;
  } = {},
) {
  const env = userCatalog(options.dataDir, options.store);
  const user = options.user?.(env) ?? env.user;
  const claude: ReturnType<typeof fakeQuery>[] = [];
  const codex: ReturnType<typeof fakeCodexServer>[] = [];
  const acp: ReturnType<typeof fakeAcp>[] = [];
  const events: EngineEvent[] = [];
  const registry = withFactories(
    registryOf([
      claudeDefinition({ isolated: true }),
      codexDefinition(),
      catalogDefinition(CATALOG[0]!),
    ]),
    {
      claude: (start, sink) => {
        const fake = fakeQuery(loadFixture('plain-answer'));
        claude.push(fake);
        return new ClaudeSdkAdapter({ ...start, queryFn: fake.queryFn, loadSettings: false }, sink);
      },
      codex: (start, sink) => {
        const server = fakeCodexServer();
        codex.push(server);
        return new CodexAppServerAdapter({ ...start, transport: server.transport }, sink);
      },
      [CATALOG[0]!.id]: (start, sink) => {
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
    mcp: combinedCatalog(fixedMcpCatalog([DOCS]), user),
  });
  cleanup.push(() => manager.disposeAll());
  return { manager, claude, codex, acp, events, ...env, user };
}

const base = { projectId: 'projeto', cwd: tmpdir(), trusted: true };

function claudeServers(fake: ReturnType<typeof fakeQuery>) {
  return (fake.options().mcpServers ?? {}) as Record<
    string,
    { command: string; args: string[]; env: Record<string, string> }
  >;
}

function codexServers(server: ReturnType<typeof fakeCodexServer>) {
  const start = server.received.find((m) => m.method === 'thread/start') as
    { params: { config?: Record<string, { env: Record<string, string> }> } } | undefined;
  return start?.params.config ?? {};
}

describe('a escolha do projeto chega a cada sessão nova', () => {
  it('Claude, Codex e ACP recebem o servidor do projeto, e outro projeto não', async () => {
    const { manager, claude, codex, acp, user, approve } = build();
    await approve('srv1', 'ferramentas');
    await user.setProject('projeto', ['srv1']);

    const a = await manager.create({ ...base, agent: 'claude' });
    expect(claudeServers(claude[0]!).ferramentas).toMatchObject({
      command: process.execPath,
      args: ['ferramentas.mjs'],
      env: { API_TOKEN: SECRET, REGIAO: 'eu' },
    });
    expect(a.session.mcpServers).toEqual(['srv1']);
    expect(a.session.mcpSkipped).toBeUndefined();
    // O SDK põe as opções de query() na linha de comando do claude.exe (--mcp-config): os
    // servidores com variáveis chegam depois, por setMcpServers, pelo stdin.
    const raw = claude[0]!.rawOptions();
    expect(JSON.stringify(raw.mcpServers ?? {})).not.toContain(SECRET);
    expect(Object.keys(raw.mcpServers ?? {})).not.toContain('ferramentas');
    expect(claude[0]!.calls.some((c) => c.method === 'setMcpServers')).toBe(true);

    const b = await manager.create({ ...base, agent: 'codex', mode: 'ask' });
    expect(codexServers(codex[0]!)['mcp_servers.ferramentas']).toMatchObject({
      command: process.execPath,
      args: ['ferramentas.mjs'],
      env: { API_TOKEN: SECRET, REGIAO: 'eu' },
    });
    expect(b.session.mcpServers).toEqual(['srv1']);

    const c = await manager.create({ ...base, agent: CATALOG[0]!.id });
    const params = acp[0]!.received.find((m) => m.method === 'session/new')?.params as {
      mcpServers: { name: string; env: { name: string; value: string }[] }[];
    };
    expect(params.mcpServers).toHaveLength(1);
    expect(params.mcpServers[0]).toMatchObject({ name: 'ferramentas' });
    expect(params.mcpServers[0]!.env).toContainEqual({ name: 'API_TOKEN', value: SECRET });
    expect(c.session.mcpServers).toEqual(['srv1']);

    // Outro projeto não escolheu nada.
    const other = await manager.create({ ...base, projectId: 'outro', agent: 'claude' });
    expect(claudeServers(claude[1]!).ferramentas).toBeUndefined();
    expect(other.session.mcpServers).toBeUndefined();
  });

  it('soma-se aos pedidos à mão e não se repete', async () => {
    const { manager, claude, user, approve } = build();
    await approve('srv1', 'ferramentas');
    await user.setProject('projeto', ['srv1']);
    const { session } = await manager.create({
      ...base,
      agent: 'claude',
      mcpServerIds: ['docs', 'srv1'],
    });
    expect(Object.keys(claudeServers(claude[0]!)).sort()).toEqual(['docs', 'ferramentas']);
    expect(session.mcpServers).toEqual(['docs', 'srv1']);
    const both = await manager.create({ ...base, agent: 'claude', mcpServerIds: ['docs'] });
    expect(both.session.mcpServers).toEqual(['docs', 'srv1']);
  });

  it('o catálogo fixo também se escolhe por projeto', async () => {
    const { manager, claude, user } = build();
    await user.setProject('projeto', ['docs']);
    const { session } = await manager.create({ ...base, agent: 'claude' });
    expect(Object.keys(claudeServers(claude[0]!))).toEqual(['docs']);
    expect(session.mcpServers).toEqual(['docs']);
  });

  it('não chega a pistas, partes, consultas só de leitura nem delegações', async () => {
    const { manager, claude, user, approve } = build();
    await approve('srv1', 'ferramentas');
    await user.setProject('projeto', ['srv1']);
    await manager.create({ ...base, agent: 'claude', raceId: 'corrida' });
    await manager.create({ ...base, agent: 'claude', origin: { kind: 'lane', raceId: 'corrida' } });
    await manager.create({ ...base, agent: 'claude', origin: { kind: 'part', raceId: 'divisao' } });
    await manager.create({
      ...base,
      agent: 'claude',
      mode: 'plan',
      origin: { kind: 'ask', sessionId: 'pai' },
    });
    await manager.create({
      ...base,
      agent: 'claude',
      origin: { kind: 'delegate', sessionId: 'pai' },
    });
    expect(claude).toHaveLength(5);
    for (const fake of claude) expect(fake.options().mcpServers).toBeUndefined();
    // Passagens, bifurcações e tarefas são sessões normais.
    for (const kind of ['handoff', 'fork', 'task'] as const) {
      const { session } = await manager.create({
        ...base,
        agent: 'claude',
        origin: { kind, sessionId: 'outra' },
      });
      expect(session.mcpServers, kind).toEqual(['srv1']);
    }
  });

  it('o que não pode entrar fica anotado com a razão e a sessão abre na mesma', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'solline-mcp-skip-'));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const first = userCatalog(dataDir);
    for (const id of ['bom', 'mau', 'mudou']) await first.approve(id, id);
    first.user.add('novo', spec('novo'));
    await first.user.setProject('projeto', ['bom', 'novo', 'mau', 'mudou']);
    // Nova execução da app: a primeira entrega sonda outra vez e cada servidor responde à sua maneira.
    const probe: ProbeFn = async (target) => {
      const which = target.args[0];
      if (which === 'mau.mjs') throw new Error(`não arrancou: ${SECRET}`);
      const names = which === 'mudou.mjs' ? ['ler', 'extra'] : ['ler'];
      const tools = names.map((name) => toolPrint({ name, description: name }));
      return { tools, hash: toolsFingerprint(tools) };
    };
    const { manager, claude, user } = build({
      dataDir,
      store: first.store,
      user: (env) => env.make(probe),
    });
    const { session } = await manager.create({ ...base, agent: 'claude' });
    expect(session.mcpServers).toEqual(['bom']);
    expect(session.mcpSkipped).toEqual([
      { id: 'novo', reason: 'needs-approval' },
      { id: 'mau', reason: 'error' },
      { id: 'mudou', reason: 'changed' },
    ]);
    expect(Object.keys(claudeServers(claude[0]!))).toEqual(['bom']);
    // Nada do que falhou vai para o resumo da sessão: só ids e uma razão fixa.
    expect(JSON.stringify(session)).not.toContain(SECRET);
    expect(user.get('mudou').status).toBe('changed');
    expect(user.get('mau').error).not.toContain(SECRET);
  });

  it('as ferramentas mudadas só voltam a entrar depois de nova aprovação', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'solline-mcp-changed-'));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const first = userCatalog(dataDir);
    await first.approve('srv1', 'ferramentas');
    await first.user.setProject('projeto', ['srv1']);
    const probe: ProbeFn = async () => {
      const tools = ['ler', 'novo'].map((name) => toolPrint({ name, description: name }));
      return { tools, hash: toolsFingerprint(tools) };
    };
    const { manager, user, claude } = build({
      dataDir,
      store: first.store,
      user: (env) => env.make(probe),
    });
    const blocked = await manager.create({ ...base, agent: 'claude' });
    expect(blocked.session.mcpSkipped).toEqual([{ id: 'srv1', reason: 'changed' }]);
    expect(claude[0]!.options().mcpServers).toBeUndefined();
    const seen = user.get('srv1');
    await user.approve('srv1', { fingerprint: seen.fingerprint, toolsHash: seen.changed!.hash });
    const allowed = await manager.create({ ...base, agent: 'claude' });
    expect(allowed.session.mcpServers).toEqual(['srv1']);
    expect(claudeServers(claude[1]!).ferramentas).toBeDefined();
  });

  it('um servidor que corre programas fica de fora num modo sem perguntas', async () => {
    const { manager, claude, user, approve } = build();
    await approve('srv1', 'ferramentas');
    await user.setProject('projeto', ['srv1']);
    const { session } = await manager.create({ ...base, agent: 'claude', mode: 'auto' });
    expect(claude[0]!.options().mcpServers).toBeUndefined();
    expect(session.mcpServers).toBeUndefined();
    expect(session.mcpSkipped).toEqual([{ id: 'srv1', reason: 'restricted-mode' }]);
  });

  it('com mais de 8 servidores, os que passam do limite ficam de fora', async () => {
    const { manager, user, approve } = build();
    const ids = Array.from({ length: 8 }, (_, i) => `s${i}`);
    for (const id of ids) await approve(id, `servidor${id}`);
    await user.setProject('projeto', ids);
    const { session } = await manager.create({ ...base, agent: 'claude', mcpServerIds: ['docs'] });
    expect(session.mcpServers).toHaveLength(8);
    expect(session.mcpSkipped).toEqual([{ id: 's7', reason: 'limit' }]);
  });

  it('um servidor pedido à mão que não foi aprovado recusa a sessão, com a razão', async () => {
    const { manager, user } = build();
    user.add('novo', spec('novo'));
    await expect(
      manager.create({ ...base, agent: 'claude', mcpServerIds: ['novo'] }),
    ).rejects.toThrow('precisa de aprovação');
  });

  it('um agente sem MCP por sessão não recebe a escolha do projeto', async () => {
    const env = userCatalog();
    await env.approve('srv1', 'ferramentas');
    await env.user.setProject('projeto', ['srv1']);
    const manager = new SessionManager({
      emit: () => undefined,
      registry: withFactories(
        registryOf([{ ...claudeDefinition({ isolated: true }), mcp: false }]),
        {
          claude: (start, sink) => {
            const fake = fakeQuery(loadFixture('plain-answer'));
            return new ClaudeSdkAdapter(
              { ...start, queryFn: fake.queryFn, loadSettings: false },
              sink,
            );
          },
        },
      ),
      mcp: combinedCatalog(fixedMcpCatalog([]), env.user),
    });
    cleanup.push(() => manager.disposeAll());
    const { session } = await manager.create({ ...base, agent: 'claude' });
    expect(session.mcpServers).toBeUndefined();
    expect(session.mcpSkipped).toBeUndefined();
  });
});

describe('os segredos nunca saem do agente', () => {
  it('não aparecem em eventos, na sessão nem no que o gestor guarda para recuperar', async () => {
    const { manager, events, user, approve } = build();
    await approve('srv1', 'ferramentas');
    await user.setProject('projeto', ['srv1']);
    const { session } = await manager.create({ ...base, agent: 'claude' });
    await manager.send(session.id, 'olá');
    const everything = JSON.stringify([events, session, manager.recovery(), user.state()]);
    expect(everything).not.toContain(SECRET);
  });

  it('nem no estado do motor, no diário de recuperação, nos erros nem nos ficheiros da pasta de dados', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'solline-mcp-engine-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, 'project');
    mkdirSync(project);
    const dataDir = path.join(root, 'data');
    const key = Buffer.alloc(32, 9);
    const starts: AgentStartOptions[] = [];
    const capabilities: AgentCapabilities = {
      models: [],
      modes: [],
      effort: false,
      effortOrder: [],
      features: { cost: false, context: false, resume: true, rewind: false },
    };
    const store = new MemorySecretStore();
    const events: EngineEvent[] = [];
    const failing = { on: false };
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
      mcpSecrets: secretReaderFrom(store),
      mcpUser: {
        node: () => process.execPath,
        probe: async (target) => {
          if (failing.on) throw new Error(`falhou com ${target.env.API_TOKEN}`);
          const tools = [toolPrint({ name: 'ler', description: 'ler' })];
          return { tools, hash: toolsFingerprint(tools) };
        },
      },
      emit: (event) => events.push(event),
    });
    const call = async (command: string, payload: unknown) => {
      const response = await engine.handle({
        kind: 'request',
        id: crypto.randomUUID(),
        command,
        payload,
      });
      return response;
    };
    await store.set(mcpSecretTarget('srv1', 'API_TOKEN'), SECRET);
    await store.set(mcpSecretTarget('srv2', 'API_TOKEN'), SECRET);
    const added = await call('mcp.addNow', { id: 'srv1', spec: spec('um') });
    expect(added.ok).toBe(true);
    const fingerprint = (added as { ok: true; result: { server: { fingerprint: string } } }).result
      .server.fingerprint;
    expect((await call('mcp.approveNow', { id: 'srv1', fingerprint })).ok).toBe(true);
    expect((await call('mcp.setProject', { projectId: 'project', serverIds: ['srv1'] })).ok).toBe(
      true,
    );

    const started = await call('session.start', {
      projectId: 'project',
      cwd: project,
      agent: 'scripted',
      trusted: true,
    });
    expect(started.ok).toBe(true);
    // O agente recebeu o valor; é o único sítio onde ele vai.
    expect(starts[0]!.mcpServers?.find((s) => s.name === 'um')?.env.API_TOKEN).toBe(SECRET);

    // Um servidor que falha na sonda: o erro que volta ao utilizador não leva o segredo.
    failing.on = true;
    const second = await call('mcp.addNow', { id: 'srv2', spec: spec('dois') });
    const fp2 = (second as { ok: true; result: { server: { fingerprint: string } } }).result.server
      .fingerprint;
    // A sonda da aprovação falha: o servidor fica aprovado mas sem ferramentas conhecidas.
    await call('mcp.approveNow', { id: 'srv2', fingerprint: fp2 });
    const probed = await call('mcp.probe', { id: 'srv2' });
    const explicit = await call('session.start', {
      projectId: 'project',
      cwd: project,
      agent: 'scripted',
      trusted: true,
      mcpServerIds: ['srv2'],
    });
    failing.on = false;

    const catalog = await call('mcp.catalog', {});
    const snapshot = await call('engine.snapshot', {});
    const view = await call('mcp.get', { id: 'srv1' });
    await engine.dispose();
    const journal = new DurableJournal(
      path.join(dataDir, 'recovery', 'engine-v1'),
      (value) => value,
      key,
    );
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) walk(file);
        else files.push(file);
      }
    };
    walk(dataDir);
    // O diário está cifrado (não se pode procurar nele): lê-se pela chave, como o motor.
    const text = JSON.stringify([
      events,
      started,
      probed,
      explicit,
      catalog,
      snapshot,
      view,
      journal.records,
    ]);
    const onDisk = files.map((f) => readFileSync(f).toString('latin1')).join('\n');
    journal.close();
    expect(journal.records.length).toBeGreaterThan(0);
    expect(text).not.toContain(SECRET);
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk).not.toContain(Buffer.from(SECRET).toString('base64'));
    expect(files.some((f) => f.endsWith('mcp-catalog.json'))).toBe(true);
    expect(probed.ok).toBe(false);
    expect(explicit.ok).toBe(false);
    expect(JSON.stringify(explicit)).toContain('***');
  });
});
