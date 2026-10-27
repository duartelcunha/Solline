import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EngineSnapshot,
  type AgentCapabilities,
  type EngineEvent,
  type Race,
  type SessionState,
  type SplitPart,
} from '@solline/protocol';
import { Engine } from '../src/engine.ts';
import { registryOf } from '../src/agents/registry.ts';
import { RaceManager, type RaceSessions } from '../src/races/race-manager.ts';
import { RaceRegistry } from '../src/races/race-registry.ts';
import {
  SplitManager,
  contractMessage,
  digestMessage,
  lastSentence,
  splitIntro,
  type SplitSessions,
} from '../src/races/split-manager.ts';
import { outOfScope } from '../src/races/zones.ts';
import { WorktreeManager, type Worktree } from '../src/worktrees/worktrees.ts';
import { waitFor } from './helpers.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Um repositório git com um commit e a pasta de dados ao lado. */
async function repo() {
  const root = await mkdtemp(path.join(tmpdir(), 'solline-split-'));
  roots.push(root);
  const project = path.join(root, 'project');
  await mkdir(project);
  git(project, 'init', '--quiet', '-b', 'main');
  git(project, 'config', 'user.email', 'teste@solline.local');
  git(project, 'config', 'user.name', 'Teste');
  git(project, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(project, 'a.txt'), 'um\n');
  git(project, 'add', '-A');
  git(project, 'commit', '--quiet', '-m', 'início');
  return { root, project, data: path.join(root, 'data') };
}

const CHECKS = [{ id: 'test', label: 'Testes' }];

function part(title: string, allowed: string[], extra: Partial<SplitPart> = {}): SplitPart {
  return {
    title,
    goal: `Fazer ${title}`,
    allowed,
    forbidden: [],
    interfaces: '',
    expected: '',
    check: 'test',
    zero: false,
    ...extra,
  };
}

async function write(wt: Worktree, file: string, content: string) {
  await mkdir(path.dirname(path.join(wt.cwd, file)), { recursive: true });
  await writeFile(path.join(wt.cwd, file), content);
}

/** Sessões de mentira, mas com worktrees de verdade (o que o SessionManager faz ao criar). */
async function setup(options: { replies?: Record<string, string>; brokenGit?: boolean } = {}) {
  const dirs = await repo();
  const worktrees = new WorktreeManager({ root: path.join(dirs.data, 'worktrees') });
  const trees = new Map<string, Worktree>();
  const created: { id: string; agent: string; after: string | undefined; raceId: string }[] = [];
  const sent = new Map<string, { text: string; how: string | undefined }[]>();
  const closed: [string, string | undefined][] = [];
  const replies = new Map(Object.entries(options.replies ?? {}));
  const events: EngineEvent[] = [];
  let n = 0;
  const sessions: SplitSessions & RaceSessions = {
    create: async (payload) => {
      const wt = payload.startAfter
        ? await worktrees.createAfter(trees.get(payload.startAfter) as Worktree)
        : await worktrees.create(payload.cwd, payload.projectId);
      const id = `s${++n}`;
      trees.set(id, wt as Worktree);
      created.push({
        id,
        agent: payload.agent,
        after: payload.startAfter,
        raceId: payload.raceId ?? '',
      });
      return {
        session: { id, agent: payload.agent, state: 'starting', settings: { model: null } },
      } as never;
    },
    send: async (id: string, text: string, how?: 'queue') => {
      sent.set(id, [...(sent.get(id) ?? []), { text, how }]);
    },
    close: async (id, worktree) => void closed.push([id, worktree]),
    worktreeOf: (id) => trees.get(id),
    laneDigest: (id) => replies.get(id) ?? '',
    outcome: async () => {
      throw new Error('as repartições não se ordenam');
    },
    checkContext: () => ({ specs: [], env: {}, run: undefined }),
  };
  const registry = new RaceRegistry((event) => events.push(event));
  const broken = {
    diff: async () => {
      throw new Error('git caiu');
    },
    collisions: async () => {
      throw new Error('git caiu');
    },
  };
  const manager = new SplitManager({
    sessions,
    emit: (e) => events.push(e),
    registry,
    worktrees: options.brokenGit ? broken : worktrees,
  });
  const races = new RaceManager({ sessions, emit: (e) => events.push(e), registry });
  const project = { projectId: 'p', cwd: dirs.project, trusted: true };
  const state = (sessionId: string, to: SessionState) => {
    const event = { kind: 'event', type: 'session.state', sessionId, state: to } as never;
    races.observe(event);
    manager.observe(event);
  };
  /** Um turno completo: começa a trabalhar e para. */
  const turn = (sessionId: string) => {
    state(sessionId, 'running');
    state(sessionId, 'idle');
  };
  const begin = (text: string, parts: SplitPart[]) =>
    manager.begin({
      ...project,
      text,
      checkRefs: CHECKS,
      parts: parts.map((p) => ({ part: p, agent: 'claude' as const })),
    });
  const messages = (id: string) => (sent.get(id) ?? []).map((m) => m.text);
  const treeOf = (id: string) => trees.get(id) as Worktree;
  return {
    ...dirs,
    worktrees,
    manager,
    races,
    registry,
    created,
    sent,
    closed,
    replies,
    events,
    state,
    turn,
    begin,
    messages,
    treeOf,
  };
}

