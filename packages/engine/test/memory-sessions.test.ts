import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentCapabilities, Block, ConversationDelta, EngineEvent } from '@solline/protocol';
import {
  Brain,
  BrainChannel,
  CATALOG,
  AcpAdapter,
  ClaudeSdkAdapter,
  CodexAppServerAdapter,
  CRAFT_RULES,
  MemoryService,
  RulesManager,
  SessionManager,
  catalogDefinition,
  claudeDefinition,
  codexDefinition,
  contextTool,
  memoryTools,
  registryOf,
  rulesTools,
  sourceShimPath,
  withFactories,
  type AdapterSink,
  type AgentAdapter,
  type AgentStartOptions,
} from '../src/index.ts';
import { Engine } from '../src/engine.ts';
import { SpaceManager } from '../src/spaces/manager.ts';
import { fakeCodexServer } from './codex-fakes.ts';
import { fakeAcp } from './fakes/acp-transport.ts';
import { fakeQuery, loadFixture, waitFor } from './helpers.ts';

const roots: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of closers.splice(0).reverse()) await fn();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function folder(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'solline-memory-s-'));
  roots.push(root);
  const project = path.join(root, 'project');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'src', 'a.ts'), 'um\ndois\ntrês\n');
  return project;
}

function stores(project: string) {
  const spaces = new SpaceManager({
    save: () => undefined,
    create: async () => 's',
    send: async (_id, _text, turnId) => ({ turnId, how: 'sent' }),
    projectOf: () => 'p',
  });
  spaces.syncProjects(
    ['p', 'outro', 'vazio'].map((id) => ({
      id,
      path: project,
      name: id,
      trusted: true,
      addedAt: 0,
    })),
    project,
  );
  const rules = new RulesManager({ save: () => undefined });
  const memory = new MemoryService({
    store: {
      snapshot: () => spaces.snapshot(),
      change: (update) => spaces.change(update),
      root: (id) => spaces.projectPath(id),
    },
    rules,
  });
  const add = (projectId: string | null, text: string, state: 'active' | 'pending') =>
    spaces.saveMemory({ projectId, text, source: 'Duarte', sourceId: null, state });
  return { spaces, rules, memory, add };
}

