import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentCapabilities,
  CommandPayload,
  ConversationDelta,
  EngineEvent,
  SessionTimelineEvent,
} from '@solline/protocol';
import {
  Brain,
  BrainChannel,
  CATALOG,
  CRAFT_RULES,
  AcpAdapter,
  ClaudeSdkAdapter,
  CodexAppServerAdapter,
  RulesManager,
  SessionManager,
  builtinRegistry,
  catalogDefinition,
  claudeDefinition,
  codexDefinition,
  contextTool,
  exportRules,
  registryOf,
  rulesTools,
  sourceShimPath,
  withFactories,
  type AdapterSink,
  type AgentAdapter,
  type AgentStartOptions,
} from '../src/index.ts';
import { CheckpointStore } from '../src/checkpoints/store.ts';
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
  const root = await mkdtemp(path.join(tmpdir(), 'solline-rules-s-'));
  roots.push(root);
  const project = path.join(root, 'project');
  await mkdir(project);
  return project;
}

function ruleSet(): RulesManager {
  const rules = new RulesManager({ save: () => undefined });
  const add = (over: Partial<CommandPayload<'rules.save'>>) =>
    rules.save({ projectId: 'p', title: 'T', text: 't', globs: [], enabled: true, ...over });
  add({ title: 'Estilo', text: 'Usa dois espaços em tudo.' });
  add({ title: 'SQL', text: 'Toda a migração leva transação.', globs: ['*.sql', 'db/**'] });
  return rules;
}

const SQL_ID = (rules: RulesManager) => rules.enabled('p').find((r) => r.title === 'SQL')!.id;

describe('as regras no arranque: os três agentes, com adaptadores verdadeiros', () => {
  async function build(options: { brain?: boolean } = {}) {
    const project = await folder();
    const rules = ruleSet();
    const claude: ReturnType<typeof fakeQuery>[] = [];
    const prompts: string[] = [];
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
          // Tira uma cópia do que o utilizador manda ao agente.
          const queryFn = ((args: Parameters<typeof fake.queryFn>[0]) => {
            const tee = async function* () {
              for await (const message of args.prompt as AsyncIterable<{
                message: { content: unknown };
              }>) {
                prompts.push(String(message.message.content));
                yield message;
              }
            };
            return fake.queryFn({ ...args, prompt: tee() } as Parameters<typeof fake.queryFn>[0]);
          }) as typeof fake.queryFn;
          return new ClaudeSdkAdapter({ ...start, queryFn, loadSettings: false }, sink);
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
          tools: [contextTool, ...rulesTools(rules)],
          warn: () => undefined,
        })
      : undefined;
    const manager = new SessionManager({
      emit: () => undefined,
      registry,
      ...(brain ? { brain } : {}),
      rules,
    });
    closers.push(async () => {
      await manager.disposeAll();
      await brain?.dispose();
    });
    return { manager, project, rules, claude, prompts, codex, acp };
  }

  const base = { projectId: 'p', trusted: true };

  it('o Claude recebe o bloco no prompt de sistema, a seguir às regras de ofício', async () => {
    const { manager, project, claude } = await build();
    await manager.create({ ...base, cwd: project, agent: 'claude' });
    const prompt = claude[0]!.options().systemPrompt as { append: string };
    expect(prompt.append.startsWith(CRAFT_RULES)).toBe(true);
    expect(prompt.append).toContain('# Regras do projeto (Solline)');
    expect(prompt.append).toContain('## Estilo\n\nUsa dois espaços em tudo.');
    expect(prompt.append).not.toContain('Toda a migração leva transação.');
    expect(prompt.append).toContain('- SQL (id ');
    expect(prompt.append).toContain('`*.sql`, `db/**`');
    // Sem cérebro, a ferramenta não existe: o índice não a promete.
    expect(prompt.append).not.toContain('read_rule');
  });

  it('com o cérebro, o índice manda ler com a ferramenta read_rule', async () => {
    const { manager, project, claude } = await build({ brain: true });
    await manager.create({ ...base, cwd: project, agent: 'claude' });
    const prompt = claude[0]!.options().systemPrompt as { append: string };
    expect(prompt.append).toContain(
      'Lê com a ferramenta read_rule quando editares estes ficheiros.',
    );
  });

  it('o Codex recebe o mesmo bloco nas developerInstructions do thread', async () => {
    const { manager, project, codex } = await build();
    await manager.create({ ...base, cwd: project, agent: 'codex', mode: 'ask' });
    const start = codex[0]!.received.find((m) => m.method === 'thread/start') as {
      params: { developerInstructions: string };
    };
    expect(start.params.developerInstructions.startsWith(CRAFT_RULES)).toBe(true);
    expect(start.params.developerInstructions).toContain('## Estilo\n\nUsa dois espaços em tudo.');
    expect(start.params.developerInstructions).toContain('- SQL (id ');
  });

  it('o ACP não tem canal de instruções: o bloco segue com a primeira mensagem, uma vez', async () => {
    const { manager, project, acp } = await build();
    const { session } = await manager.create({ ...base, cwd: project, agent: CATALOG[0]!.id });
    const prompts = () =>
      acp[0]!.received
        .filter((m) => m.method === 'session/prompt')
        .map((m) => (m.params as { prompt: { text: string }[] }).prompt[0]!.text);
    await manager.send(session.id, 'primeira pergunta');
    await waitFor(() => prompts().length === 1);
    const [first] = prompts();
    expect(first).toContain('# Regras do projeto (Solline)');
    expect(first).toContain('não é uma mensagem do utilizador');
    expect(first).toContain('## Estilo\n\nUsa dois espaços em tudo.');
    expect(first).toContain('\n\n---\n\nprimeira pergunta');
  });

  it('sem regras, nada muda: o prompt é só o de ofício', async () => {
    const { manager, project, claude, rules } = await build();
    for (const rule of rules.enabled('p')) rules.delete('p', rule.id);
    await manager.create({ ...base, cwd: project, agent: 'claude' });
    const prompt = claude[0]!.options().systemPrompt as { append: string };
    expect(prompt.append).toBe(CRAFT_RULES);
    // Nem as regras de outro projeto entram.
    const other = await build();
    await other.manager.create({
      projectId: 'outro',
      trusted: true,
      cwd: project,
      agent: 'claude',
    });
    expect((other.claude[0]!.options().systemPrompt as { append: string }).append).toBe(
      CRAFT_RULES,
    );
  });
});