const SLOW = { timeout: 120_000 };
const LONG = 60_000;

describe('o contrato e os resumos', () => {
  it('o contrato diz o objetivo, onde mexer, o que não tocar (inclui as outras partes) e a verificação', () => {
    const mine = part('API', ['src/api/**'], {
      goal: 'Criar a rota de pedidos',
      forbidden: ['src/legacy/**'],
      interfaces: 'POST /pedidos devolve { id }',
      expected: 'A rota responde 201',
    });
    const text = contractMessage(
      mine,
      [part('Ecrã', ['src/ui/**', 'public/**']), part('Vazia', [])],
      [{ id: 'test', label: 'Testes' }],
    );
    expect(text).toContain('A tua parte é «API»');
    expect(text).toContain('Objetivo: Criar a rota de pedidos');
    expect(text).toMatch(/Podes mexer em:\n- src\/api\/\*\*/);
    expect(text).toMatch(
      /Não mexas em:\n- src\/legacy\/\*\*\n- src\/ui\/\*\*, public\/\*\* \(parte «Ecrã»\)/,
    );
    // Uma parte sem zonas não proíbe nada aos outros.
    expect(text).not.toContain('Vazia');
    expect(text).toContain('Interfaces combinadas:\nPOST /pedidos devolve { id }');
    expect(text).toContain('Resultado esperado:\nA rota responde 201');
    expect(text).toContain('Quando acabares, corre a verificação «Testes» do projeto.');
    // Sem etiqueta conhecida, vale o id.
    expect(contractMessage(mine, [])).toContain('verificação «test»');
    expect(splitIntro(2, 3, 'faz\n  isto   e aquilo')).toBe(
      'Esta é a parte 2 de 3 de um pedido maior: «faz isto e aquilo».',
    );
  });

  it('o resumo lista até 12 ficheiros e a última frase, sem passar de 300 caracteres', () => {
    const files = Array.from({ length: 15 }, (_, i) => ({
      path: `f${String(i).padStart(2, '0')}.ts`,
      additions: i,
      deletions: 1,
    }));
    const long = `Primeiro li tudo. ${'x'.repeat(400)}`;
    const note = lastSentence(long);
    expect(note.length).toBeLessThanOrEqual(300);
    expect(note.endsWith('…')).toBe(true);
    const text = digestMessage('API', files, note);
    expect(text).toContain('A parte «API» mudou: f00.ts (+0 −1), f01.ts (+1 −1)');
    expect(text).toContain('f11.ts (+11 −1) e mais 3 ficheiros.');
    expect(text).not.toContain('f12.ts');
    expect(lastSentence('Li o código. Acabei o ficheiro x.')).toBe('Acabei o ficheiro x.');
    expect(lastSentence('  ')).toBe('');
  });

  it('o âmbito: pastas, globs, o proibido ganha, e sem zonas só conta o proibido', () => {
    const scoped = { allowed: ['src/api/**', 'README.md'], forbidden: ['src/api/secret'] };
    expect(
      outOfScope(scoped, [
        'src/api/rota.ts',
        'src/api/secret/chave.ts',
        'SRC/API/Maiusculas.ts',
        'README.md',
        'src/ui/x.ts',
        'docs/README.md',
      ]),
    ).toEqual(['src/api/secret/chave.ts', 'src/ui/x.ts', 'docs/README.md']);
    // Uma pasta literal apanha o que está lá dentro; um glob com nome parcial apanha as pastas.
    expect(
      outOfScope({ allowed: ['src/a'], forbidden: [] }, ['src/a/b.ts', 'src/ab/b.ts']),
    ).toEqual(['src/ab/b.ts']);
    expect(outOfScope({ allowed: ['src/a*'], forbidden: [] }, ['src/ab/b.ts', 'src/c.ts'])).toEqual(
      ['src/c.ts'],
    );
    expect(
      outOfScope({ allowed: [], forbidden: ['dist/**'] }, ['qualquer.ts', 'dist/x.js']),
    ).toEqual(['dist/x.js']);
  });
});