describe('o índice da memória no arranque: os três agentes, com adaptadores verdadeiros', () => {
  async function build(options: { brain?: boolean; rules?: boolean } = {}) {
    const project = await folder();
    const { rules, memory, add } = stores(project);
    add('p', 'As migrações correm dentro de uma transação.', 'active');
    add('p', 'Proposta ainda por aprovar.', 'pending');
    add('outro', 'Memória de outro projeto.', 'active');
    add(null, 'Responder sempre em português.', 'active');
    if (options.rules)
      rules.save({
        projectId: 'p',
        title: 'Estilo',
        text: 'Usa dois espaços.',
        globs: [],
        enabled: true,
      });
    const claude: ReturnType<typeof fakeQuery>[] = [];
    const codex: ReturnType<typeof fakeCodexServer>[] = [];
    const acp: ReturnType<typeof fakeAcp>[] = [];
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
          return new ClaudeSdkAdapter(
            { ...start, queryFn: fake.queryFn, loadSettings: false },
            sink,
          );
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
    const brain = options.brain
      ? new Brain({
          channel: new BrainChannel({ helloTimeoutMs: 300 }),
          shim: sourceShimPath(),
          node: () => process.execPath,
          tools: [contextTool, ...rulesTools(rules), ...memoryTools(memory)],
          warn: () => undefined,
        })
      : undefined;
    const manager = new SessionManager({
      emit: () => undefined,
      registry,
      ...(brain ? { brain } : {}),
      rules,
      memories: memory,
    });
    closers.push(async () => {
      await manager.disposeAll();
      await brain?.dispose();
    });
    return { manager, project, claude, codex, acp };
  }

  const base = { projectId: 'p', trusted: true };

  it('o Claude recebe o índice no prompt de sistema: só as aprovadas, do projeto e as gerais', async () => {
    const { manager, project, claude } = await build();
    await manager.create({ ...base, cwd: project, agent: 'claude' });
    const prompt = (claude[0]!.options().systemPrompt as { append: string }).append;
    expect(prompt.startsWith(CRAFT_RULES)).toBe(true);
    expect(prompt).toContain('# Memória (Solline)');
    expect(prompt).toMatch(/- [0-9a-f-]{8} · As migrações correm dentro de uma transação\./);
    expect(prompt).toMatch(/- [0-9a-f-]{8} · Responder sempre em português\./);
    expect(prompt).not.toContain('Proposta ainda por aprovar');
    expect(prompt).not.toContain('Memória de outro projeto');
    // Sem cérebro, as ferramentas não existem: o índice não as promete.
    expect(prompt).not.toContain('read_memory');
  });

  it('com o cérebro, o índice manda ler com read_memory, e vem depois das regras', async () => {
    const { manager, project, claude } = await build({ brain: true, rules: true });
    await manager.create({ ...base, cwd: project, agent: 'claude' });
    const prompt = (claude[0]!.options().systemPrompt as { append: string }).append;
    expect(prompt).toContain('read_memory');
    expect(prompt).toContain('search_memory');
    expect(prompt.indexOf('# Regras do projeto (Solline)')).toBeGreaterThan(-1);
    expect(prompt.indexOf('# Memória (Solline)')).toBeGreaterThan(
      prompt.indexOf('# Regras do projeto (Solline)'),
    );
  });

  it('o Codex recebe o mesmo índice nas developerInstructions do thread', async () => {
    const { manager, project, codex } = await build();
    await manager.create({ ...base, cwd: project, agent: 'codex', mode: 'ask' });
    const start = codex[0]!.received.find((m) => m.method === 'thread/start') as {
      params: { developerInstructions: string };
    };
    expect(start.params.developerInstructions).toContain('# Memória (Solline)');
    expect(start.params.developerInstructions).toContain(
      'As migrações correm dentro de uma transação.',
    );
    expect(start.params.developerInstructions).not.toContain('Proposta ainda por aprovar');
  });

  it('o ACP recebe o índice com a primeira mensagem, uma vez, marcado como contexto', async () => {
    const { manager, project, acp } = await build();
    const { session } = await manager.create({ ...base, cwd: project, agent: CATALOG[0]!.id });
    const prompts = () =>
      acp[0]!.received
        .filter((m) => m.method === 'session/prompt')
        .map((m) => (m.params as { prompt: { text: string }[] }).prompt[0]!.text);
    await manager.send(session.id, 'primeira pergunta');
    await waitFor(() => prompts().length === 1);
    const [first] = prompts();
    expect(first).toContain('# Memória (Solline)');
    expect(first).toContain('não é uma mensagem do utilizador');
    expect(first).toContain('As migrações correm dentro de uma transação.');
    expect(first).toContain('\n\n---\n\nprimeira pergunta');
    await manager.send(session.id, 'segunda pergunta');
    await waitFor(() => prompts().length === 2);
    expect(prompts()[1]).not.toContain('# Memória (Solline)');
  });

  it('um projeto sem memórias próprias recebe só as gerais', async () => {
    const { manager, project, claude } = await build();
    await manager.create({ projectId: 'vazio', trusted: true, cwd: project, agent: 'claude' });
    const prompt = (claude[0]!.options().systemPrompt as { append: string }).append;
    expect(prompt).toContain('Responder sempre em português.');
    expect(prompt).not.toContain('As migrações correm');
  });
});

const CAPS: AgentCapabilities = {
  models: [{ id: 'm', resolved: null, label: 'M', description: '', efforts: [] }],
  modes: [],
  effort: false,
  effortOrder: [],
  features: { cost: false, context: false, resume: true, rewind: true },
};

