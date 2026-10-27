import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EngineSnapshot,
  type AgentCapabilities,
  type EngineEvent,
  type SessionHandoffEvent,
  type SessionInfo,
  type SessionTimelineEvent,
} from '@solline/protocol';
import { Engine } from '../src/engine.ts';
import { CheckpointStore } from '../src/checkpoints/store.ts';
import { replay } from '../src/recovery/records.ts';
import type { RecoveryState } from '../src/recovery/state.ts';
import {
  DRAFT_HEADERS,
  NOTHING,
  assembleDraft,
  claudeDrafter,
  draftHandoff,
  handoffMessage,
  mechanicalSections,
  objectiveOf,
  type DraftSections,
  type Drafter,
} from '../src/handoff/drafter.ts';
import { WorktreeManager } from '../src/worktrees/worktrees.ts';
import {
  SessionManager,
  type AdapterSink,
  type AgentAdapter,
  type AgentStartOptions,
} from '../src/index.ts';
import { testRegistry, waitFor } from './helpers.ts';

const CAPS: AgentCapabilities = {
  models: [{ id: 'm', resolved: null, label: 'M', description: '', efforts: [] }],
  modes: [],
  effort: false,
  effortOrder: [],
  features: { cost: false, context: false, resume: true, rewind: false },
};

/**
 * Um agente de mentira: escreve no disco o que a mensagem pede ("escreve f.txt=x") e responde
 * logo. "demora" deixa o turno aberto até `release()`; `failSend` faz o envio falhar.
 */
class FakeAdapter implements AgentAdapter {
  static sent: { cwd: string; text: string }[] = [];
  static open: (() => void)[] = [];
  readonly #options: AgentStartOptions;
  readonly #sink: AdapterSink;
  readonly #failSend: boolean;

  constructor(options: AgentStartOptions, sink: AdapterSink, failSend = false) {
    this.#options = options;
    this.#sink = sink;
    this.#failSend = failSend;
  }

  static release(): void {
    for (const finish of FakeAdapter.open.splice(0)) finish();
  }

  async start() {
    this.#sink.state('idle');
    return { settings: { model: 'm', effort: null, mode: null }, capabilities: CAPS };
  }

  async send(text: string, options: { turnId?: string } = {}) {
    if (this.#failSend) throw new Error('o agente recusou a mensagem');
    const turnId = options.turnId ?? crypto.randomUUID();
    FakeAdapter.sent.push({ cwd: this.#options.cwd, text });
    this.#sink.delta({
      type: 'turn.start',
      turn: {
        id: turnId,
        role: 'user',
        blocks: [{ kind: 'text', id: 't', text, parentToolId: null }],
      },
    });
    this.#sink.state('running');
    // Só uma linha que seja o pedido: o aviso da passagem cita o título e não deve escrever nada.
    const match = /^escreve (\S+)=(\S+)$/m.exec(text);
    if (match) await writeFile(path.join(this.#options.cwd, match[1]!), `${match[2]}\n`);
    const finish = () => {
      const reply = `${turnId}:a`;
      this.#sink.delta({ type: 'turn.start', turn: { id: reply, role: 'assistant', blocks: [] } });
      this.#sink.delta({
        type: 'block.upsert',
        turnId: reply,
        block: { kind: 'text', id: 'r', text: `Feito: ${text.slice(0, 40)}`, parentToolId: null },
      });
      this.#sink.delta({ type: 'turn.end', turnId: reply, outcome: 'done' });
      this.#sink.state('idle');
    };
    if (text.includes('demora')) FakeAdapter.open.push(finish);
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
    return CAPS;
  }
  agentSessionId() {
    return null;
  }
  async close() {}
}

/** Os dois agentes do teste: o Claude normal e o Codex, que pode falhar a primeira mensagem. */
const failing = { codex: false };
const registry = () =>
  testRegistry({
    claude: (options, sink) => new FakeAdapter(options, sink),
    codex: (options, sink) => new FakeAdapter(options, sink, failing.codex),
  });

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

let root: string;
let project: string;

function gitProject(): WorktreeManager {
  git(project, 'init', '--quiet', '-b', 'main');
  git(project, 'config', 'user.email', 'teste@solline.local');
  git(project, 'config', 'user.name', 'Teste');
  git(project, 'config', 'core.autocrlf', 'false');
  git(project, 'add', '-A');
  git(project, 'commit', '--quiet', '-m', 'início');
  return new WorktreeManager({ root: path.join(root, 'data', 'worktrees') });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'solline-handoff-'));
  project = path.join(root, 'project');
  await mkdir(project);
  await writeFile(path.join(project, 'f.txt'), 'v0\n');
  FakeAdapter.sent = [];
  FakeAdapter.open = [];
  failing.codex = false;
});