describe('lançar por fases', SLOW, () => {
  it('a parte zero corre sozinha; as outras partem do commit dela, com o contrato', async () => {
    const t = await setup();
    const { race, sessions } = await t.begin('Montar a funcionalidade X', [
      part('Base', ['src/core/**'], { zero: true }),
      part('API', ['src/api/**']),
      part('Ecrã', ['src/ui/**']),
    ]);
    expect(race.kind).toBe('split');
    expect(sessions).toHaveLength(1);
    expect(race.lanes.map((l) => l.part?.title)).toEqual(['Base']);
    expect(race.split?.pending.map((p) => [p.index, p.after])).toEqual([
      [1, 0],
      [2, 0],
    ]);
    expect(t.created.map((c) => c.after)).toEqual([undefined]);
    // Só a parte zero recebeu o contrato, com a posição e o pedido.
    expect(t.messages('s1')).toHaveLength(1);
    expect(t.messages('s1')[0]).toContain(
      'Esta é a parte 1 de 3 de um pedido maior: «Montar a funcionalidade X».',
    );
    expect(t.messages('s1')[0]).toContain('src/api/**');
    expect(t.messages('s1')[0]).toContain('(parte «Ecrã»)');

    await write(t.treeOf('s1'), 'src/core/tipos.ts', 'export type Pedido = { id: string };\n');
    t.turn('s1');
    await waitFor(() => t.manager.get(race.id).lanes.length === 3, LONG);
    expect(t.created.map((c) => c.after)).toEqual([undefined, 's1', 's1']);
    // Partem do commit da zero: o ficheiro dela já lá está, e a base da nova worktree é esse commit.
    for (const id of ['s2', 's3']) {
      expect(await readFile(path.join(t.treeOf(id).cwd, 'src/core/tipos.ts'), 'utf8')).toContain(
        'Pedido',
      );
      expect(t.treeOf(id).base).toBe(git(t.treeOf('s1').path, 'rev-parse', 'HEAD'));
    }
    expect(t.manager.get(race.id).split?.pending).toEqual([]);
    expect(t.manager.get(race.id).phase).toBe('running');
    expect(t.messages('s2')[0]).toContain('Esta é a parte 2 de 3');
    expect(t.messages('s3')[0]).toContain('Esta é a parte 3 de 3');
    // O contrato do 2 não manda o que a zero fez como resumo: ainda nem existia quando a zero acabou.
    expect(t.messages('s2')).toHaveLength(1);

    t.turn('s2');
    t.turn('s3');
    await waitFor(() => t.manager.get(race.id).phase === 'done', LONG);
    // A corrida não ordena repartições, mesmo partilhando o registo.
    expect(t.races.get(race.id).kind).toBe('split');
    await expect(t.races.rank(race.id)).rejects.toThrow(/repartição/);
    expect(t.events.some((e) => e.type === 'race.state' && e.race.phase === 'ranking')).toBe(false);
  });

  it('uma cadeia parte do resultado da anterior; a seguinte nunca recebe resumos de antes de existir', async () => {
    const t = await setup();
    const { race } = await t.begin('Mexer na pasta partilhada', [
      part('Dados', ['src/shared/**']),
      part('Vista', ['src/shared/ui/**']),
      part('Docs', ['docs/**']),
    ]);
    // Dados e Docs correm já; Vista espera por Dados.
    expect(race.lanes.map((l) => l.part?.title)).toEqual(['Dados', 'Docs']);
    expect(race.split?.pending.map((p) => [p.part.title, p.after])).toEqual([['Vista', 0]]);

    await write(t.treeOf('s1'), 'src/shared/dados.ts', 'export const dados = 1;\n');
    t.replies.set('s1', 'Pronto os dados.');
    t.turn('s1');
    await waitFor(() => t.manager.get(race.id).lanes.length === 3, LONG);
    expect(t.created[2]?.after).toBe('s1');
    expect(await readFile(path.join(t.treeOf('s3').cwd, 'src/shared/dados.ts'), 'utf8')).toContain(
      'dados',
    );
    expect(git(t.treeOf('s1').path, 'log', '--format=%s', '-1')).toBe('Solline: parte concluída');

    t.turn('s2');
    t.turn('s3');
    await waitFor(() => t.manager.get(race.id).phase === 'done', LONG);
    // A Vista só recebeu o contrato: o que a Dados fez já estava na base dela.
    expect(t.messages('s3')).toHaveLength(1);
    // A Docs, que ainda trabalhava, recebeu o resumo dos Dados.
    expect(t.messages('s2')).toHaveLength(2);
  });

  it('as partes sem verificação válida não se lançam; sem nenhuma, não há repartição', async () => {
    const t = await setup();
    const { race } = await t.begin('Pedido', [
      part('Sem verificação', ['src/x/**'], { check: null }),
      part('Verificação inventada', ['src/y/**'], { check: 'nao-existe' }),
      part('A', ['src/a/**']),
      part('B', ['src/b/**']),
    ]);
    expect(race.lanes.map((l) => l.part?.title)).toEqual(['A', 'B']);
    expect(race.split?.pending).toEqual([]);
    expect(t.created).toHaveLength(2);
    expect(t.messages('s1')[0]).toContain('parte 1 de 2');
    // Os contratos só falam das partes lançadas.
    expect(t.messages('s1')[0]).not.toContain('Sem verificação');

    const none = await setup();
    await expect(
      none.begin('Pedido', [
        part('A', ['src/a/**'], { check: null }),
        part('B', ['src/b/**'], { check: null }),
      ]),
    ).rejects.toThrow(/verificação válida/);
    expect(none.created).toEqual([]);
  });

  it('uma parte zero que falha deixa as outras por arrancar, a repartição acaba e fecha-se', async () => {
    const t = await setup();
    const { race } = await t.begin('Pedido', [
      part('Base', ['src/core/**'], { zero: true }),
      part('API', ['src/api/**']),
      part('Ecrã', ['src/ui/**']),
    ]);
    t.state('s1', 'running');
    t.state('s1', 'error');
    await waitFor(() => t.manager.get(race.id).phase === 'done', LONG);
    const live = t.manager.get(race.id);
    expect(live.lanes).toHaveLength(1);
    expect(live.split?.pending.map((p) => p.part.title)).toEqual(['API', 'Ecrã']);
    expect(t.created).toHaveLength(1);

    await expect(t.manager.close('inexistente')).rejects.toThrow(/desconhecida/);
    await expect(t.manager.close(race.id, 'outra')).rejects.toThrow(/não é desta/);
    const closed = await t.manager.close(race.id, 's1');
    expect(closed.closed).toBe(true);
    expect(t.closed).toEqual([['s1', 'keep']]);
    expect(live.phase).toBe('closed');
    expect(live.split?.pending).toEqual([]);
  });
});