const CAPS: AgentCapabilities = {
  models: [{ id: 'm', resolved: null, label: 'M', description: '', efforts: [] }],
  modes: [],
  effort: false,
  effortOrder: [],
  features: { cost: false, context: false, resume: true, rewind: true },
};

/** Um agente de mentira que escreve no disco o que a mensagem pede ("escreve a/b.ts=x"). */
class Scripted implements AgentAdapter {
  static started: AgentStartOptions[] = [];
  static received: { text: string; context: string | undefined }[] = [];
  readonly #options: AgentStartOptions;
  readonly #sink: AdapterSink;

  constructor(options: AgentStartOptions, sink: AdapterSink) {
    this.#options = options;
    this.#sink = sink;
    Scripted.started.push(options);
  }
  async start() {
    this.#sink.state('idle');
    return { settings: { model: 'm', effort: null, mode: null }, capabilities: CAPS };
  }
  async send(text: string, options: { turnId?: string; context?: string } = {}) {
    const turnId = options.turnId ?? crypto.randomUUID();
    Scripted.received.push({ text, context: options.context });
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
    for (const match of text.matchAll(/escreve (\S+)=(\S+)/g)) {
      const file = path.join(this.#options.cwd, match[1]!);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${match[2]}\n`);
    }
    const reply = `${turnId}:a`;
    delta({ type: 'turn.start', turn: { id: reply, role: 'assistant', blocks: [] } });
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

describe('as regras com padrões entram ao tocar nos ficheiros', { timeout: 60_000 }, () => {
  let project: string;
  let store: CheckpointStore;
  let rules: RulesManager;
  let manager: SessionManager;
  let events: EngineEvent[];

  function open(): void {
    events = [];
    Scripted.started = [];
    Scripted.received = [];
    const registry = withFactories(builtinRegistry({ isolated: false }), {
      claude: (start, sink) => new Scripted(start, sink),
      codex: (start, sink) => new Scripted(start, sink),
      [CATALOG[0]!.id]: (start, sink) => new Scripted(start, sink),
    });
    manager = new SessionManager({
      emit: (event) => events.push(event),
      registry,
      checkpoints: store,
      rules,
    });
  }

  const timeline = (sessionId: string) =>
    events
      .filter(
        (e): e is SessionTimelineEvent =>
          e.type === 'session.timeline' && e.sessionId === sessionId,
      )
      .at(-1)?.timeline;

  async function start(agent: string = 'claude', trusted = true): Promise<string> {
    const { session } = await manager.create({
      projectId: 'p',
      agent,
      cwd: project,
      trusted,
    });
    await waitFor(() => timeline(session.id) !== undefined, 10_000);
    return session.id;
  }

  async function turn(sessionId: string, text: string): Promise<void> {
    const { turnId } = await manager.send(sessionId, text);
    await waitFor(
      () => timeline(sessionId)?.checkpoints.find((c) => c.turnId === turnId)?.state === 'done',
      10_000,
    );
  }

  beforeEach(async () => {
    project = await folder();
    store = new CheckpointStore({ root: path.join(path.dirname(project), 'data') });
    rules = ruleSet();
    await writeFile(path.join(project, 'f.txt'), 'v0\n');
    open();
  });
  afterEach(async () => {
    await manager.disposeAll();
    await store.dispose();
  });

  const SQL_TEXT = 'Toda a migração leva transação.';

  it('no arranque só o índice; a regra inteira só depois de um turno mudar um ficheiro que case, e só uma vez', async () => {
    const id = await start();
    const instructions = Scripted.started[0]!.instructions!;
    expect(instructions).toContain('- SQL (id ');
    expect(instructions).not.toContain(SQL_TEXT);

    // Um ficheiro que não casa não traz nada.
    await turn(id, 'escreve src/a.ts=1');
    await turn(id, 'segue');
    expect(Scripted.received.at(-1)?.context).toBeUndefined();

    // Um que casa: a regra inteira vai com a mensagem SEGUINTE.
    await turn(id, 'escreve db/001.sql=1');
    expect(Scripted.received.at(-1)?.context).toBeUndefined();
    await turn(id, 'e agora?');
    const delivered = Scripted.received.at(-1)!;
    expect(delivered.text).toBe('e agora?');
    expect(delivered.context).toContain('## SQL\n\nToda a migração leva transação.');
    expect(delivered.context).toContain('não é uma mensagem do utilizador');
    expect(delivered.context).not.toContain('Usa dois espaços');

    // Uma vez por regra e sessão, mesmo que se volte a tocar nela.
    await turn(id, 'escreve db/002.sql=2');
    await turn(id, 'mais uma');
    expect(Scripted.received.at(-1)?.context).toBeUndefined();
  });

  it('uma regra desligada, ou de outro projeto, não entra; uma regra nova vale para os turnos seguintes', async () => {
    const id = await start();
    rules.save({
      projectId: 'p',
      id: SQL_ID(rules),
      title: 'SQL',
      text: SQL_TEXT,
      globs: ['*.sql'],
      enabled: false,
    });
    rules.save({
      projectId: 'outro',
      title: 'Alheia',
      text: 'Não é deste projeto.',
      globs: ['*.sql'],
      enabled: true,
    });
    await turn(id, 'escreve db/a.sql=1');
    await turn(id, 'e agora?');
    expect(Scripted.received.at(-1)?.context).toBeUndefined();

    rules.save({
      projectId: 'p',
      title: 'Docs',
      text: 'Docs em português.',
      globs: ['docs/**'],
      enabled: true,
    });
    await turn(id, 'escreve docs/x.md=1');
    await turn(id, 'e agora?');
    expect(Scripted.received.at(-1)?.context).toContain('Docs em português.');
    expect(Scripted.received.at(-1)?.context).not.toContain('Não é deste projeto.');
  });

  it('o que já seguiu fica guardado com a sessão (não repete depois de recuperar)', async () => {
    const id = await start();
    await turn(id, 'escreve db/a.sql=1');
    await turn(id, 'e agora?');
    const saved = manager.recovery().find((s) => s.view.session.id === id)!;
    expect(saved.rulesDelivered).toEqual([SQL_ID(rules)]);
  });

  it('no ACP o índice vai na primeira mensagem e a regra inteira ao tocar, como nos outros', async () => {
    const id = await start(CATALOG[0]!.id);
    expect(Scripted.started[0]!.instructions).toBeUndefined();
    await turn(id, 'primeira');
    const first = Scripted.received[0]!;
    expect(first.context).toContain('## Estilo');
    expect(first.context).toContain('- SQL (id ');
    expect(first.context).not.toContain(SQL_TEXT);
    // O bloco do arranque segue uma vez só.
    await turn(id, 'segunda');
    expect(Scripted.received[1]!.context).toBeUndefined();
    await turn(id, 'escreve db/a.sql=1');
    await turn(id, 'e agora?');
    expect(Scripted.received.at(-1)?.context).toContain(SQL_TEXT);
  });

  describe('sem repetir o que o agente já lê da pasta', () => {
    const everything = () => rules.enabled('p');

    it('o Claude, com o CLAUDE.md e o AGENTS.md da Solline em dia, não recebe o bloco do arranque', async () => {
      await exportRules(project, everything());
      const id = await start('claude');
      expect(Scripted.started[0]!.instructions).toBeUndefined();
      // As regras com padrões continuam a entrar ao tocar nos ficheiros.
      await turn(id, 'escreve db/a.sql=1');
      await turn(id, 'e agora?');
      expect(Scripted.received.at(-1)?.context).toContain(SQL_TEXT);
    });

    it('o Codex só precisa do AGENTS.md; o Claude, sem o CLAUDE.md, recebe na mesma', async () => {
      await exportRules(project, everything());
      await rm(path.join(project, 'CLAUDE.md'));
      await start('codex');
      expect(Scripted.started.at(-1)!.instructions).toBeUndefined();
      await start('claude');
      expect(Scripted.started.at(-1)!.instructions).toContain('## Estilo');
    });

    it('uma exportação desatualizada ou editada à mão não conta: o bloco vai', async () => {
      await exportRules(project, everything());
      rules.save({ projectId: 'p', title: 'Nova', text: 'Regra nova.', globs: [], enabled: true });
      await start('claude');
      expect(Scripted.started.at(-1)!.instructions).toContain('Regra nova.');

      await exportRules(project, everything());
      const file = path.join(project, 'AGENTS.md');
      const { readFile } = await import('node:fs/promises');
      await writeFile(file, `${await readFile(file, 'utf8')}\numa linha minha\n`);
      await start('codex');
      expect(Scripted.started.at(-1)!.instructions).toContain('Regra nova.');
    });

    it('um CLAUDE.md escrito à mão não conta e o bloco vai (o aviso fica no estado)', async () => {
      await writeFile(path.join(project, 'CLAUDE.md'), '## Estilo\nUsa dois espaços em tudo.\n');
      await start('claude');
      expect(Scripted.started.at(-1)!.instructions).toContain('## Estilo');
    });

    it('um projeto sem confiança não lê o CLAUDE.md da pasta: o bloco vai', async () => {
      await exportRules(project, everything());
      await start('claude', false);
      expect(Scripted.started.at(-1)!.instructions).toContain('## Estilo');
    });

    it('os agentes ACP não leem estes ficheiros sozinhos: recebem sempre', async () => {
      await exportRules(project, everything());
      const id = await start(CATALOG[0]!.id);
      await turn(id, 'olá');
      expect(Scripted.received[0]!.context).toContain('## Estilo');
    });
  });
});

describe('ferramentas das regras: a identidade vem do motor', () => {
  function bound() {
    const rules = new RulesManager({ save: () => undefined });
    const mine = rules.save({
      projectId: 'meu',
      title: 'Minha',
      text: 'Segredo do meu projeto.',
      globs: ['*.ts'],
      enabled: true,
    }).rules[0]!;
    const hidden = rules.save({
      projectId: 'meu',
      title: 'Desligada',
      text: 'Fora.',
      globs: [],
      enabled: false,
    }).rules[1]!;
    const theirs = rules.save({
      projectId: 'alheio',
      title: 'Alheia',
      text: 'Segredo do outro projeto.',
      globs: [],
      enabled: true,
    }).rules[0]!;
    const brain = new Brain({ tools: rulesTools(rules), warn: () => undefined });
    closers.push(() => brain.dispose());
    const bind = (projectId: string) =>
      brain.bind(
        {
          id: `s-${projectId}`,
          projectId,
          agent: 'claude',
          describe: () => ({ title: 't', folder: 'f' }),
        },
        'in-process',
      );
    return { brain, bind, mine, hidden, theirs };
  }

  it('são só de leitura e correm sem pedir autorização', () => {
    const { brain } = bound();
    expect([...brain.readOnlyTools].sort()).toEqual(['list_rules', 'read_rule']);
  });

  it('read_rule lê as regras do projeto da sessão e mais nenhumas', async () => {
    const { bind, mine, hidden, theirs } = bound();
    const session = await bind('meu');
    const own = await session.call('read_rule', { id: mine.id });
    expect(own.isError).toBe(false);
    expect(own.text).toBe('# Minha\nAplica-se a: *.ts\n\nSegredo do meu projeto.');
    // O id de outro projeto não se lê, mesmo que o agente o adivinhe.
    const stolen = await session.call('read_rule', { id: theirs.id });
    expect(stolen).toMatchObject({ isError: true });
    expect(stolen.text).not.toContain('Segredo do outro projeto.');
    expect((await session.call('read_rule', { id: hidden.id })).isError).toBe(true);
    expect((await session.call('read_rule', { id: 'nao-existe' })).isError).toBe(true);
    expect((await session.call('read_rule', {})).isError).toBe(true);
    // Um argumento a mais (por exemplo um projectId) é recusado, não obedecido.
    const forged = await session.call('read_rule', { id: theirs.id, projectId: 'alheio' });
    expect(forged.isError).toBe(true);

    const other = await bind('alheio');
    expect((await other.call('read_rule', { id: theirs.id })).text).toContain(
      'Segredo do outro projeto.',
    );
    expect((await other.call('read_rule', { id: mine.id })).isError).toBe(true);
  });

  it('list_rules devolve o índice só das regras ativas do próprio projeto', async () => {
    const { bind, mine } = bound();
    const listed = JSON.parse((await (await bind('meu')).call('list_rules', {})).text);
    expect(listed).toEqual([{ id: mine.id, title: 'Minha', globs: ['*.ts'] }]);
    expect(JSON.parse((await (await bind('vazio')).call('list_rules', {})).text)).toEqual([]);
  });

  it('o motor regista as ferramentas das regras e da memória ao lado da de prova, no servidor do Claude', async () => {
    const { Engine } = await import('../src/engine.ts');
    const fake = fakeQuery(loadFixture('plain-answer'));
    const engine = new Engine({
      registry: withFactories(registryOf([claudeDefinition({ isolated: true })]), {
        claude: (start, sink) =>
          new ClaudeSdkAdapter({ ...start, queryFn: fake.queryFn, loadSettings: false }, sink),
      }),
      isolated: true,
      checkpoints: false,
      checks: false,
      reviewer: false,
      worktrees: false,
      brain: { warn: () => undefined },
    });
    closers.push(() => engine.dispose());
    const project = await folder();
    const result = await engine.handle({
      kind: 'request',
      id: 'x',
      command: 'session.start',
      payload: { projectId: 'p', agent: 'claude', cwd: project, trusted: true },
    });
    expect(result.ok).toBe(true);
    const servers = fake.options().mcpServers as Record<string, { instance: object }>;
    const tools = (
      servers.solline!.instance as unknown as { _registeredTools: Record<string, unknown> }
    )._registeredTools;
    expect(Object.keys(tools).sort()).toEqual([
      'list_rules',
      'propose_memory',
      'read_memory',
      'read_rule',
      'search_memory',
      'solline_context',
    ]);
  });
});
