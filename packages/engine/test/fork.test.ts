import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EngineSnapshot,
  type AgentCapabilities,
  type EngineEvent,
  type SessionTimelineEvent,
} from '@solline/protocol';
import { Engine } from '../src/engine.ts';
import { CheckpointStore } from '../src/checkpoints/store.ts';
import { WorktreeManager } from '../src/worktrees/worktrees.ts';
import {
  SessionManager,
  type AdapterSink,
  type AgentAdapter,
  type AgentStartOptions,
} from '../src/index.ts';
import { testRegistry, waitFor } from './helpers.ts';

const caps = (rewind: boolean): AgentCapabilities => ({
  models: [{ id: 'm', resolved: null, label: 'M', description: '', efforts: [] }],
  modes: [],
  effort: false,
  effortOrder: [],
  features: { cost: false, context: false, resume: true, rewind },
});

/**
 * Um agente de mentira que mexe no disco como a mensagem pede, uma instrução por linha:
 * "escreve f.txt=x" e "apaga f.txt". Com `native` dá pontos de rebobinar (como o Claude e o
 * Codex); "demora" deixa o turno aberto até `release()`. Guarda como foi arrancado.
 */
class ForkAdapter implements AgentAdapter {
  static started: AgentStartOptions[] = [];
  static received: { cwd: string; text: string; context: string | undefined }[] = [];
  static open: (() => void)[] = [];
  static failFork = false;
  readonly #options: AgentStartOptions;
  readonly #sink: AdapterSink;
  readonly #native: boolean;
  #turns = 0;
  readonly rewindPoint: (() => string | null) | undefined;

  constructor(options: AgentStartOptions, sink: AdapterSink, native: boolean) {
    this.#options = options;
    this.#sink = sink;
    this.#native = native;
    ForkAdapter.started.push(options);
    if (native) {
      this.rewindPoint = () =>
        this.#turns === 0 && !this.#options.fork
          ? null
          : `ponto-${this.#options.fork ?? 'novo'}-${this.#turns}`;
    }
  }

  static release(): void {
    for (const finish of ForkAdapter.open.splice(0)) finish();
  }

  async start() {
    if (this.#options.fork && ForkAdapter.failFork)
      throw new Error('o agente não consegue continuar daqui');
    this.#sink.state('idle');
    return {
      settings: { model: 'm', effort: null, mode: null },
      capabilities: caps(this.#native),
    };
  }

  async send(text: string, options: { turnId?: string; context?: string } = {}) {
    const turnId = options.turnId ?? crypto.randomUUID();
    ForkAdapter.received.push({ cwd: this.#options.cwd, text, context: options.context });
    this.#sink.delta({
      type: 'turn.start',
      turn: {
        id: turnId,
        role: 'user',
        blocks: [{ kind: 'text', id: 't', text, parentToolId: null }],
      },
    });
    this.#sink.state('running');
    for (const [, file, value] of text.matchAll(/^escreve (\S+)=(\S+)$/gm)) {
      const target = path.join(this.#options.cwd, file!);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${value}\n`);
    }
    for (const [, file] of text.matchAll(/^apaga (\S+)$/gm))
      await rm(path.join(this.#options.cwd, file!), { force: true });
    const finish = () => {
      const reply = `${turnId}:a`;
      this.#sink.delta({ type: 'turn.start', turn: { id: reply, role: 'assistant', blocks: [] } });
      this.#sink.delta({
        type: 'block.upsert',
        turnId: reply,
        block: { kind: 'text', id: 'r', text: `Feito: ${text.slice(0, 40)}`, parentToolId: null },
      });
      this.#sink.delta({ type: 'turn.end', turnId: reply, outcome: 'done' });
      this.#turns++;
      this.#sink.state('idle');
    };
    if (text.includes('demora')) ForkAdapter.open.push(finish);
    else setTimeout(finish, 5);
    return turnId;
  }

  async interrupt() {}
  async setMode() {}
  async setModel() {}
  answerPermission() {
    return false;
  }
  capabilities() {
    return caps(this.#native);
  }
  agentSessionId() {
    return null;
  }
  async close() {}
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

/** Todos os ficheiros de uma pasta (menos o .git e o node_modules), caminho -> texto. */
async function snapshotOf(dir: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found[path.relative(dir, full).split(path.sep).join('/')] = await readFile(full, 'utf8');
    }
  };
  await walk(dir);
  return found;
}

/** Um pedido que muda, cria (também num ignorado), numa pasta funda, e apaga. */
const EDIT = [
  'escreve f.txt=x',
  'escreve novo.txt=n',
  'apaga gone.txt',
  'escreve ignored.log=zzz',
  'escreve sub/dir/deep.txt=d',
].join('\n');

let root: string;
let project: string;
let worktreeRoot: string;

/** Um projeto git com três ficheiros e um .gitignore. */
async function seed(initGit: boolean): Promise<void> {
  await writeFile(path.join(project, 'f.txt'), 'v0\n');
  await writeFile(path.join(project, 'gone.txt'), 'g0\n');
  await writeFile(path.join(project, 'keep.txt'), 'k0\n');
  await writeFile(path.join(project, '.gitignore'), 'ignored.log\n');
  if (!initGit) return;
  git(project, 'init', '--quiet', '-b', 'main');
  git(project, 'config', 'user.email', 'teste@solline.local');
  git(project, 'config', 'user.name', 'Teste');
  git(project, 'config', 'core.autocrlf', 'false');
  git(project, 'add', '-A');
  git(project, 'commit', '--quiet', '-m', 'início');
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'solline-fork-'));
  project = path.join(root, 'project');
  worktreeRoot = path.join(root, 'data', 'worktrees');
  await mkdir(project);
  ForkAdapter.started = [];
  ForkAdapter.received = [];
  ForkAdapter.open = [];
  ForkAdapter.failFork = false;
});