describe('resumos, âmbito e colisões', SLOW, () => {
  it('o resumo vai só para as pistas por acabar, uma vez, pela fila; nada igual se repete', async () => {
    const t = await setup({ replies: { s1: 'Primeiro li o código. Acabei o ficheiro x.' } });
    const { race } = await t.begin('Pedido', [part('A', ['src/a/**']), part('B', ['src/b/**'])]);
    await write(t.treeOf('s1'), 'src/a/x.ts', 'um\ndois\n');
    t.turn('s1');
    await waitFor(() => t.messages('s2').length === 2, LONG);
    const digest = t.sent.get('s2')?.[1];
    expect(digest?.how).toBe('queue');
    expect(digest?.text).toContain('A parte «A» mudou: src/a/x.ts (+2 −0)');
    expect(digest?.text).toContain('Última nota: Acabei o ficheiro x.');
    // A própria pista não recebe o seu resumo.
    expect(t.messages('s1')).toHaveLength(1);

    // Outro turno de A sem mudar nada: nada de novo para dizer.
    t.turn('s1');
    t.turn('s2');
    await waitFor(() => t.manager.get(race.id).phase === 'done', LONG);
    expect(t.messages('s2')).toHaveLength(2);
    // A já tinha acabado quando B acabou: ninguém lhe manda resumos.
    expect(t.messages('s1')).toHaveLength(1);
  });

  it('uma mudança nova gera um resumo novo para a pista que ainda trabalha', async () => {
    const t = await setup({ replies: { s1: 'Feito.' } });
    const { race } = await t.begin('Pedido', [part('A', ['src/a/**']), part('B', ['src/b/**'])]);
    await write(t.treeOf('s1'), 'src/a/x.ts', 'um\n');
    t.turn('s1');
    await waitFor(() => t.messages('s2').length === 2, LONG);
    // A volta a trabalhar e muda mais um ficheiro.
    await write(t.treeOf('s1'), 'src/a/y.ts', 'dois\n');
    t.turn('s1');
    // O B ainda não acabou: recebe o segundo estado do A (uma mudança nova).
    await waitFor(() => t.messages('s2').length === 3, LONG);
    expect(t.sent.get('s2')?.[2]?.text).toContain('src/a/y.ts (+1 −0)');
    t.turn('s2');
    await waitFor(() => t.manager.get(race.id).phase === 'done', LONG);
  });

  it('avisa do que saiu do âmbito, sem repetir, e não mata a pista', async () => {
    const t = await setup();
    const { race } = await t.begin('Pedido', [
      part('A', ['src/a/**'], { forbidden: ['src/a/segredo/**'] }),
      part('B', ['src/b/**']),
    ]);
    const wt = t.treeOf('s1');
    await write(wt, 'src/a/ok.ts', 'ok\n');
    await write(wt, 'src/b/outro.ts', 'fora\n');
    await write(wt, 'src/a/segredo/chave.ts', 'proibido\n');
    t.turn('s1');
    await waitFor(() => (t.manager.get(race.id).split?.warnings.length ?? 0) === 2, LONG);
    const outside = () =>
      (t.manager.get(race.id).split?.warnings ?? []).filter((w) => w.kind === 'outside');
    expect(
      outside()
        .map((w) => [w.sessionId, w.path])
        .sort(),
    ).toEqual([
      ['s1', 'src/a/segredo/chave.ts'],
      ['s1', 'src/b/outro.ts'],
    ]);
    // O mesmo ficheiro num turno seguinte não duplica o aviso.
    t.turn('s1');
    t.turn('s2');
    await waitFor(() => t.manager.get(race.id).phase === 'done', LONG);
    expect(outside()).toHaveLength(2);
    expect(t.manager.get(race.id).lanes[0]?.state).toBe('idle');
    expect(t.events.filter((e) => e.type === 'race.state').at(-1)).toMatchObject({
      race: { split: { warnings: [{ kind: 'outside' }, { kind: 'outside' }] } },
    });
  });

  it('prevê colisões entre pistas e não as duplica quando a outra pista acaba', async () => {
    const t = await setup();
    const { race } = await t.begin('Pedido', [part('A', ['a.txt']), part('B', ['b.txt'])]);
    await write(t.treeOf('s1'), 'a.txt', 'versão do A\n');
    await write(t.treeOf('s2'), 'a.txt', 'versão do B\n');
    t.turn('s1');
    const collisions = () =>
      (t.manager.get(race.id).split?.warnings ?? []).filter((w) => w.kind === 'collision');
    await waitFor(() => collisions().length === 1, LONG);
    expect(collisions()[0]).toEqual({
      sessionId: 's1',
      kind: 'collision',
      path: 'a.txt',
      other: 's2',
    });
    t.turn('s2');
    await waitFor(() => t.manager.get(race.id).phase === 'done', LONG);
    expect(collisions()).toHaveLength(1);
    // Resolvido o choque, o aviso sai no turno seguinte.
    await write(t.treeOf('s2'), 'a.txt', 'um\n');
    t.turn('s2');
    await waitFor(() => collisions().length === 0, LONG);
  });

  it('se o git falha ao rever, a pista segue, nada se avisa e o fim da repartição chega', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const t = await setup({ brokenGit: true });
      const { race } = await t.begin('Pedido', [part('A', ['src/a/**']), part('B', ['src/b/**'])]);
      t.turn('s1');
      t.turn('s2');
      await waitFor(() => t.manager.get(race.id).phase === 'done', LONG);
      const live = t.manager.get(race.id);
      expect(live.lanes.map((l) => l.state)).toEqual(['idle', 'idle']);
      expect(live.split?.warnings).toEqual([]);
      expect(t.events.some((e) => e.type === 'engine.error')).toBe(false);
      expect(quiet).toHaveBeenCalled();
    } finally {
      quiet.mockRestore();
    }
  });
});

