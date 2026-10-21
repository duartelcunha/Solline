import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentCapabilities,
  ConversationDelta,
  EngineEvent,
  SessionChecksEvent,
  SessionQualityEvent,
  SessionTimelineEvent,
} from '@solline/protocol';
import type { ChecksOptions } from '../src/session-manager.ts';
import { WorktreeManager } from '../src/worktrees/worktrees.ts';
import { execFileSync } from 'node:child_process';
import {
  ClaudeSdkAdapter,
  CodexAppServerAdapter,
  SessionManager,
  type AdapterSink,
  type AgentAdapter,
  type AgentStartOptions,
  type Reviewer,
} from '../src/index.ts';
import { CheckpointStore } from '../src/checkpoints/store.ts';
import { commentsMessage, summaryOf } from '../src/review.ts';
import { fakeCodexServer } from './codex-fakes.ts';
import { fakeQuery, loadFixture, recordingSink, testRegistry, waitFor } from './helpers.ts';

const CAPS: AgentCapabilities = {
  models: [{ id: 'm', resolved: null, label: 'M', description: '', efforts: [] }],
  modes: [],
  effort: false,
  effortOrder: [],
  features: { cost: false, context: false, resume: true, rewind: true },
};

/**
 * Um agente de mentira que escreve no disco o que cada mensagem pede ("escreve f.txt=x") e
 * responde logo. Guarda como foi arrancado e o que recebeu, para os testes verem o fork e o
 * resumo.
 */
class ScriptedAdapter implements AgentAdapter {
  static started: AgentStartOptions[] = [];
  static received: { text: string; context: string | undefined }[] = [];
  readonly #options: AgentStartOptions;
  readonly #sink: AdapterSink;
  #turns = 0;
  readonly rewindPoint: (() => string | null) | undefined;

  constructor(options: AgentStartOptions, sink: AdapterSink, native: boolean) {
    this.#options = options;
    this.#sink = sink;
    ScriptedAdapter.started.push(options);
    // Como os agentes de verdade: sem conversa ainda, não há ponto (null = do zero).
    if (native) {
      this.rewindPoint = () =>
        this.#turns === 0 && !this.#options.fork ? null : `ponto-${this.#base()}-${this.#turns}`;
    }
  }

  #base(): string {
    return this.#options.fork ?? 'novo';
  }

  async start() {
    this.#sink.state('idle');
    return { settings: { model: 'm', effort: null, mode: null }, capabilities: CAPS };
  }

  async send(text: string, options: { turnId?: string; context?: string } = {}) {
    const turnId = options.turnId ?? crypto.randomUUID();
    ScriptedAdapter.received.push({ text, context: options.context });
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
    const match = /escreve (\S+)=(\S+)/.exec(text);
    if (match) await writeFile(path.join(this.#options.cwd, match[1]!), `${match[2]}\n`);
    const reply = `${turnId}:a`;
    delta({ type: 'turn.start', turn: { id: reply, role: 'assistant', blocks: [] } });
    delta({
      type: 'block.upsert',
      turnId: reply,
      block: { kind: 'text', id: 'r', text: `Feito: ${text}`, parentToolId: null },
    });
    delta({ type: 'turn.end', turnId: reply, outcome: 'done' });
    this.#turns++;
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

let root: string;
let project: string;
let store: CheckpointStore;
let manager: SessionManager;
let events: EngineEvent[];

function makeManager(
  native: boolean,
  reviewer?: Reviewer,
  checks?: ChecksOptions,
  worktrees?: WorktreeManager,
) {
  events = [];
  manager = new SessionManager({
    emit: (event) => events.push(event),
    registry: testRegistry({
      claude: (options, sink) => new ScriptedAdapter(options, sink, native),
    }),
    checkpoints: store,
    reviewer,
    checks,
    worktrees,
  });
}

async function startSession(): Promise<string> {
  const { session } = await manager.create({
    projectId: 'p',
    agent: 'claude',
    cwd: project,
    trusted: true,
  });
  await waitFor(() => lastTimeline(session.id) !== undefined, 10_000);
  return session.id;
}

function lastTimeline(sessionId: string): SessionTimelineEvent['timeline'] | undefined {
  return events
    .filter(
      (e): e is SessionTimelineEvent => e.type === 'session.timeline' && e.sessionId === sessionId,
    )
    .at(-1)?.timeline;
}

async function turn(sessionId: string, text: string): Promise<string> {
  const { turnId } = await manager.send(sessionId, text);
  await waitFor(
    () => lastTimeline(sessionId)?.checkpoints.find((c) => c.turnId === turnId)?.state === 'done',
    10_000,
  );
  return turnId;
}

const read = (rel: string) => readFile(path.join(project, rel), 'utf8');

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'solline-rw-'));
  project = path.join(root, 'project');
  await mkdir(project);
  await writeFile(path.join(project, 'f.txt'), 'v0\n');
  store = new CheckpointStore({ root: path.join(root, 'data') });
  ScriptedAdapter.started = [];
  ScriptedAdapter.received = [];
});