afterEach(async () => {
  FakeAdapter.release();
  // No Windows, um git a acabar ainda segura a pasta por instantes.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const sections: DraftSections = {
  objective: 'Executar a fase 1 do plano.',
  decisions: ['Fica o Zod no protocolo, porque valida nos dois lados.'],
  openQuestions: [],
  nextSteps: ['Criar `handoff.ts`.', 'Ligar o comando no motor.'],
  verification: ['pnpm test'],
};

describe('o rascunho da passagem', () => {
  it('as secções saem com os cabeçalhos fixos, pela mesma ordem, e "(nada)" quando vazias', () => {
    const text = assembleDraft(
      { objective: 'Fazer X.', decisions: [], openQuestions: [], nextSteps: [], verification: [] },
      [],
    );
    const headers = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headers).toEqual([
      'Objetivo',
      'Decisões e o que se pôs de parte',
      'Ficheiros tocados',
      'Perguntas em aberto',
      'Próximos passos',
      'Verificação',
    ]);
    expect(Object.values(DRAFT_HEADERS)).toEqual([
      'Objetivo',
      'Decisões e o que se pôs de parte',
      'Ficheiros tocados',
      'Perguntas em aberto',
      'Próximos passos',
      'Verificação',
    ]);
    expect(text).toContain('## Objetivo\nFazer X.');
    expect(text.split(NOTHING).length - 1).toBe(5);
    expect(assembleDraft({ ...sections, objective: '  ' }, [])).toContain(
      `## Objetivo\n${NOTHING}`,
    );
  });

  it('os ficheiros são os da Solline, no formato "caminho (+a −r)", com binários e corte', () => {
    const text = assembleDraft(sections, [
      { path: 'src/a.ts', additions: 3, deletions: 1 },
      { path: 'logo.png', additions: 0, deletions: 0, binary: true },
    ]);
    expect(text).toContain('## Ficheiros tocados\n- src/a.ts (+3 −1)\n- logo.png (binário)');
    // O que está nas outras secções não se mistura com os ficheiros.
    expect(text).toContain('- Fica o Zod no protocolo, porque valida nos dois lados.');
    const many = Array.from({ length: 130 }, (_, i) => ({
      path: `f${i}.ts`,
      additions: 1,
      deletions: 0,
    }));
    const long = assembleDraft(sections, many);
    expect(long).toContain('… e mais 30 ficheiros');
    expect(long).not.toContain('f100.ts');
  });

  it('listas dadas como texto viram itens; excesso e vazios saem', () => {
    const text = assembleDraft(
      {
        ...sections,
        decisions: ['- um', '', '  * dois  '],
        nextSteps: Array.from({ length: 20 }, (_, i) => `passo ${i}`),
      },
      [],
    );
    expect(text).toContain('## Decisões e o que se pôs de parte\n- um\n- dois\n');
    expect(text).toContain('- passo 11');
    expect(text).not.toContain('passo 12');
  });

  it('o objetivo (primeira linha) dá o nome à sessão nova', () => {
    expect(objectiveOf(assembleDraft(sections, []))).toBe('Executar a fase 1 do plano.');
    expect(objectiveOf('sem cabeçalhos')).toBeUndefined();
    expect(objectiveOf(assembleDraft({ ...sections, objective: '' }, []))).toBeUndefined();
  });

  it('o aviso da primeira mensagem diz de onde vem o trabalho e vai antes do rascunho', () => {
    expect(
      handoffMessage({ label: 'Claude', title: 'Corrigir o login' }, '  ## Objetivo\nX  '),
    ).toBe(
      'Passagem de testemunho de Claude (Corrigir o login). ' +
        'O trabalho já feito está na pasta; não repitas o que já foi feito.\n\n## Objetivo\nX',
    );
  });

  const request = {
    cwd: '.',
    goal: 'Executa a fase 1 do plano',
    source: { label: 'Claude', title: 'Planear' },
    target: { label: 'Codex' },
    transcript: 'Utilizador: faz o plano',
    lastRequest: 'faz o plano',
    files: [{ path: 'docs/plano.md', additions: 40, deletions: 0 }],
  };

  it('sem redator, o rascunho é mecânico: objetivo, último pedido e ficheiros', async () => {
    const result = await draftHandoff(undefined, request);
    expect(result.drafted).toBe('mechanical');
    expect(result.warning).toMatch(/mecânico/);
    expect(result.cost).toBeNull();
    expect(result.text).toContain(
      '## Objetivo\nExecuta a fase 1 do plano\n\nÚltimo pedido na sessão anterior: faz o plano',
    );
    expect(result.text).toContain('- docs/plano.md (+40 −0)');
    expect(result.text.split(NOTHING).length - 1).toBe(4);
    expect(mechanicalSections('x', '').objective).toBe('x');
  });

  it('se o redator falha, sai o mecânico com a razão', async () => {
    const drafter: Drafter = async () => {
      throw new Error('sem rede');
    };
    const result = await draftHandoff(drafter, request);
    expect(result.drafted).toBe('mechanical');
    expect(result.warning).toContain('sem rede');
    expect(result.text).toContain('Executa a fase 1 do plano');
  });

  it('com o redator, usa as secções dele; objetivo vazio cai no do utilizador', async () => {
    const seen: unknown[] = [];
    const drafter: Drafter = async (input) => {
      seen.push(input);
      return { sections: { ...sections, objective: ' ' }, cost: 0.07 };
    };
    const result = await draftHandoff(drafter, request);
    expect(result).toMatchObject({ drafted: 'model', cost: 0.07 });
    expect(result.warning).toBeUndefined();
    expect(result.text).toContain('## Objetivo\nExecuta a fase 1 do plano');
    expect(result.text).toContain('- Criar `handoff.ts`.');
    expect(result.text).toContain('- docs/plano.md (+40 −0)');
    // O redator recebe os ficheiros e a conversa, não o último pedido do rascunho mecânico.
    expect(seen[0]).toMatchObject({ transcript: 'Utilizador: faz o plano', files: request.files });
    expect(seen[0]).not.toHaveProperty('lastRequest');
  });

  it('um pedido cancelado falha em vez de virar rascunho mecânico', async () => {
    const abort = new AbortController();
    const drafter: Drafter = async () => {
      abort.abort();
      throw new Error('abortado');
    };
    await expect(draftHandoff(drafter, { ...request, signal: abort.signal })).rejects.toThrow(
      'cancelado',
    );
  });
});