afterEach(async () => {
  ForkAdapter.release();
  // No Windows, um git a acabar ainda segura a pasta por instantes.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('bifurcar no SessionManager', { timeout: 90_000 }, () => {
  let store: CheckpointStore;
  let manager: SessionManager;
  let events: EngineEvent[];

  function make(native = false, checkpoints: CheckpointStore | null = store) {
    events = [];
    manager = new SessionManager({
      emit: (event) => events.push(event),
      registry: testRegistry({
        claude: (options, sink) => new ForkAdapter(options, sink, native),
      }),
      checkpoints: checkpoints ?? undefined,
      worktrees: new WorktreeManager({ root: worktreeRoot }),
    });
  }

  beforeEach(() => {
    store = new CheckpointStore({ root: path.join(root, 'data') });
  });

  afterEach(async () => {
    await manager.disposeAll();
    await store.dispose();
  });

  const lastTimeline = (id: string) =>
    events
      .filter((e): e is SessionTimelineEvent => e.type === 'session.timeline' && e.sessionId === id)
      .at(-1)?.timeline;

  async function start(withCheckpoints = true): Promise<string> {
    const { session } = await manager.create({
      projectId: 'p',
      agent: 'claude',
      cwd: project,
      trusted: true,
    });
    if (withCheckpoints) await waitFor(() => lastTimeline(session.id) !== undefined, 10_000);
    return session.id;
  }

  async function turn(id: string, text: string): Promise<string> {
    const { turnId } = await manager.send(id, text);
    await waitFor(
      () => lastTimeline(id)?.checkpoints.find((c) => c.turnId === turnId)?.state === 'done',
      10_000,
    );
    await waitFor(() => view(id).session.state === 'idle', 10_000);
    return turnId;
  }

  const view = (id: string) => {
    const found = manager.recovery().find((s) => s.view.session.id === id);
    if (!found) throw new Error(`sem sessão ${id}`);
    return found.view;
  };
  const sessionCount = () => manager.recovery().length;
  const worktreeDirs = async () =>
    (await readdir(path.join(worktreeRoot, 'p')).catch(() => [] as string[])).filter(
      (name) => !name.endsWith('.json'),
    );

  it('recusa em projetos sem git, sem criar nada', async () => {
    await seed(false);
    make();
    const a = await start();
    const t1 = await turn(a, 'escreve f.txt=x');
    await expect(manager.fork(a, t1)).rejects.toThrow('Bifurcar só funciona em projetos git.');
    expect(sessionCount()).toBe(1);
    expect(await worktreeDirs()).toEqual([]);
  });

  it('recusa um turno que não existe ou que não tem checkpoint', async () => {
    await seed(true);
    make();
    const a = await start();
    const t1 = await turn(a, 'escreve f.txt=x');
    await expect(manager.fork(a, 'nada')).rejects.toThrow('Este turno já não está na conversa');
    // Os turnos copiados para uma bifurcação não têm checkpoint na sessão nova.
    const { session, turns } = await manager.fork(a, t1);
    expect(turns).toHaveLength(2);
    await expect(manager.fork(session.id, t1)).rejects.toThrow('Este turno não tem checkpoint');
    expect(sessionCount()).toBe(2);
    expect(await worktreeDirs()).toHaveLength(1);
  });

  it('recusa sem checkpoints (desligados)', async () => {
    await seed(true);
    make(false, null);
    const a = await start(false);
    const { turnId } = await manager.send(a, 'escreve f.txt=x');
    await waitFor(() => view(a).session.state === 'idle', 10_000);
    await expect(manager.fork(a, turnId)).rejects.toThrow('Os checkpoints estão desligados');
    expect(await worktreeDirs()).toEqual([]);
  });

  it('recusa com a origem a trabalhar, sem criar nada', async () => {
    await seed(true);
    make();
    const a = await start();
    const t1 = await turn(a, 'escreve f.txt=x');
    const { turnId: running } = await manager.send(a, 'demora');
    await expect(manager.fork(a, t1)).rejects.toThrow(/Espera que o agente acabe/);
    expect(await worktreeDirs()).toEqual([]);
    expect(sessionCount()).toBe(1);
    ForkAdapter.release();
    await waitFor(() => view(a).session.state === 'idle', 10_000);
    expect(running).toEqual(expect.any(String));
  });

  it('os ficheiros da worktree são os do checkpoint: mudado, novo, apagado, fora dos ignorados', async () => {
    await seed(true);
    make();
    const a = await start();
    const t1 = await turn(a, EDIT);
    // O disco da origem ao fim do turno 1 é o que o checkpoint guardou.
    const atCheckpoint = await snapshotOf(project);
    expect(atCheckpoint['f.txt']).toBe('x\n');
    expect(atCheckpoint).not.toHaveProperty('gone.txt');
    await turn(a, 'escreve f.txt=y\nescreve outro.txt=o\nescreve keep.txt=k1');
    const afterSecond = await snapshotOf(project);
    const statusBefore = git(project, 'status', '--porcelain');

    const result = await manager.fork(a, t1);
    const cwd = result.session.cwd;
    expect(cwd.startsWith(worktreeRoot)).toBe(true);
    const { 'ignored.log': ignored, ...expected } = atCheckpoint;
    expect(ignored).toBe('zzz\n');
    expect(await snapshotOf(cwd)).toEqual(expected);
    // A worktree é uma worktree de verdade: o que mudou face ao início vê-se no git dela.
    const status = git(cwd, 'status', '--porcelain')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .sort();
    expect(status).toEqual(['D gone.txt', 'M f.txt', '?? novo.txt', '?? sub/'].sort());

    // A origem fica como estava: pasta, git, conversa, estado e linha do tempo.
    expect(await snapshotOf(project)).toEqual(afterSecond);
    expect(git(project, 'status', '--porcelain')).toBe(statusBefore);
    expect(manager.worktreeOf(a)).toBeUndefined();
    expect(view(a).turns).toHaveLength(4);
    expect(view(a).session.state).toBe('idle');
    expect(view(a).session).not.toHaveProperty('handedTo');
    expect(lastTimeline(a)?.checkpoints.map((c) => c.index)).toEqual([1, 2]);
    expect(lastTimeline(a)?.rewoundTo).toBeNull();
  });

  it('numa sessão em worktree parte da base dela e dá os ficheiros do turno', async () => {
    await seed(true);
    make();
    await start();
    const b = await start();
    const bt1 = await turn(b, 'escreve f.txt=bx\napaga keep.txt');
    const atCheckpoint = await snapshotOf(view(b).session.cwd);
    await turn(b, 'escreve f.txt=by');

    const result = await manager.fork(b, bt1);
    expect(await snapshotOf(result.session.cwd)).toEqual(atCheckpoint);
    // A base é a mesma da origem: o que mudou face a ela é o que o turno mudou.
    const wt = manager.worktreeOf(result.session.id)!;
    expect(wt.base).toBe(manager.worktreeOf(b)!.base);
    expect(wt.path).not.toBe(manager.worktreeOf(b)!.path);
    expect(await snapshotOf(view(b).session.cwd)).toMatchObject({ 'f.txt': 'by\n' });
  });

  it('a sessão nova: mesma conta, origem, nome de branch próprio e trabalho só na worktree dela', async () => {
    await seed(true);
    make();
    const a = await start();
    const t1 = await turn(a, 'escreve f.txt=x');
    const result = await manager.fork(a, t1);
    const info = result.session;

    expect(info).toMatchObject({
      agent: 'claude',
      projectId: 'p',
      settings: { model: 'm' },
      origin: { kind: 'fork', sessionId: a, turnId: t1 },
      workspace: { kind: 'worktree' },
    });
    expect(info.title).toBe('escreve f.txt=x (bifurcação)');
    const branch = manager.worktreeOf(info.id)!.branch;
    expect(branch).toMatch(/^solline\/escreve-f-txt-bifurcacao-[a-z0-9]{4}$/);
    expect(info.workspace).toMatchObject({ branch });
    expect(git(info.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
    // Só ids na linhagem gravada.
    expect(JSON.stringify(view(info.id).session.origin)).not.toMatch(/escreve/);

    // O que a sessão nova faz fica na worktree dela; a origem não vê.
    await turn(info.id, 'escreve g.txt=1');
    expect(existsSync(path.join(info.cwd, 'g.txt'))).toBe(true);
    expect(existsSync(path.join(project, 'g.txt'))).toBe(false);
    expect(view(info.id).session.title).toBe('escreve f.txt=x (bifurcação)');
    expect(lastTimeline(info.id)?.checkpoints).toHaveLength(1);

    // Fechar deitando fora tira a worktree.
    await manager.close(info.id, 'discard', true);
    expect(existsSync(info.cwd)).toBe(false);
    expect(await worktreeDirs()).toEqual([]);
  });

  it('com rebobinar no agente, a conversa continua do ponto guardado e não leva resumo', async () => {
    await seed(true);
    make(true);
    const a = await start();
    const t1 = await turn(a, 'primeiro pedido');
    await turn(a, 'segundo pedido');

    const result = await manager.fork(a, t1);
    expect(result.conversation).toBe('agent');
    // O ponto de antes do turno 2 é o de depois do 1.
    expect(ForkAdapter.started.at(-1)?.fork).toBe('ponto-novo-1');
    await turn(result.session.id, 'terceiro pedido');
    expect(ForkAdapter.received.at(-1)).toMatchObject({ text: 'terceiro pedido' });
    expect(ForkAdapter.received.at(-1)?.context).toBeUndefined();

    // No último turno parte do ponto de agora.
    const last = await manager.fork(a, (await lastUserTurn(a))!);
    expect(last.conversation).toBe('agent');
    expect(ForkAdapter.started.at(-1)?.fork).toBe('ponto-novo-2');
  });

  const lastUserTurn = async (id: string) => view(id).turns.findLast((t) => t.role === 'user')?.id;

  it('sem rebobinar no agente, a sessão nova começa com o resumo até ao turno', async () => {
    await seed(true);
    make(false);
    const a = await start();
    const t1 = await turn(a, 'primeiro pedido');
    await turn(a, 'segundo pedido');

    const result = await manager.fork(a, t1);
    expect(result.conversation).toBe('summary');
    expect(ForkAdapter.started.at(-1)?.fork).toBeUndefined();
    await turn(result.session.id, 'terceiro pedido');
    const sent = ForkAdapter.received.at(-1)!;
    expect(sent.text).toBe('terceiro pedido');
    expect(sent.context).toContain('bifurcação');
    expect(sent.context).toContain('Utilizador: primeiro pedido');
    expect(sent.context).toContain('Agente: Feito: primeiro pedido');
    expect(sent.context).not.toContain('segundo pedido');
    // O resumo segue uma vez.
    await turn(result.session.id, 'quarto pedido');
    expect(ForkAdapter.received.at(-1)?.context).toBeUndefined();
  });

  it('um agente com ponto que falha ao continuar não deixa worktree nem sessão', async () => {
    await seed(true);
    make(true);
    const a = await start();
    const t1 = await turn(a, 'primeiro pedido');
    await turn(a, 'segundo pedido');
    ForkAdapter.failFork = true;
    await expect(manager.fork(a, t1)).rejects.toThrow('não consegue continuar daqui');
    expect(sessionCount()).toBe(1);
    expect(await worktreeDirs()).toEqual([]);
    expect(git(project, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(git(project, 'branch', '--list', 'solline/*')).toBe('');
    expect(view(a).session.state).toBe('idle');
  });

  it('o histórico até ao turno é da sessão nova (vê-se e é o mesmo que a resposta dá)', async () => {
    await seed(true);
    make();
    const a = await start();
    const t1 = await turn(a, 'primeiro pedido');
    await turn(a, 'segundo pedido');

    const result = await manager.fork(a, t1);
    const id = result.session.id;
    expect(result.turns.map((t) => [t.id, t.role])).toEqual([
      [t1, 'user'],
      [`${t1}:a`, 'assistant'],
    ]);
    expect(view(id).turns).toEqual(result.turns);
    // Chegou pelos eventos da sessão nova, antes de qualquer outra coisa.
    const starts = events.filter(
      (e) => e.type === 'session.event' && e.sessionId === id && e.delta.type === 'turn.start',
    );
    expect(starts).toHaveLength(2);
    // E a conversa continua depois dele.
    await turn(id, 'terceiro pedido');
    expect(view(id).turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    // Os da origem não foram tocados.
    expect(view(a).turns).toHaveLength(4);
  });
});

describe('bifurcar e recuperar', { timeout: 90_000 }, () => {
  const key = Buffer.alloc(32, 9);
  const engines: Engine[] = [];
  let id = 0;

  function open(dir: string) {
    const engine = new Engine({
      registry: testRegistry({ claude: (options, sink) => new ForkAdapter(options, sink, false) }),
      dataDir: dir,
      recoveryKey: key,
      isolated: true,
      checks: false,
      reviewer: false,
      worktrees: new WorktreeManager({ root: worktreeRoot }),
      emit: () => undefined,
    });
    engines.push(engine);
    return engine;
  }

  async function ask(engine: Engine, command: string, payload: unknown = {}) {
    const result = await engine.handle({ kind: 'request', id: `f-${++id}`, command, payload });
    if (!result.ok) throw new Error(result.error.message);
    return result.result as Record<string, never> & {
      session: { id: string; cwd: string; origin?: unknown; title: string };
      turns: { id: string }[];
      turnId: string;
    };
  }

  afterEach(async () => {
    ForkAdapter.release();
    for (const engine of engines.splice(0)) await engine.dispose().catch(() => undefined);
  });

  it('depois de reiniciar a bifurcação mantém a worktree, a origem e o histórico, sem órfãs', async () => {
    await seed(true);
    const dir = path.join(root, 'engine-data');
    let engine = open(dir);
    const { session } = await ask(engine, 'session.start', {
      projectId: 'p',
      cwd: project,
      agent: 'claude',
      trusted: true,
    });
    const first = await ask(engine, 'session.send', { sessionId: session.id, text: EDIT });
    const done = () =>
      engine.sessions
        .recovery()
        .find((s) => s.view.session.id === session.id)
        ?.view.timeline?.checkpoints.find((c) => c.turnId === first.turnId)?.state === 'done';
    await waitFor(done, 10_000);
    await waitFor(
      () => engine.sessions.recovery().every((s) => s.view.session.state === 'idle'),
      10_000,
    );

    const forked = await ask(engine, 'session.fork', {
      sessionId: session.id,
      turnId: first.turnId,
    });
    const forkId = forked.session.id;
    const wt = engine.sessions.worktreeOf(forkId)!;
    expect(wt).toBeDefined();
    const files = await snapshotOf(forked.session.cwd);
    expect(files['f.txt']).toBe('x\n');
    expect(files).not.toHaveProperty('gone.txt');

    await engine.shutdown();
    engine = open(dir);
    await engine.ready();
    const snapshot = EngineSnapshot.parse(await ask(engine, 'engine.snapshot'));
    const byId = new Map(snapshot.sessions.map((s) => [s.session.id, s]));
    const recovered = byId.get(forkId)!;
    expect(recovered.session).toMatchObject({
      origin: { kind: 'fork', sessionId: session.id, turnId: first.turnId },
      title: forked.session.title,
      cwd: forked.session.cwd,
    });
    expect(recovered.turns.map((t) => t.id)).toEqual(forked.turns.map((t) => t.id));
    expect(byId.get(session.id)?.session).not.toHaveProperty('handedTo');
    expect(engine.sessions.worktreeOf(forkId)).toEqual(wt);
    expect(await snapshotOf(forked.session.cwd)).toEqual(files);
    // A worktree continua de uma sessão: nenhuma fica órfã.
    expect(await ask(engine, 'worktrees.list')).toEqual({ orphans: [] });
  });
});