afterEach(async () => {
  await manager.disposeAll();
  await store.dispose();
  // No Windows, um git a acabar ainda segura a pasta por instantes.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('rever e rebobinar no SessionManager', { timeout: 60_000 }, () => {
  it('cada turno fica com checkpoint e a linha do tempo chega à interface', async () => {
    makeManager(true);
    const id = await startSession();
    const t1 = await turn(id, 'escreve f.txt=v1');
    const timeline = lastTimeline(id)!;
    expect(timeline.checkpoints).toEqual([
      expect.objectContaining({
        turnId: t1,
        index: 1,
        state: 'done',
        stats: { files: 1, additions: 1, deletions: 1 },
      }),
    ]);
    expect(timeline.pending.files).toBe(1);
    const files = await manager.diff(id, { kind: 'turn', turnId: t1 });
    expect(files[0]!.path).toBe('f.txt');

    const after = await manager.review(id, 'reject', 'f.txt');
    expect(after.pending.files).toBe(0);
    expect(await read('f.txt')).toBe('v0\n');
    expect(lastTimeline(id)).toEqual(after);
    await manager.undo(id);
    expect(await read('f.txt')).toBe('v1\n');
  });

  it('rebobina a conversa no agente: fork no ponto guardado antes do turno', async () => {
    makeManager(true);
    const id = await startSession();
    const t1 = await turn(id, 'escreve f.txt=v1');
    const t2 = await turn(id, 'escreve f.txt=v2');
    const result = await manager.rewind(id, t2, { files: true, conversation: true });

    expect(result.conversation).toBe('agent');
    expect(result.text).toBe('escreve f.txt=v2');
    expect(await read('f.txt')).toBe('v1\n');
    // O agente novo arranca do ponto que o antigo deu antes do turno 2 (depois de 1 turno).
    expect(ScriptedAdapter.started.at(-1)?.fork).toBe('ponto-novo-1');
    expect(result.timeline.checkpoints.map((c) => c.turnId)).toEqual([t1]);
    const rewind = events.find(
      (e) => e.type === 'session.event' && e.delta.type === 'rewind',
    ) as Extract<EngineEvent, { type: 'session.event' }>;
    expect(rewind.delta).toEqual({ type: 'rewind', turnId: t2 });

    // E continua: a mensagem seguinte não leva resumo.
    await turn(id, 'escreve f.txt=v3');
    expect(ScriptedAdapter.received.at(-1)?.context).toBeUndefined();
    expect(lastTimeline(id)!.checkpoints.map((c) => c.index)).toEqual([1, 2]);
  });

  it('rebobinar para o primeiro turno abre uma sessão do zero', async () => {
    makeManager(true);
    const id = await startSession();
    const t1 = await turn(id, 'olá');
    await manager.rewind(id, t1, { files: false, conversation: true });
    expect(ScriptedAdapter.started.at(-1)?.fork).toBeUndefined();
    expect(ScriptedAdapter.started.at(-1)?.resume).toBeUndefined();
  });

  it('num agente sem rebobinar, abre uma sessão nova e o resumo segue uma vez', async () => {
    makeManager(false);
    const id = await startSession();
    await turn(id, 'primeiro pedido');
    const t2 = await turn(id, 'segundo pedido');
    const result = await manager.rewind(id, t2, { files: false, conversation: true });
    expect(result.conversation).toBe('summary');
    expect(result.timeline.conversationRewind).toBe('summary');
    expect(ScriptedAdapter.started.at(-1)).toMatchObject({ resume: undefined });
    expect(ScriptedAdapter.started.at(-1)?.fork).toBeUndefined();

    await turn(id, 'terceiro');
    const sent = ScriptedAdapter.received.at(-1)!;
    expect(sent.text).toBe('terceiro');
    expect(sent.context).toContain('Utilizador: primeiro pedido');
    expect(sent.context).toContain('Agente: Feito: primeiro pedido');
    expect(sent.context).not.toContain('segundo pedido');
    await turn(id, 'quarto');
    expect(ScriptedAdapter.received.at(-1)?.context).toBeUndefined();
  });

  it('só os ficheiros: a conversa fica e o checkpoint marca para onde voltou', async () => {
    makeManager(true);
    const id = await startSession();
    const t1 = await turn(id, 'escreve f.txt=v1');
    await turn(id, 'escreve f.txt=v2');
    const result = await manager.rewind(id, t1, { files: true, conversation: false });
    expect(result.conversation).toBeNull();
    expect(result.text).toBeNull();
    expect(await read('f.txt')).toBe('v0\n');
    expect(result.timeline.rewoundTo).toBe(t1);
    expect(result.timeline.checkpoints).toHaveLength(2);
    expect(ScriptedAdapter.started).toHaveLength(1);
  });

  it('recusa rebobinar com o agente a trabalhar', async () => {
    makeManager(true);
    const id = await startSession();
    const { turnId: t1 } = await manager.send(id, 'olá');
    await expect(manager.rewind(id, t1, { files: true, conversation: true })).rejects.toThrow(
      /Espera que o agente acabe/,
    );
    // Nada que escreva no disco corre a meio de um turno; outra mensagem vai para a fila.
    await expect(manager.review(id, 'reject')).rejects.toThrow(/antes de rejeitar/);
    await expect(manager.undo(id)).rejects.toThrow(/antes de desfazer/);
    expect(await manager.send(id, 'outra')).toMatchObject({ how: 'queued' });
    expect(manager.queue(id).items.map((i) => i.text)).toEqual(['outra']);
  });

  it('a fila segue no fim do turno, cada mensagem com o seu checkpoint, sem parar no meio', async () => {
    makeManager(true);
    const id = await startSession();
    expect(await manager.send(id, 'escreve f.txt=v1')).toMatchObject({ how: 'sent' });
    expect(await manager.send(id, 'escreve f.txt=v2')).toMatchObject({ how: 'queued' });
    await waitFor(
      () =>
        lastTimeline(id)?.checkpoints.length === 2 &&
        lastTimeline(id)!.checkpoints.every((c) => c.state === 'done'),
      10_000,
    );
    expect(await read('f.txt')).toBe('v2\n');
    expect(ScriptedAdapter.received.map((r) => r.text)).toEqual([
      'escreve f.txt=v1',
      'escreve f.txt=v2',
    ]);
    // Entre os dois turnos a sessão não passou por "parada".
    const states = events
      .filter((e) => e.type === 'session.state' && e.sessionId === id)
      .map((e) => (e as { state: string }).state);
    const afterFirst = states.slice(states.indexOf('running'));
    expect(afterFirst.filter((s) => s === 'idle')).toHaveLength(1);
    expect(afterFirst.at(-1)).toBe('idle');
  });

  it('os comentários seguem como mensagem, com a linha citada', async () => {
    makeManager(true);
    const id = await startSession();
    await turn(id, 'escreve f.txt=v1');
    await manager.comment(
      id,
      [{ path: 'f.txt', line: 1, side: 'new', text: 'Porquê v1?' }],
      'Vê isto.',
    );
    const sent = ScriptedAdapter.received.at(-1)!.text;
    expect(sent).toBe(
      [
        'Revi as alterações e deixei comentários em linhas concretas:',
        '**f.txt, linha 1**\n> v1\nPorquê v1?',
        'Vê isto.',
      ].join('\n\n'),
    );
  });
});