/** Um agente de mentira que, a cada mensagem, "usa" a ferramenta que a mensagem nomeia. */
class ToolUser implements AgentAdapter {
  static started: AgentStartOptions[] = [];
  readonly #sink: AdapterSink;
  constructor(options: AgentStartOptions, sink: AdapterSink) {
    this.#sink = sink;
    ToolUser.started.push(options);
  }
  async start() {
    this.#sink.state('idle');
    return { settings: { model: 'm', effort: null, mode: null }, capabilities: CAPS };
  }
  async send(text: string, options: { turnId?: string } = {}) {
    const turnId = options.turnId ?? crypto.randomUUID();
    const delta = (d: ConversationDelta) => this.#sink.delta(d);
    delta({
      type: 'turn.start',
      turn: {
        id: turnId,
        role: 'user',
        blocks: [{ kind: 'text', id: 't', text, parentToolId: null }],
      },
    });
    this.#sink.state('running');
    const tools: Block[] = [];
    if (text.includes('web'))
      tools.push({
        kind: 'tool',
        id: `${turnId}:w`,
        name: 'WebFetch',
        summary: 'Abrir página',
        input: { url: 'https://exemplo.pt' },
        state: 'ok',
        parentToolId: null,
        category: 'fetch',
      });
    if (text.includes('terceiros'))
      tools.push({
        kind: 'tool',
        id: `${turnId}:m`,
        name: 'mcp__docs__query',
        summary: 'docs: query',
        input: {},
        state: 'ok',
        parentToolId: null,
        category: 'other',
      });
    if (text.includes('local'))
      tools.push({
        kind: 'tool',
        id: `${turnId}:r`,
        name: 'Read',
        summary: 'Ler',
        input: {},
        state: 'ok',
        parentToolId: null,
        category: 'read',
      });
    const reply = `${turnId}:a`;
    delta({ type: 'turn.start', turn: { id: reply, role: 'assistant', blocks: tools } });
    delta({ type: 'turn.end', turnId: reply, outcome: 'done' });
    setTimeout(() => this.#sink.state('idle'), 5);
    return turnId;
  }
  async interrupt() {}
  async setMode() {}
  async setModel() {}
  answerPermission() {
    return false;
  }
  capabilities() {
    return CAPS;
  }
  agentSessionId() {
    return null;
  }
  async close() {}
}

describe('propor_memory: o motor diz de onde veio o turno', () => {
  async function open() {
    const project = await folder();
    const { spaces, memory } = stores(project);
    ToolUser.started = [];
    const brain = new Brain({ tools: memoryTools(memory), warn: () => undefined });
    const events: EngineEvent[] = [];
    const manager = new SessionManager({
      emit: (event) => events.push(event),
      registry: withFactories(registryOf([claudeDefinition({ isolated: true })]), {
        claude: (start, sink) => new ToolUser(start, sink),
      }),
      brain,
      memories: memory,
    });
    closers.push(async () => {
      await manager.disposeAll();
      await brain.dispose();
    });
    const { session } = await manager.create({
      projectId: 'p',
      trusted: true,
      cwd: project,
      agent: 'claude',
    });
    const binding = ToolUser.started.at(-1)?.brain;
    if (!binding) throw new Error('A sessão não recebeu o cérebro');
    let n = 0;
    const propose = async () => {
      const result = await binding.call('propose_memory', {
        text: `Memória ${++n}`,
        reason: 'Porque sim',
        citations: [{ path: 'src/a.ts', line: 1, endLine: 2 }],
      });
      expect(result.isError).toBe(false);
      return spaces.snapshot().memories[0]!;
    };
    const turn = async (text: string) => {
      const { turnId } = await manager.send(session.id, text);
      const reply = `${turnId}:a`;
      await waitFor(() =>
        events.some(
          (e) =>
            e.type === 'session.event' && e.delta.type === 'turn.end' && e.delta.turnId === reply,
        ),
      );
      await waitFor(
        () =>
          events.findLast((e) => e.type === 'session.state')?.type === 'session.state' &&
          (events.findLast((e) => e.type === 'session.state') as { state: string }).state ===
            'idle',
      );
      return turnId;
    };
    return { propose, turn, session };
  }

  it('um turno com WebFetch, ou com um servidor MCP de terceiros, marca a proposta como externa', async () => {
    const { propose, turn, session } = await open();
    const first = await turn('lê esta página web');
    const proposed = await propose();
    expect(proposed.external).toBe(true);
    expect(proposed.origin).toMatchObject({
      agent: 'claude',
      sessionId: session.id,
      turnId: first,
      projectId: 'p',
    });
    await turn('pergunta aos terceiros');
    expect((await propose()).external).toBe(true);
  });

  it('um turno só com leituras locais não é externo, e o seguinte conta à parte', async () => {
    const { propose, turn } = await open();
    await turn('lê o ficheiro local');
    expect((await propose()).external).toBe(false);
    await turn('agora a web');
    expect((await propose()).external).toBe(true);
    await turn('outra vez local');
    expect((await propose()).external).toBe(false);
  });

  it('sem nada visto (nenhum turno ainda), a proposta conta como externa', async () => {
    const { propose } = await open();
    expect((await propose()).external).toBe(true);
  });
});

describe('no motor: comandos memory.*, recuperação e regras', () => {
  const key = Buffer.alloc(32, 9);
  const engines: Engine[] = [];
  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.dispose();
  });