describe('recuperação', SLOW, () => {
  it('repõe repartições sem lançar nada: pistas em erro, feita, partes por arrancar listadas', () => {
    const refused = async (): Promise<never> => {
      throw new Error('não pode correr ao repor');
    };
    const events: EngineEvent[] = [];
    const manager = new SplitManager({
      sessions: {
        create: refused,
        send: refused,
        close: refused,
        worktreeOf: () => undefined,
        laneDigest: () => '',
      },
      emit: (event) => events.push(event),
    });
    manager.restoreRecovery([
      {
        kind: 'split',
        id: 'rep',
        projectId: 'p',
        text: 'pedido',
        phase: 'running',
        lanes: [
          { sessionId: 'um', agent: 'claude', model: null, state: 'running', part: part('A', []) },
          { sessionId: 'dois', agent: 'claude', model: null, state: 'idle', part: part('B', []) },
        ],
        split: {
          pending: [{ index: 2, part: part('C', []), agent: 'claude', after: 0 }],
          warnings: [{ sessionId: 'um', kind: 'outside', path: 'x.ts' }],
        },
      },
      {
        kind: 'race',
        id: 'corrida',
        projectId: 'p',
        text: 'pedido',
        phase: 'done',
        lanes: [{ sessionId: 'tres', agent: 'claude', model: null, state: 'idle' }],
      },
    ]);
    expect(manager.get('rep')).toMatchObject({
      phase: 'done',
      lanes: [{ state: 'error' }, { state: 'error' }],
      split: { pending: [{ index: 2, after: 0 }], warnings: [{ kind: 'outside' }] },
    });
    // As corridas não são deste gestor.
    expect(() => manager.get('corrida')).toThrow(/desconhecida/);
    // Um fim de turno de uma pista reposta não arranca nem tenta arrancar nada.
    manager.observe({
      kind: 'event',
      type: 'session.state',
      sessionId: 'um',
      state: 'idle',
    } as never);
    expect(events.filter((e) => e.type === 'engine.error')).toEqual([]);
  });

  it('o motor devolve repartições em race.get e no snapshot, e depois de reiniciar nada arranca sozinho', async () => {
    const dirs = await repo();
    const capabilities: AgentCapabilities = {
      models: [],
      modes: [],
      effort: false,
      effortOrder: [],
      features: { cost: false, context: false, resume: true, rewind: false },
    };
    const starts: string[] = [];
    const sends: string[] = [];
    const registry = registryOf([
      {
        id: 'scripted',
        label: 'Scripted',
        transport: 'acp',
        defaultMode: null,
        staticModes: [],
        untrustedProjects: 'allowed',
        envPolicy: { base: 'no-secrets', keys: [] },
        detect: async () => ({ status: 'ready' }),
        create: (options, sink) => ({
          start: async () => {
            starts.push(options.cwd);
            return { capabilities, settings: { model: null, effort: null, mode: null } };
          },
          send: async (text, sendOptions) => {
            sends.push(text);
            sink.state('running');
            return sendOptions?.turnId ?? 'turn';
          },
          interrupt: async () => sink.state('idle'),
          close: async () => undefined,
          setMode: async () => undefined,
          setModel: async () => undefined,
          answerPermission: () => false,
          capabilities: () => capabilities,
          agentSessionId: () => 'historico',
        }),
      },
    ]);
    const key = Buffer.alloc(32, 7);
    let id = 0;
    const open = () => {
      const engine = new Engine({
        registry,
        dataDir: dirs.data,
        recoveryKey: key,
        isolated: true,
        checkpoints: false,
        checks: false,
        reviewer: false,
        worktrees: new WorktreeManager({ root: path.join(dirs.data, 'worktrees') }),
        emit: () => undefined,
      });
      const request = async (command: string, payload: unknown = {}) => {
        const result = await engine.handle({
          kind: 'request',
          id: `split-${++id}`,
          command,
          payload,
        });
        if (!result.ok) throw new Error(result.error.message);
        return result.result;
      };
      return { engine, request };
    };
    const first = open();
    const started = (await first.request('split.begin', {
      projectId: 'p',
      cwd: dirs.project,
      trusted: true,
      checks: [{ id: 'test', label: 'Testes', command: 'pnpm test', enabled: true }],
      text: 'Pedido grande',
      parts: [
        { part: part('Base', ['src/core/**'], { zero: true }), agent: 'scripted' },
        { part: part('API', ['src/api/**']), agent: 'scripted' },
      ],
    })) as { race: Race; sessions: unknown[] };
    expect(started.sessions).toHaveLength(1);
    expect(starts).toHaveLength(1);
    const live = (await first.request('race.get', { raceId: started.race.id })) as Race;
    expect(live).toMatchObject({ kind: 'split', phase: 'running' });
    expect(live.split?.pending.map((p) => p.part.title)).toEqual(['API']);
    const snapshot = EngineSnapshot.parse(await first.request('engine.snapshot'));
    expect(snapshot.races.map((r) => [r.id, r.kind])).toEqual([[started.race.id, 'split']]);
    await first.engine.dispose();

    // Ao reabrir, a repartição está feita, a pista em erro e a parte por arrancar só listada.
    const second = open();
    const restored = EngineSnapshot.parse(await second.request('engine.snapshot'));
    expect(restored.races[0]).toMatchObject({
      kind: 'split',
      phase: 'done',
      lanes: [{ state: 'error' }],
    });
    expect(restored.races[0]?.split?.pending.map((p) => p.part.title)).toEqual(['API']);
    expect(await second.request('race.get', { raceId: started.race.id })).toMatchObject({
      split: { pending: [{ index: 1 }] },
    });
    expect(starts).toHaveLength(1);
    expect(sends).toHaveLength(1);
    // Fecha-se como uma corrida e as partes por arrancar desaparecem.
    const closed = (await second.request('race.closeNow', { raceId: started.race.id })) as {
      closed: boolean;
      race: Race;
    };
    expect(closed.closed).toBe(true);
    expect(closed.race).toMatchObject({ phase: 'closed', split: { pending: [] } });
    await second.engine.dispose();
  });
});