describe('o redator Claude', () => {
  const input = {
    cwd: 'C:/proj',
    goal: 'Executa a fase 1',
    source: { label: 'Claude', title: 'Planear' },
    target: { label: 'Codex', model: 'gpt-x' },
    transcript: 'Utilizador: faz o plano\n\nAgente: feito',
    files: [{ path: 'a.ts', additions: 2, deletions: 0 }],
  };

  function fake(result: Record<string, unknown>) {
    const calls: { prompt: string; options: Record<string, unknown> }[] = [];
    const queryFn = ((args: { prompt: string; options: Record<string, unknown> }) => {
      calls.push(args);
      return (async function* () {
        yield { type: 'result', subtype: 'success', ...result };
      })();
    }) as never;
    return { queryFn, calls };
  }

  it('devolve as secções (listas ou texto com uma linha por item) e o custo', async () => {
    const { queryFn } = fake({
      total_cost_usd: 0.09,
      structured_output: {
        objective: 'Fazer a fase 1.',
        decisions: ['A', 'B'],
        openQuestions: '- Qual a versão?\n- E o Windows?',
        nextSteps: ['Passo um'],
        verification: [],
      },
    });
    const out = await claudeDrafter({ queryFn })(input);
    expect(out.cost).toBe(0.09);
    expect(out.sections).toEqual({
      objective: 'Fazer a fase 1.',
      decisions: ['A', 'B'],
      openQuestions: ['Qual a versão?', 'E o Windows?'],
      nextSteps: ['Passo um'],
      verification: [],
    });
  });

  it('só lê (ferramentas de leitura, sem sessão gravada nem definições) e vê o essencial', async () => {
    const { queryFn, calls } = fake({
      structured_output: {
        objective: 'x',
        decisions: [],
        openQuestions: [],
        nextSteps: [],
        verification: [],
      },
    });
    await claudeDrafter({ queryFn })(input);
    const options = calls[0]?.options as Record<string, unknown>;
    expect(options.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(options.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(options.permissionMode).toBe('default');
    expect(options.persistSession).toBe(false);
    expect(options.settingSources).toEqual([]);
    expect(options.cwd).toBe('C:/proj');
    const canUse = options.canUseTool as (
      name: string,
      input: Record<string, unknown>,
    ) => Promise<{ behavior: string }>;
    expect((await canUse('Read', {})).behavior).toBe('allow');
    expect((await canUse('Bash', {})).behavior).toBe('deny');
    expect((await canUse('Write', {})).behavior).toBe('deny');
    const prompt = calls[0]?.prompt ?? '';
    expect(prompt).toContain('Executa a fase 1');
    expect(prompt).toContain('Codex (model gpt-x)');
    expect(prompt).toContain('a.ts (+2 −0)');
    expect(prompt).toContain('Utilizador: faz o plano');
  });

  it('formato inválido ou falha do SDK são erros claros (o motor cai no mecânico)', async () => {
    const bad = fake({ structured_output: { objective: 7 } });
    await expect(claudeDrafter({ queryFn: bad.queryFn })(input)).rejects.toThrow(
      'formato inesperado',
    );
    const none = fake({});
    await expect(claudeDrafter({ queryFn: none.queryFn })(input)).rejects.toThrow(
      'formato inesperado',
    );
    const failed = (() =>
      (async function* () {
        yield { type: 'result', subtype: 'error_max_turns' };
      })()) as never;
    await expect(claudeDrafter({ queryFn: failed })(input)).rejects.toThrow('não conseguiu acabar');
    const silent = (() => (async function* () {})()) as never;
    await expect(claudeDrafter({ queryFn: silent })(input)).rejects.toThrow('sem resposta');
  });
});

describe('passar o testemunho no SessionManager', { timeout: 60_000 }, () => {
  let store: CheckpointStore;
  let manager: SessionManager;
  let events: EngineEvent[];

  function make(worktrees?: WorktreeManager, checkpoints: CheckpointStore | null = store) {
    events = [];
    manager = new SessionManager({
      emit: (event) => events.push(event),
      registry: registry(),
      checkpoints: checkpoints ?? undefined,
      worktrees,
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

  async function start(agent = 'claude'): Promise<string> {
    const { session } = await manager.create({
      projectId: 'p',
      agent,
      cwd: project,
      trusted: true,
    });
    await waitFor(() => lastTimeline(session.id) !== undefined, 10_000);
    return session.id;
  }

  async function turn(id: string, text: string): Promise<string> {
    const { turnId } = await manager.send(id, text);
    await waitFor(
      () => lastTimeline(id)?.checkpoints.find((c) => c.turnId === turnId)?.state === 'done',
      10_000,
    );
    return turnId;
  }

  const idle = (id: string) => waitFor(() => view(id).session.state === 'idle', 10_000);
  const view = (id: string) => {
    const found = manager.recovery().find((s) => s.view.session.id === id);
    if (!found) throw new Error(`sem sessão ${id}`);
    return found.view;
  };
  const savedOf = (id: string) => manager.recovery().find((s) => s.view.session.id === id)!;
  const handoffs = (id: string) =>
    events.filter(
      (e): e is SessionHandoffEvent => e.type === 'session.handoff' && e.sessionId === id,
    );

  /** A segunda sessão do projeto trabalha na worktree; já mexeu num ficheiro. */
  async function worktreeSession() {
    make(gitProject());
    await start();
    const second = await start();
    const lastTurn = await turn(second, 'escreve f.txt=x');
    return { second, lastTurn };
  }

  const draft = assembleDraft(sections, []);
  const sessionTitle = 'escreve f.txt=x';

  it('abre a sessão nova na mesma pasta e a worktree muda de dono', async () => {
    const { second, lastTurn } = await worktreeSession();
    const wt = manager.worktreeOf(second)!;
    const cwd = view(second).session.cwd;
    expect(wt).toBeDefined();

    const result = await manager.handoff(second, { agent: 'codex', model: 'm', text: draft });
    const target = result.session;
    expect(target.agent).toBe('codex');
    expect(target.cwd).toBe(cwd);
    expect(target.workspace).toMatchObject({ kind: 'worktree', branch: wt.branch });
    expect(target.origin).toEqual({
      kind: 'handoff',
      sessionId: second,
      turnId: view(second).turns.at(-1)?.id,
    });
    expect(lastTurn).toBeDefined();
    expect(view(second).session.handedTo).toBe(target.id);
    expect(target.handedTo).toBeUndefined();
    // A pasta tem um só dono: a nova sessão.
    expect(manager.worktreeOf(target.id)).toEqual(wt);
    expect(manager.worktreeOf(second)).toBeUndefined();
    expect(await manager.orphans()).toEqual([]);
    expect(savedOf(target.id).worktree).toEqual(wt);
    expect(savedOf(second).worktree).toBeUndefined();
    // O nome vem do objetivo, não do aviso.
    expect(target.title).toBe('Executar a fase 1 do plano.');
    expect(handoffs(second).map((e) => e.handedTo)).toEqual([target.id]);
    expect(handoffs(target.id).map((e) => e.handedTo)).toEqual([null]);
  });

  it('a primeira mensagem é uma mensagem normal e visível: o aviso e o rascunho', async () => {
    const { second } = await worktreeSession();
    const cwd = view(second).session.cwd;
    const { session, turnId } = await manager.handoff(second, { agent: 'codex', text: draft });
    const expected = `Passagem de testemunho de Claude (${sessionTitle}). O trabalho já feito está na pasta; não repitas o que já foi feito.\n\n${draft}`;
    expect(FakeAdapter.sent.at(-1)).toEqual({ cwd, text: expected });
    const first = view(session.id).turns[0]!;
    expect(first).toMatchObject({ id: turnId, role: 'user' });
    expect(first.blocks[0]).toMatchObject({ kind: 'text', text: expected });
    // O nome fica o do objetivo depois da mensagem chegar.
    expect(view(session.id).session.title).toBe('Executar a fase 1 do plano.');
    // Nenhum contexto escondido: a conversa antiga não viaja.
    expect(savedOf(session.id).context).toBeUndefined();
  });

  it('a nova sessão traz e fecha a worktree; a antiga não pode', async () => {
    const { second } = await worktreeSession();
    const { session } = await manager.handoff(second, { agent: 'codex', text: draft });
    await idle(session.id);
    await expect(manager.bring(second)).rejects.toThrow('passou o testemunho a');
    expect(await manager.bring(session.id)).toMatchObject({ merged: true, into: 'main' });
    expect(git(project, 'show', 'HEAD:f.txt')).toBe('x');
  });

  it('quem passou só se lê: enviar, fila, guiar, rejeitar, desfazer e rebobinar ficheiros recusam', async () => {
    const { second, lastTurn } = await worktreeSession();
    const { session } = await manager.handoff(second, { agent: 'codex', text: draft });
    const message = `Esta sessão passou o testemunho a ${session.title}. Usa "Retomar aqui" para voltar a trabalhar nela.`;
    await expect(manager.send(second, 'olá')).rejects.toThrow(message);
    await expect(manager.send(second, 'olá', 'now')).rejects.toThrow(message);
    await expect(manager.send(second, 'olá', 'queue')).rejects.toThrow(message);
    await expect(manager.comment(second, [], 'nota')).rejects.toThrow(message);
    await expect(manager.review(second, 'reject')).rejects.toThrow(message);
    await expect(manager.undo(second)).rejects.toThrow(message);
    await expect(
      manager.rewind(second, lastTurn, { files: true, conversation: false }),
    ).rejects.toThrow(message);
    expect(view(second).queue.items).toEqual([]);
    // Ler continua a poder-se.
    expect((await manager.timeline(second)).checkpoints.length).toBeGreaterThan(0);
    expect(await manager.diff(second, { kind: 'session' })).toBeDefined();
    expect(view(second).turns.length).toBeGreaterThan(0);
  });

  it('recusa se a origem trabalha ou já passou o testemunho, sem criar nada', async () => {
    const { second } = await worktreeSession();
    await manager.send(second, 'demora');
    await expect(manager.handoff(second, { agent: 'codex', text: draft })).rejects.toThrow(
      'Espera que o agente acabe',
    );
    expect(manager.recovery()).toHaveLength(2);
    FakeAdapter.release();
    await idle(second);
    await expect(manager.handoff(second, { agent: 'desconhecido', text: draft })).rejects.toThrow(
      'Agente desconhecido',
    );
    expect(manager.recovery()).toHaveLength(2);
    expect(view(second).session.handedTo).toBeUndefined();
    expect(manager.worktreeOf(second)).toBeDefined();

    const { session } = await manager.handoff(second, { agent: 'codex', text: draft });
    await idle(session.id);
    await expect(manager.handoff(second, { agent: 'claude', text: draft })).rejects.toThrow(
      'passou o testemunho',
    );
    expect(manager.recovery()).toHaveLength(3);
  });

  it('uma passagem a meio recusa tudo o que mexe na origem', async () => {
    const { second } = await worktreeSession();
    const first = manager.handoff(second, { agent: 'codex', text: draft });
    // A segunda passagem chega com a primeira ainda a abrir a sessão.
    await expect(manager.handoff(second, { agent: 'claude', text: draft })).rejects.toThrow(
      /meio|testemunho/,
    );
    await first;
  });

  it('sem worktree partilha a pasta do projeto, sem inventar uma', async () => {
    make(undefined);
    const only = await start();
    await turn(only, 'escreve g.txt=y');
    const { session } = await manager.handoff(only, { agent: 'codex', text: draft });
    expect(session.cwd).toBe(project);
    expect(session.workspace).toEqual({ kind: 'project' });
    expect(manager.worktreeOf(session.id)).toBeUndefined();
    expect(manager.worktreeOf(only)).toBeUndefined();
    expect(view(only).session.handedTo).toBe(session.id);
    expect(FakeAdapter.sent.at(-1)?.cwd).toBe(project);
  });

  it('Retomar aqui devolve a pasta e põe a outra sessão em pausa', async () => {
    const { second } = await worktreeSession();
    const wt = manager.worktreeOf(second)!;
    const { session } = await manager.handoff(second, { agent: 'codex', text: draft });
    await idle(session.id);
    // Com a outra a trabalhar, não se retoma.
    await manager.send(session.id, 'demora');
    await expect(manager.resumeHere(second)).rejects.toThrow('Espera que o agente acabe');
    expect(view(second).session.handedTo).toBe(session.id);
    expect(manager.worktreeOf(session.id)).toEqual(wt);
    FakeAdapter.release();
    await idle(session.id);

    const resumed = await manager.resumeHere(second);
    expect(resumed.session.handedTo).toBeUndefined();
    expect(resumed.paused).toMatchObject({ id: session.id, handedTo: second });
    expect(view(second).session.handedTo).toBeUndefined();
    expect(view(session.id).session.handedTo).toBe(second);
    expect(manager.worktreeOf(second)).toEqual(wt);
    expect(manager.worktreeOf(session.id)).toBeUndefined();
    expect(handoffs(second).at(-1)?.handedTo).toBeNull();
    expect(handoffs(session.id).at(-1)?.handedTo).toBe(second);
    // Agora é a outra que só se lê.
    await expect(manager.send(session.id, 'olá')).rejects.toThrow('passou o testemunho a');
    await turn(second, 'escreve f.txt=de-volta');
    await expect(manager.resumeHere(second)).rejects.toThrow('já tem a pasta');
    expect(await manager.orphans()).toEqual([]);
  });

  it('numa cadeia, retomar na primeira vai buscar a pasta a quem a tem agora', async () => {
    const { second: a } = await worktreeSession();
    const wt = manager.worktreeOf(a)!;
    const b = (await manager.handoff(a, { agent: 'codex', text: draft })).session;
    await idle(b.id);
    const c = (await manager.handoff(b.id, { agent: 'claude', text: draft })).session;
    await idle(c.id);
    expect(manager.worktreeOf(c.id)).toEqual(wt);
    expect(view(a).session.handedTo).toBe(b.id);
    expect(view(b.id).session.handedTo).toBe(c.id);

    const resumed = await manager.resumeHere(a);
    expect(resumed.paused?.id).toBe(c.id);
    expect(manager.worktreeOf(a)).toEqual(wt);
    expect(manager.worktreeOf(c.id)).toBeUndefined();
    expect(view(c.id).session.handedTo).toBe(a);
    expect(view(b.id).session.handedTo).toBe(c.id);
    await expect(manager.send(c.id, 'olá')).rejects.toThrow('passou o testemunho a');
    await turn(a, 'escreve f.txt=voltou');
  });

  it('se a primeira mensagem não segue, tudo volta ao que era', async () => {
    const { second } = await worktreeSession();
    const wt = manager.worktreeOf(second)!;
    failing.codex = true;
    await expect(manager.handoff(second, { agent: 'codex', text: draft })).rejects.toThrow(
      'o agente recusou a mensagem',
    );
    expect(view(second).session.handedTo).toBeUndefined();
    expect(manager.worktreeOf(second)).toEqual(wt);
    expect(manager.recovery()).toHaveLength(2);
    expect(await manager.orphans()).toEqual([]);
    expect(handoffs(second).at(-1)?.handedTo).toBeNull();
    // A origem continua a funcionar.
    await turn(second, 'escreve f.txt=ainda-aqui');
  });

  it('fechar a sessão que recebeu o testemunho liberta a origem', async () => {
    const { second } = await worktreeSession();
    const { session } = await manager.handoff(second, { agent: 'codex', text: draft });
    await idle(session.id);
    expect(await manager.close(session.id, 'keep')).toEqual({ closed: true });
    expect(view(second).session.handedTo).toBeUndefined();
    expect(handoffs(second).at(-1)?.handedTo).toBeNull();
    await expect(manager.resumeHere(second)).rejects.toThrow('já tem a pasta');
  });

  it('os ficheiros tocados são os que a Solline contou: worktree contra a base, ou o checkpoint', async () => {
    const { second } = await worktreeSession();
    const fromWorktree = await manager.handoffSource(second);
    expect(fromWorktree.files).toEqual([{ path: 'f.txt', additions: 1, deletions: 1 }]);
    expect(fromWorktree).toMatchObject({
      label: 'Claude',
      title: sessionTitle,
      lastRequest: sessionTitle,
    });
    expect(fromWorktree.filesNote).toBeUndefined();
    await manager.disposeAll();
    await store.dispose();

    store = new CheckpointStore({ root: path.join(root, 'data2') });
    make(undefined);
    const only = await start();
    await turn(only, 'escreve g.txt=y');
    const fromCheckpoint = await manager.handoffSource(only);
    expect(fromCheckpoint.files).toEqual([{ path: 'g.txt', additions: 1, deletions: 0 }]);
    expect(fromCheckpoint.filesNote).toBeUndefined();
  });

  it('sem checkpoints nem worktree a lista diz que não sabe, em vez de dizer "nada"', async () => {
    make(undefined, null);
    const { session } = await manager.create({
      projectId: 'p',
      agent: 'claude',
      cwd: project,
      trusted: true,
    });
    await manager.send(session.id, 'olá');
    await idle(session.id);
    const source = await manager.handoffSource(session.id);
    expect(source.files).toEqual([]);
    expect(source.filesNote).toMatch(/checkpoints estão desligados/);
  });
});

describe('os comandos handoff no motor', { timeout: 60_000 }, () => {
  const engines: Engine[] = [];
  let events: EngineEvent[];
  let id = 0;
  const key = Buffer.alloc(32, 7);

  /** O que as respostas dos comandos do teste trazem (só os campos que se leem aqui). */
  interface Reply {
    text: string;
    drafted: string;
    warning?: string;
    cost: number | null;
    turnId: string;
    session: SessionInfo;
    paused?: SessionInfo;
  }

  async function ask(engine: Engine, command: string, payload: unknown = {}): Promise<Reply> {
    const result = await engine.handle({ kind: 'request', id: `h-${++id}`, command, payload });
    if (!result.ok) throw new Error(result.error.message);
    return result.result as Reply;
  }

  let opened = 0;
  function open(
    options: { drafter?: Drafter | false; worktrees?: WorktreeManager | false; dir?: string } = {},
  ) {
    events = [];
    const engine = new Engine({
      registry: registry(),
      dataDir: options.dir ?? path.join(root, `engine-data-${++opened}`),
      recoveryKey: key,
      isolated: true,
      checkpoints: false,
      checks: false,
      reviewer: false,
      worktrees: options.worktrees ?? false,
      ...(options.drafter !== undefined ? { drafter: options.drafter } : {}),
      emit: (event) => events.push(event),
    });
    engines.push(engine);
    return engine;
  }

  const startSession = async (engine: Engine) =>
    (
      (await ask(engine, 'session.start', {
        projectId: 'p',
        cwd: project,
        agent: 'claude',
        trusted: true,
      })) as { session: { id: string } }
    ).session.id;

  afterEach(async () => {
    FakeAdapter.release();
    for (const engine of engines.splice(0)) await engine.dispose().catch(() => undefined);
  });

  it('handoff.draft: o modelo escreve, a lista de ficheiros é da Solline', async () => {
    const seen: unknown[] = [];
    const engine = open({
      worktrees: gitProject(),
      drafter: async (input) => {
        seen.push(input);
        return { sections, cost: 0.05 };
      },
    });
    await startSession(engine);
    const second = await startSession(engine);
    await ask(engine, 'session.send', { sessionId: second, text: 'escreve f.txt=x' });
    await waitFor(() => engine.sessions.recovery().some((s) => s.view.turns.length >= 2), 5_000);

    const drafted = await ask(engine, 'handoff.draft', {
      sessionId: second,
      agent: 'codex',
      model: 'm',
      goal: 'Executa a fase 1 do plano',
    });
    expect(drafted).toMatchObject({ drafted: 'model', cost: 0.05 });
    expect(drafted.warning).toBeUndefined();
    expect(drafted.text).toContain('- f.txt (+1 −1)');
    expect(drafted.text).toContain('- Criar `handoff.ts`.');
    expect(seen[0]).toMatchObject({
      goal: 'Executa a fase 1 do plano',
      source: { label: 'Claude', title: 'escreve f.txt=x' },
      target: { label: 'Codex', model: 'm' },
      files: [{ path: 'f.txt', additions: 1, deletions: 1 }],
    });
    const transcript = (seen[0] as { transcript: string }).transcript;
    expect(transcript).toContain('Utilizador: escreve f.txt=x');
    expect(transcript).toContain('A conversa da sessão anterior');
    expect(transcript).not.toContain('rebobinada');
    // Só leitura: nada mudou na sessão.
    expect(
      engine.sessions.recovery().find((s) => s.view.session.id === second)?.view.session,
    ).not.toHaveProperty('handedTo');
  });

  it('handoff.draft sem redator (ou com ele a falhar) sai mecânico e diz porquê', async () => {
    const engine = open({ drafter: false });
    const sessionId = await startSession(engine);
    await ask(engine, 'session.send', { sessionId, text: 'olá mundo' });
    const none = await ask(engine, 'handoff.draft', {
      sessionId,
      agent: 'codex',
      goal: 'Continua isto',
    });
    expect(none).toMatchObject({ drafted: 'mechanical', cost: null });
    expect(none.warning).toMatch(/mecânico/);
    expect(none.warning).toMatch(/checkpoints estão desligados/);
    expect(none.text).toContain(
      '## Objetivo\nContinua isto\n\nÚltimo pedido na sessão anterior: olá mundo',
    );

    const broken = open({
      drafter: async () => {
        throw new Error('o modelo caiu');
      },
    });
    const other = await startSession(broken);
    const failed = await ask(broken, 'handoff.draft', {
      sessionId: other,
      agent: 'codex',
      goal: 'Continua isto',
    });
    expect(failed.drafted).toBe('mechanical');
    expect(failed.warning).toContain('o modelo caiu');
    await expect(
      ask(broken, 'handoff.draft', { sessionId: 'nao-existe', agent: 'codex', goal: 'x' }),
    ).rejects.toThrow('Sessão desconhecida');
    await expect(
      ask(broken, 'handoff.draft', { sessionId: other, agent: 'desconhecido', goal: 'x' }),
    ).rejects.toThrow('Agente desconhecido');
  });

  it('handoff.cancelDraft cancela o rascunho a meio', async () => {
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    const engine = open({
      drafter: (input) =>
        new Promise((_resolve, reject) => {
          started();
          input.signal?.addEventListener('abort', () => reject(new Error('abortado')), {
            once: true,
          });
        }),
    });
    const sessionId = await startSession(engine);
    const draft = ask(engine, 'handoff.draft', { sessionId, agent: 'codex', goal: 'x' });
    const outcome = draft.then(
      () => 'ok',
      (error: Error) => error.message,
    );
    await running;
    expect(await ask(engine, 'handoff.cancelDraft', { sessionId })).toEqual({ cancelled: true });
    expect(await outcome).toContain('cancelado');
    expect(await ask(engine, 'handoff.cancelDraft', { sessionId })).toEqual({ cancelled: false });
  });

  it('handoff.start e handoff.resume: o contrato, o diário e o reinício', async () => {
    const worktrees = gitProject();
    const dir = path.join(root, 'engine-restart');
    let engine = open({ worktrees, dir });
    await startSession(engine);
    const second = await startSession(engine);
    await ask(engine, 'session.send', { sessionId: second, text: 'escreve f.txt=x' });
    await waitFor(() => engine.sessions.recovery().some((s) => s.view.turns.length >= 2), 5_000);
    await waitFor(
      () => engine.sessions.recovery().every((s) => s.view.session.state === 'idle'),
      5_000,
    );
    const wt = engine.sessions.worktreeOf(second)!;

    const started = await ask(engine, 'handoff.start', {
      sessionId: second,
      agent: 'codex',
      text: assembleDraft(sections, []),
    });
    const newId = started.session.id as string;
    expect(started.session).toMatchObject({
      agent: 'codex',
      origin: { kind: 'handoff', sessionId: second },
    });
    expect(started.turnId).toEqual(expect.any(String));
    expect(engine.sessions.worktreeOf(newId)).toEqual(wt);
    // A origem continua legível: o snapshot mostra-a, sem enviar.
    await expect(ask(engine, 'session.send', { sessionId: second, text: 'olá' })).rejects.toThrow(
      'passou o testemunho a',
    );
    await waitFor(
      () => engine.sessions.recovery().every((s) => s.view.session.state === 'idle'),
      5_000,
    );

    // Reinício: a pasta continua da nova sessão e a antiga continua a só ler.
    await engine.shutdown();
    engine = open({ worktrees, dir });
    await engine.ready();
    const snapshot = EngineSnapshot.parse(await ask(engine, 'engine.snapshot'));
    const byId = new Map(snapshot.sessions.map((s) => [s.session.id, s.session]));
    expect(byId.get(second)?.handedTo).toBe(newId);
    expect(byId.get(newId)).toMatchObject({
      origin: { kind: 'handoff', sessionId: second },
    });
    expect(byId.get(newId)?.handedTo).toBeUndefined();
    expect(engine.sessions.worktreeOf(newId)).toEqual(wt);
    expect(engine.sessions.worktreeOf(second)).toBeUndefined();
    // Nenhuma worktree fica órfã.
    expect(await ask(engine, 'worktrees.list')).toEqual({ orphans: [] });
    await expect(ask(engine, 'session.send', { sessionId: second, text: 'olá' })).rejects.toThrow(
      'passou o testemunho a',
    );

    // Retomar aqui, a partir da sessão recuperada que passou o testemunho.
    const resumed = await ask(engine, 'handoff.resume', { sessionId: second });
    expect(resumed.session.id).toBe(second);
    expect(resumed.session.handedTo).toBeUndefined();
    expect(resumed.paused).toMatchObject({ id: newId, handedTo: second });
    expect(engine.sessions.worktreeOf(second)).toEqual(wt);
    expect(engine.sessions.worktreeOf(newId)).toBeUndefined();
    expect(await ask(engine, 'worktrees.list')).toEqual({ orphans: [] });

    // E isto também sobrevive a outro reinício.
    await engine.shutdown();
    engine = open({ worktrees, dir });
    await engine.ready();
    const again = EngineSnapshot.parse(await ask(engine, 'engine.snapshot'));
    const sessions = new Map(again.sessions.map((s) => [s.session.id, s.session]));
    expect(sessions.get(second)?.handedTo).toBeUndefined();
    expect(sessions.get(newId)?.handedTo).toBe(second);
    expect(engine.sessions.worktreeOf(second)).toEqual(wt);
    expect(await ask(engine, 'worktrees.list')).toEqual({ orphans: [] });
  });

  it('o diário repõe o handedTo de um evento (sem depender do snapshot)', () => {
    const base = {
      view: {
        session: {
          id: 'a',
          projectId: 'p',
          agent: 'claude',
          cwd: '/p',
          title: 'A',
          state: 'idle',
          settings: { model: null, effort: null, mode: null },
          agentSessionId: null,
        },
      },
    };
    const state = {
      snapshot: { sequence: 0, epoch: 'e', operations: [], races: [], sessions: [] },
      sessions: [structuredClone(base)],
      setups: [],
    } as unknown as RecoveryState;
    const passed = replay(
      [
        {
          kind: 'event',
          event: { kind: 'event', type: 'session.handoff', sessionId: 'a', handedTo: 'b' },
        },
      ],
      state,
    );
    expect(passed.snapshot.sessions[0]?.session.handedTo).toBe('b');
    const back = replay(
      [
        {
          kind: 'event',
          event: { kind: 'event', type: 'session.handoff', sessionId: 'a', handedTo: 'b' },
        },
        {
          kind: 'event',
          event: { kind: 'event', type: 'session.handoff', sessionId: 'a', handedTo: null },
        },
      ],
      state,
    );
    expect(back.snapshot.sessions[0]?.session).not.toHaveProperty('handedTo');
  });
});