  function open(dataDir: string) {
    const engine = new Engine({
      registry: registryOf([]),
      dataDir,
      recoveryKey: key,
      isolated: true,
      checkpoints: false,
      checks: false,
      reviewer: false,
      worktrees: false,
    });
    engines.push(engine);
    return engine;
  }

  let id = 0;
  async function request<T>(engine: Engine, command: string, payload: unknown): Promise<T> {
    const result = await engine.handle({ kind: 'request', id: `memory-${++id}`, command, payload });
    if (!result.ok) throw new Error(result.error.message);
    return result.result as T;
  }

  type Snapshot = {
    memories: { id: string; state: string; projectId: string | null }[];
    forgotten: string[];
  };

  it('propor, aprovar, reiniciar, rejeitar e passar a regra, tudo pelos comandos do motor', async () => {
    const project = await folder();
    const dataDir = path.join(path.dirname(project), 'data');
    const first = open(dataDir);
    await request(first, 'spaces.syncProjects', {
      projects: [{ id: 'p', path: project, name: 'P', trusted: true, addedAt: 0 }],
      generalCwd: project,
    });
    const caller = {
      sessionId: 's',
      projectId: 'p',
      agent: 'claude',
      cwd: project,
      turn: { id: 't', external: false },
    };
    const propose = (text: string) =>
      first.memory.propose(caller, {
        text,
        reason: 'Importa',
        citations: [{ path: 'src/a.ts', line: 1, endLine: 2 }],
      });
    const a = await propose('Primeira memória');
    const b = await propose('Segunda memória');
    const c = await propose('Terceira memória');
    const d = await propose('Quarta memória');

    // Aprovar em lote, a segunda como geral por decisão do utilizador.
    await request(first, 'memory.approve', { ids: [a] });
    await request(first, 'memory.approve', { ids: [b], scope: 'global' });
    // O botão "Ativar" antigo (spaces.memorySave com state active) passa pela aprovação.
    const saved = await request<Snapshot>(first, 'spaces.memorySave', {
      id: c,
      projectId: 'p',
      text: 'Terceira memória, editada',
      source: 'x',
      sourceId: null,
      state: 'active',
    });
    expect(saved.memories.find((m) => m.id === c)?.state).toBe('active');
    expect(first.spaces.snapshot().memories.find((m) => m.id === c)).toMatchObject({
      text: 'Terceira memória, editada',
      evidence: [{ path: 'src/a.ts' }],
    });
    expect(first.spaces.snapshot().memories.find((m) => m.id === c)?.approvedAt).not.toBeNull();
    await first.dispose();

    const second = open(dataDir);
    const after = second.spaces.snapshot();
    expect(after.memories.map((m) => [m.id, m.state, m.projectId]).sort()).toEqual(
      [
        [a, 'active', 'p'],
        [b, 'active', null],
        [c, 'active', 'p'],
        [d, 'pending', 'p'],
      ].sort(),
    );

    const rejected = await request<Snapshot>(second, 'memory.reject', { ids: [d] });
    expect(rejected.memories.some((m) => m.id === d)).toBe(false);
    expect(rejected.forgotten).toHaveLength(1);

    const view = await request<{ projectId: string; rules: { title: string }[] }>(
      second,
      'memory.toRule',
      { id: a },
    );
    expect(view.projectId).toBe('p');
    expect(view.rules[0]?.title).toBe('Primeira memória');
    expect(second.rules.enabled('p')).toHaveLength(1);
    expect(second.spaces.snapshot().memories.find((m) => m.id === a)?.state).toBe('disabled');

    // Comandos com ids que não existem ou campos a mais são recusados.
    await expect(request(second, 'memory.approve', { ids: ['nao-existe'] })).rejects.toThrow();
    await expect(request(second, 'memory.approve', { ids: [b], projectId: 'q' })).rejects.toThrow();
    await expect(request(second, 'memory.confirm', { ids: [d] })).rejects.toThrow();
  });
});