describe('resumo e comentários', () => {
  it('o resumo guarda as mensagens mais recentes quando não cabe tudo', () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`,
      role: 'user' as const,
      blocks: [
        { kind: 'text' as const, id: 'x', text: `${i} ${'a'.repeat(1_000)}`, parentToolId: null },
      ],
    }));
    const summary = summaryOf(turns)!;
    expect(summary).toContain('Utilizador: 29 ');
    expect(summary).not.toContain('Utilizador: 0 ');
    expect(summary).toMatch(/\(\d+ mensagens mais antigas ficaram de fora\)/);
    expect(summaryOf([])).toBeUndefined();
  });

  it('uma linha apagada cita a versão antiga', () => {
    const message = commentsMessage(
      [{ path: 'a.ts', line: 2, side: 'old', text: 'Isto fazia falta' }],
      [
        {
          path: 'a.ts',
          status: 'modified',
          binary: false,
          additions: 0,
          deletions: 1,
          hunks: [
            {
              id: 'h',
              header: '@@ -1,2 +1,1 @@',
              oldStart: 1,
              oldLines: 2,
              newStart: 1,
              newLines: 1,
              lines: [
                { kind: 'context', text: 'um', oldNo: 1, newNo: 1 },
                { kind: 'del', text: 'dois', oldNo: 2, newNo: null },
              ],
            },
          ],
        },
      ],
    );
    expect(message).toContain('**a.ts, linha 2 (versão antiga)**\n> dois\nIsto fazia falta');
  });
});

describe('pontos de rebobinar nos adaptadores', () => {
  it('Claude: o ponto é a última entrada da conversa e o fork usa resumeSessionAt', async () => {
    const fake = fakeQuery(loadFixture('plain-answer'));
    const sink = recordingSink();
    const adapter = new ClaudeSdkAdapter(
      { cwd: 'C:/p', mode: 'default', queryFn: fake.queryFn },
      sink,
    );
    await adapter.start();
    expect(adapter.rewindPoint()).toBeNull();
    await adapter.send('olá', {
      turnId: '00000000-0000-4000-8000-000000000001',
      context: 'resumo',
    });
    await waitFor(
      () => sink.states.at(-1)?.state === 'idle' && sink.deltas.some((d) => d.type === 'turn.end'),
    );
    const point = JSON.parse(adapter.rewindPoint()!) as { session: string; at: string };
    expect(point.session).toEqual(expect.any(String));
    expect(point.at).toEqual(expect.any(String));
    // O resumo vai para o Claude mas a conversa mostra só a mensagem.
    expect(sink.deltas[0]).toMatchObject({
      type: 'turn.start',
      turn: { id: '00000000-0000-4000-8000-000000000001', blocks: [{ text: 'olá' }] },
    });
    await adapter.close();

    const forked = fakeQuery(loadFixture('plain-answer'));
    const again = new ClaudeSdkAdapter(
      { cwd: 'C:/p', mode: 'default', queryFn: forked.queryFn, fork: JSON.stringify(point) },
      recordingSink(),
    );
    await again.start();
    expect(forked.options()).toMatchObject({
      resume: point.session,
      resumeSessionAt: point.at,
      forkSession: true,
    });
    expect(again.agentSessionId()).toBeNull();
    expect(again.rewindPoint()).toBe(JSON.stringify(point));
    await again.close();
  });

  it('Codex: o fork pede thread/fork até ao último turno acabado', async () => {
    const server = fakeCodexServer();
    const sink = recordingSink();
    const adapter = new CodexAppServerAdapter(
      { cwd: 'C:/p', mode: 'ask', transport: server.transport },
      sink,
    );
    await adapter.start();
    expect(adapter.rewindPoint()).toBeNull();
    await adapter.send('olá', { context: 'resumo' });
    const started = await server.waitFor((m) => m.method === 'turn/start');
    expect((started.params as { input: { text: string }[] }).input[0]!.text).toBe(
      'resumo\n\n---\n\nolá',
    );
    server.notify('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', items: [], status: 'completed', error: null },
    });
    await waitFor(() => sink.states.at(-1)?.state === 'idle');
    const point = adapter.rewindPoint();
    expect(JSON.parse(point!)).toEqual({ thread: 'thread-1', lastTurn: 'turn-1' });
    await adapter.close();

    const server2 = fakeCodexServer();
    const again = new CodexAppServerAdapter(
      { cwd: 'C:/p', mode: 'ask', transport: server2.transport, fork: point! },
      recordingSink(),
    );
    await again.start();
    const fork = await server2.waitFor((m) => m.method === 'thread/fork');
    expect(fork.params).toMatchObject({ threadId: 'thread-1', lastTurnId: 'turn-1' });
    expect(again.agentSessionId()).toBe('thread-1-fork');
    await again.close();
  });
});

describe('segunda opinião no fim de cada turno', { timeout: 60_000 }, () => {
  const quality = (sessionId: string) =>
    events
      .filter(
        (e): e is SessionQualityEvent => e.type === 'session.quality' && e.sessionId === sessionId,
      )
      .at(-1)?.quality;

  it('revê o diff do turno que mudou ficheiros e o corrigir segue para o agente', async () => {
    const seen: Parameters<Reviewer>[0][] = [];
    makeManager(true, async (input) => {
      seen.push(input);
      return [
        { path: 'f.txt', line: 1, severity: 'slop', title: 'Valor sem sentido', detail: 'Usa v2.' },
      ];
    });
    const id = await startSession();
    const t1 = await turn(id, 'escreve f.txt=v1');
    await waitFor(() => quality(id)?.review.state === 'done', 10_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ request: 'escreve f.txt=v1', cwd: project });
    expect(seen[0]!.diff.map((f) => f.path)).toEqual(['f.txt']);
    const findings = quality(id)!.review.findings;
    expect(findings).toEqual([expect.objectContaining({ id: `${t1}-1`, severity: 'slop' })]);

    await manager.fix(id, [findings[0]!.id]);
    expect(ScriptedAdapter.received.at(-1)!.text).toContain('f.txt:1: Valor sem sentido');
  });

  it('um turno sem ficheiros mudados não gasta o revisor; desligado também não', async () => {
    let calls = 0;
    makeManager(true, async () => {
      calls++;
      return [];
    });
    const id = await startSession();
    await turn(id, 'só uma pergunta');
    manager.setQualityEnabled(id, false);
    await turn(id, 'escreve f.txt=v1');
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(0);
    expect(manager.quality(id).enabled).toBe(false);
  });

  it('uma falha do revisor fica no estado, sem partir a sessão', async () => {
    makeManager(true, () => Promise.reject(new Error('sem rede')));
    const id = await startSession();
    await turn(id, 'escreve f.txt=v1');
    await waitFor(() => quality(id)?.review.state === 'error', 10_000);
    expect(quality(id)!.review.error).toBe('sem rede');
    await turn(id, 'escreve f.txt=v2');
  });
});

describe('verificações do projeto no fim de cada turno', { timeout: 60_000 }, () => {
  const checks = (sessionId: string) =>
    events
      .filter(
        (e): e is SessionChecksEvent => e.type === 'session.checks' && e.sessionId === sessionId,
      )
      .at(-1)?.checks;
  const spec = { id: 'lint', label: 'Lint', command: 'pnpm lint', enabled: true };

  it('corre depois de um turno que mudou ficheiros; a falha segue para o agente', async () => {
    const ran: string[] = [];
    makeManager(true, undefined, {
      detect: async () => [spec],
      run: async (command) => {
        ran.push(command);
        return { state: 'failed', tail: 'a.ts:1 erro', durationMs: 3 };
      },
    });
    const id = await startSession();
    await turn(id, 'só uma pergunta');
    await new Promise((r) => setTimeout(r, 100));
    expect(ran).toEqual([]);
    const t2 = await turn(id, 'escreve f.txt=v1');
    await waitFor(() => checks(id)?.results[0]?.state === 'failed', 10_000);
    expect(ran).toEqual(['pnpm lint']);
    expect(checks(id)).toMatchObject({ turnId: t2, detected: true });

    await manager.fixCheck(id, 'lint');
    expect(ScriptedAdapter.received.at(-1)!.text).toContain('a.ts:1 erro');
  });

  it('sem confiança não corre; rebobinar esquece os resultados', async () => {
    let calls = 0;
    makeManager(true, undefined, {
      detect: async () => [spec],
      run: async () => (calls++, { state: 'passed', tail: null, durationMs: 1 }),
    });
    const id = await startSession();
    const t1 = await turn(id, 'escreve f.txt=v1');
    await waitFor(() => checks(id)?.results[0]?.state === 'passed', 10_000);
    await manager.rewind(id, t1, { files: true, conversation: false });
    expect(manager.checks(id)).toMatchObject({ turnId: null, results: [] });

    manager.setProjectTrust('p', false);
    await turn(id, 'escreve f.txt=v2');
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(1);
    await expect(manager.runChecks(id)).rejects.toThrow('confiança');
  });
});

describe('uma worktree por sessão a mais', { timeout: 60_000 }, () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

  function gitProject() {
    git(project, 'init', '--quiet', '-b', 'main');
    git(project, 'config', 'user.email', 'teste@solline.local');
    git(project, 'config', 'user.name', 'Teste');
    git(project, 'config', 'core.autocrlf', 'false');
    git(project, 'add', '-A');
    git(project, 'commit', '--quiet', '-m', 'início');
    return new WorktreeManager({ root: path.join(root, 'data', 'worktrees') });
  }

  it('a primeira sessão fica na pasta; a segunda trabalha na sua worktree e traz por merge', async () => {
    makeManager(true, undefined, undefined, gitProject());
    const first = await startSession();
    const second = await startSession();
    const infoOf = (id: string) =>
      [...events].reverse().find((e) => e.type === 'session.workspace' && e.sessionId === id) as
        { workspace: { kind: string; branch?: string; stats?: { files: number } } } | undefined;

    await turn(second, 'escreve f.txt=da-worktree');
    await waitFor(() => infoOf(second)?.workspace.stats?.files === 1, 10_000);
    expect(infoOf(second)!.workspace.branch).toMatch(/^solline\/escreve-f-txt-da-/);
    // O projeto continua como estava até se trazer.
    expect(await read('f.txt')).toBe('v0\n');

    const result = await manager.bring(second);
    expect(result).toMatchObject({ merged: true, into: 'main' });
    expect(await read('f.txt')).toBe('da-worktree' + String.fromCharCode(10));
    expect(infoOf(first)).toBeUndefined();

    expect(await manager.close(second)).toEqual({ closed: true });
  });

  it('fechar com mudanças por trazer pede escolha; deitar fora apaga o branch', async () => {
    makeManager(true, undefined, undefined, gitProject());
    await startSession();
    const second = await startSession();
    await turn(second, 'escreve g.txt=x');
    expect(await manager.close(second)).toMatchObject({ closed: false, stats: { files: 1 } });
    expect(await manager.close(second, 'discard')).toEqual({ closed: true });
    expect(git(project, 'branch', '--list', 'solline/*')).toBe('');
  });

  it('a worktree que fica por trazer quando a app fecha aparece como órfã e traz-se', async () => {
    const worktrees = gitProject();
    makeManager(true, undefined, undefined, worktrees);
    await startSession();
    const second = await startSession();
    await turn(second, 'escreve h.txt=orfa');
    await manager.disposeAll();

    makeManager(true, undefined, undefined, worktrees);
    const orphans = await manager.orphans();
    expect(orphans).toEqual([
      expect.objectContaining({ projectId: 'p', stats: { files: 1, additions: 1, deletions: 0 } }),
    ]);
    expect(await manager.bringOrphan(orphans[0]!.id)).toMatchObject({ merged: true });
    expect(await read('h.txt')).toBe('orfa' + String.fromCharCode(10));
    expect(await manager.orphans()).toEqual([]);
  });

  it('a worktree prepara-se com as portas da sessão; o que escreves espera e segue depois', async () => {
    let finish: () => void = () => undefined;
    const runs: { command: string; cwd: string; env: Record<string, string> | undefined }[] = [];
    makeManager(
      true,
      undefined,
      {
        detect: async () => [],
        run: (command, options) => {
          runs.push({ command, cwd: options.cwd, env: options.env });
          return new Promise((resolve) => {
            finish = () => resolve({ state: 'passed', tail: null, durationMs: 1 });
          });
        },
      },
      gitProject(),
    );
    await writeFile(path.join(project, '.env'), 'SEGREDO=1\n');
    await startSession();
    const { session } = await manager.create({
      projectId: 'p',
      agent: 'claude',
      cwd: project,
      trusted: true,
      setup: { command: 'prepara', copyEnv: true },
    });
    expect(session.port).toBeGreaterThanOrEqual(41_000);
    expect(session.setup).toMatchObject({ state: 'running' });
    await waitFor(() => runs.length === 1, 10_000);
    expect(runs[0]).toMatchObject({
      command: 'prepara',
      cwd: session.cwd,
      env: { SOLLINE_PORT: String(session.port), SOLLINE_WORKSPACE_PATH: session.cwd },
    });
    // O .env da raiz chegou à worktree antes do comando.
    expect(await readFile(path.join(session.cwd, '.env'), 'utf8')).toBe('SEGREDO=1\n');

    expect(await manager.send(session.id, 'olá')).toMatchObject({ how: 'queued' });
    expect(ScriptedAdapter.received.map((r) => r.text)).not.toContain('olá');
    finish();
    await waitFor(() => ScriptedAdapter.received.some((r) => r.text === 'olá'), 10_000);
    const setup = events
      .filter((e) => e.type === 'session.setup' && e.sessionId === session.id)
      .at(-1) as { setup: { state: string } } | undefined;
    expect(setup?.setup.state).toBe('done');
  });

  it('sem git, a segunda sessão partilha a pasta', async () => {
    makeManager(true, undefined, undefined, new WorktreeManager({ root: path.join(root, 'wt') }));
    await startSession();
    const { session } = await manager.create({
      projectId: 'p',
      agent: 'claude',
      cwd: project,
      trusted: true,
    });
    expect(session.workspace).toEqual({ kind: 'shared' });
    expect(session.cwd).toBe(project);
  });
});
