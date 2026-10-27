import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CheckSpec, EngineEvent, Race, SessionState, SplitPart } from '@solline/protocol';
import type { RunCommand } from '../src/checks/run.ts';
import {
  integrationMetrics,
  mergeOrder,
  resolveMessage,
  restoreIntegration,
  type IntegrationSessions,
} from '../src/races/integration.ts';
import { RaceRegistry } from '../src/races/race-registry.ts';
import type { RaceSessions } from '../src/races/race-manager.ts';
import { SplitManager, type SplitSessions } from '../src/races/split-manager.ts';
import type { Reviewer } from '../src/quality/reviewer.ts';
import { WorktreeManager, type Worktree } from '../src/worktrees/worktrees.ts';
import { waitFor } from './helpers.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function repo() {
  const root = await mkdtemp(path.join(tmpdir(), 'solline-integ-'));
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
const SPEC: CheckSpec = { id: 'test', label: 'Testes', command: 'run test', enabled: true };

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

const exists = (target: string) =>
  stat(target).then(
    () => true,
    () => false,
  );

const passing: RunCommand = async () => ({ state: 'passed', tail: null, durationMs: 1 });

/** Sessões de mentira com worktrees de verdade, e um revisor e verificações falsos. */
async function setup(
  options: {
    run?: RunCommand;
    reviewer?: Reviewer | undefined;
    costs?: Record<string, number>;
  } = {},
) {
  const dirs = await repo();
  const worktrees = new WorktreeManager({ root: path.join(dirs.data, 'worktrees') });
  const trees = new Map<string, Worktree>();
  const anchors = new Map<string, Worktree>();
  const created: { id: string; agent: string; after: string | undefined; raceId: string }[] = [];
  const sent = new Map<string, string[]>();
  const closed: [string, string | undefined][] = [];
  const costs = new Map(Object.entries(options.costs ?? {}));
  const events: EngineEvent[] = [];
  const run = vi.fn(options.run ?? passing);
  const reviewer: Reviewer | undefined =
    'reviewer' in options ? options.reviewer : vi.fn<Reviewer>(async () => []);
  let n = 0;
  const sessions: SplitSessions & RaceSessions & IntegrationSessions = {
    create: async (payload) => {
      const from = payload.startAfter
        ? (anchors.get(payload.startAfter) ?? trees.get(payload.startAfter))
        : undefined;
      const wt = payload.startAfter
        ? await worktrees.createAfter(from as Worktree)
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
    send: async (id: string, text: string) => {
      sent.set(id, [...(sent.get(id) ?? []), text]);
    },
    close: async (id, worktree) => {
      closed.push([id, worktree]);
      const wt = trees.get(id);
      trees.delete(id);
      if (wt)
        await worktrees.remove(
          wt,
          worktree === 'discard' ? 'always' : worktree === 'keep' ? 'keep' : 'if-merged',
        );
    },
    worktreeOf: (id) => trees.get(id),
    laneDigest: () => '',
    outcome: async () => {
      throw new Error('as repartições não se ordenam');
    },
    checkContext: () => ({ specs: [SPEC], env: {}, run }),
    costOf: (id) => costs.get(id) ?? null,
    anchor: (key, wt) => void anchors.set(key, wt),
    unanchor: (key) => void anchors.delete(key),
  };
  const registry = new RaceRegistry((event) => events.push(event));
  const make = (target: RaceRegistry) =>
    new SplitManager({
      sessions,
      emit: (e) => events.push(e),
      registry: target,
      worktrees,
      integration: { sessions, worktrees, reviewer },
    });
  const manager = make(registry);
  const project = { projectId: 'p', cwd: dirs.project, trusted: true };
  const state = (sessionId: string, to: SessionState, target: SplitManager = manager) =>
    target.observe({ kind: 'event', type: 'session.state', sessionId, state: to } as never);
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
  const treeOf = (id: string) => trees.get(id) as Worktree;
  const done = (raceId: string) => waitFor(() => manager.get(raceId).phase === 'done', LONG);
  /** Três partes de zonas diferentes que escrevem um ficheiro cada. */
  const three = async (extra: Record<string, string> = {}) => {
    const { race } = await begin('Fazer três coisas', [
      part('Um', ['um/**']),
      part('Dois', ['dois/**']),
      part('Três', ['tres/**']),
    ]);
    const files: Record<string, string> = {
      s1: 'um/f1.txt',
      s2: 'dois/f2.txt',
      s3: 'tres/f3.txt',
    };
    for (const id of ['s1', 's2', 's3']) {
      if (extra[id] === undefined) await write(treeOf(id), files[id] as string, `${id}\n`);
    }
    for (const [id, content] of Object.entries(extra)) await write(treeOf(id), 'a.txt', content);
    for (const id of ['s1', 's2', 's3']) turn(id);
    await done(race.id);
    return race.id;
  };
  return {
    ...dirs,
    worktrees,
    manager,
    registry,
    make,
    created,
    sent,
    closed,
    events,
    run,
    reviewer,
    anchors,
    state,
    turn,
    begin,
    treeOf,
    three,
    done,
    project,
    sessions,
    trees,
  };
}

const SLOW = { timeout: 180_000 };
const LONG = 90_000;

const integrationOf = (race: Race) => {
  if (!race.integration) throw new Error('sem integração');
  return race.integration;
};

describe('a ordem de juntar', () => {
  it('a zero primeiro, quem produz antes de quem consome, o resto por índice', () => {
    const lane = (index: number, after: number | null, zero = false) => ({ index, after, zero });
    // 0 é a zero; 1 parte de 3 (que produz para 1); 2 parte da zero.
    expect(
      mergeOrder([lane(2, 0), lane(1, 3), lane(0, null, true), lane(3, 0)]).map((l) => l.index),
    ).toEqual([0, 3, 1, 2]);
    // Cadeia 1 -> 2 e uma solta: a cadeia fica toda antes da solta de índice maior.
    expect(
      mergeOrder([lane(3, 0), lane(2, 1), lane(1, 0), lane(0, null, true)]).map((l) => l.index),
    ).toEqual([0, 1, 2, 3]);
    // Sem zero nem dependências, pelo índice.
    expect(mergeOrder([lane(2, null), lane(0, null), lane(1, null)]).map((l) => l.index)).toEqual([
      0, 1, 2,
    ]);
  });

  it('os números: custo somado, a mais lenta face à soma, conflitos e falhas', () => {
    const race = {
      split: {
        pending: [],
        warnings: [],
        lanes: [
          { sessionId: 'a', index: 0, after: null, startedAt: 1_000, settledAt: 2_000 },
          { sessionId: 'b', index: 1, after: null, startedAt: 1_000, settledAt: 4_000 },
          { sessionId: 'c', index: 2, after: null, startedAt: 1_000, settledAt: null },
        ],
      },
    } as unknown as Race;
    const steps = [
      { conflicts: ['x'], failures: 1 },
      { conflicts: [], failures: 2 },
    ] as never;
    expect(integrationMetrics(race, { steps, final: null }, 0.75)).toEqual({
      costUsd: 0.75,
      slowestMs: 3_000,
      totalMs: 4_000,
      conflicts: 1,
      failures: 3,
    });
    // As verificações finais são as que contam, quando correram.
    expect(
      integrationMetrics(race, { steps, final: { checks: [], failures: 0 } }, null).failures,
    ).toBe(0);
  });

  it('a mensagem de resolução diz o branch, os ficheiros, as duas partes e a verificação', () => {
    const lane = (title: string) => ({ title, part: part(title, [], { interfaces: 'GET /x' }) });
    const text = resolveMessage(
      'Fazer isto',
      lane('Vista'),
      { branch: 'solline/vista-abcd', files: ['a.txt', 'b.txt'] },
      [lane('Dados')],
      'Testes',
    );
    expect(text).toContain('`solline/vista-abcd` (parte «Vista»)');
    expect(text).toContain('- a.txt\n- b.txt');
    expect(text).toContain('Já juntadas:\n- «Dados»: Fazer Dados (interfaces: GET /x)');
    expect(text).toContain('A juntar agora:\n- «Vista»');
    expect(text).toContain('corre a verificação «Testes» do projeto e grava o merge num commit');
  });
});

describe('integrar as partes', SLOW, () => {
  it('três partes sem choques juntam-se pela ordem, com a verificação de cada uma, e o revisor lê o diff todo', async () => {
    const t = await setup({ costs: { s1: 0.5, s2: 0.25 } });
    const raceId = await t.three();
    // Tempos conhecidos: a mais lenta (3 s) face à soma de todas (6 s).
    const lanes = t.manager.get(raceId).split?.lanes ?? [];
    expect(lanes).toHaveLength(3);
    lanes.forEach((l, i) => {
      l.startedAt = 10_000;
      l.settledAt = 10_000 + [1_000, 3_000, 2_000][i]!;
    });

    const race = await t.manager.integrate(raceId);
    const integration = integrationOf(race);
    expect(race.phase).toBe('assembled');
    expect(integration.state).toBe('ready');
    expect(integration.steps.map((s) => [s.title, s.merged])).toEqual([
      ['Um', true],
      ['Dois', true],
      ['Três', true],
    ]);
    // Cada passo correu a verificação própria da parte, na ponta.
    for (const step of integration.steps) {
      expect(step.checks).toEqual([{ label: 'Testes', state: 'passed', preexisting: false }]);
      expect(step.failures).toBe(0);
    }
    // 3 passos + as verificações todas no fim, sempre na worktree da ponta.
    expect(t.run).toHaveBeenCalledTimes(4);
    for (const call of t.run.mock.calls) expect(call[1].cwd).toBe(integration.tip.path);
    expect(integration.final).toEqual({
      checks: [{ label: 'Testes', state: 'passed', preexisting: false }],
      failures: 0,
    });

    // A ponta tem as três partes, juntadas por merges, pela ordem.
    for (const [dir, file] of [
      ['um', 'f1.txt'],
      ['dois', 'f2.txt'],
      ['tres', 'f3.txt'],
    ] as const)
      expect(await exists(path.join(integration.tip.path, dir, file))).toBe(true);
    expect(git(integration.tip.path, 'log', '--merges', '--format=%s', '--reverse')).toBe(
      'Integrar «Um»\nIntegrar «Dois»\nIntegrar «Três»',
    );
    // O projeto ainda não mudou.
    expect(await exists(path.join(t.project.cwd, 'um', 'f1.txt'))).toBe(false);

    // O revisor correu uma vez, com o diff da ponta face à base e o pedido original.
    expect(t.reviewer).toHaveBeenCalledTimes(1);
    const input = vi.mocked(t.reviewer as Reviewer).mock.calls[0]![0];
    expect(input.request).toBe('Fazer três coisas');
    expect(input.cwd).toBe(integration.tip.path);
    expect(input.diff.map((d) => d.path).sort()).toEqual([
      'dois/f2.txt',
      'tres/f3.txt',
      'um/f1.txt',
    ]);
    expect(integration.review).toEqual([]);

    // Medido, sem inventar: soma dos custos conhecidos, a mais lenta e a soma dos tempos.
    expect(integration.metrics).toEqual({
      costUsd: 0.75,
      slowestMs: 3_000,
      totalMs: 6_000,
      conflicts: 0,
      failures: 0,
    });

    // Uma segunda vez não se repete, e a corrida fechada deixa tudo limpo.
    await expect(t.manager.integrate(raceId)).rejects.toThrow(/já está integrada/);
    const closing = await t.manager.close(raceId);
    expect(closing.closed).toBe(true);
    expect(t.closed.map((c) => c[1])).toEqual(['discard', 'discard', 'discard']);
    expect(await exists(integration.tip.path)).toBe(false);
    expect(git(t.project.cwd, 'branch', '--list', integration.tip.branch)).toBe('');
  });

  it('a zero vem primeiro e as cadeias pela ordem; os avisos de revisão falhada não estragam nada', async () => {
    const reviewer = vi.fn<Reviewer>(async () => {
      throw new Error('o revisor caiu');
    });
    const t = await setup({ reviewer });
    const { race } = await t.begin('Camadas', [
      part('Base', ['base/**'], { zero: true }),
      part('Camada', ['x/**']),
      part('Topo', ['x/ui/**']),
      part('Solta', ['y/**']),
    ]);
    await write(t.treeOf('s1'), 'base/b.txt', 'base\n');
    t.turn('s1');
    await waitFor(() => t.manager.get(race.id).lanes.length === 3, LONG);
    // s2 Camada e s3 Solta partem da zero; Topo espera pela Camada.
    await write(t.treeOf('s2'), 'x/c.txt', 'camada\n');
    await write(t.treeOf('s3'), 'y/s.txt', 'solta\n');
    t.turn('s2');
    await waitFor(() => t.manager.get(race.id).lanes.length === 4, LONG);
    await write(t.treeOf('s4'), 'x/ui/t.txt', 'topo\n');
    t.turn('s3');
    t.turn('s4');
    await t.done(race.id);

    const result = await t.manager.integrate(race.id);
    const integration = integrationOf(result);
    expect(integration.steps.map((s) => s.title)).toEqual(['Base', 'Camada', 'Topo', 'Solta']);
    expect(integration.state).toBe('ready');
    // O revisor falhou: guarda-se null e um aviso; a integração segue pronta.
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(integration.review).toBeNull();
    expect(integration.warnings.join(' ')).toContain('o revisor caiu');
  });

  it('uma verificação que já falhava na base fica marcada e não conta; uma nova conta', async () => {
    // Falha sempre: também na pasta da base, por isso já estava partida.
    const t = await setup({
      run: async () => ({ state: 'failed', tail: 'x', durationMs: 1 }),
    });
    const raceId = await t.three();
    const integration = integrationOf(await t.manager.integrate(raceId));
    expect(integration.state).toBe('ready');
    for (const step of integration.steps) {
      expect(step.checks).toEqual([{ label: 'Testes', state: 'failed', preexisting: true }]);
      expect(step.failures).toBe(0);
    }
    expect(integration.metrics.failures).toBe(0);

    // Falha só na ponta: é culpa do resultado.
    const t2 = await setup({
      run: async (_command, { cwd }) =>
        cwd.includes(`${path.sep}.base${path.sep}`)
          ? { state: 'passed', tail: null, durationMs: 1 }
          : { state: 'failed', tail: 'x', durationMs: 1 },
    });
    const second = integrationOf(await t2.manager.integrate(await t2.three()));
    expect(second.steps.every((s) => s.failures === 1 && !s.checks[0]?.preexisting)).toBe(true);
    expect(second.final?.failures).toBe(1);
    expect(second.metrics.failures).toBe(1);
    // Falhar não bloqueia: quem decide trazer é o Duarte.
    expect(second.state).toBe('ready');
  });

  it('recusa integrar se ainda há partes por arrancar ou a trabalhar', async () => {
    const t = await setup();
    const { race } = await t.begin('Cadeia', [
      part('Dados', ['src/shared/**']),
      part('Vista', ['src/shared/ui/**']),
    ]);
    await expect(t.manager.integrate(race.id)).rejects.toThrow(/ainda estão a trabalhar/);
    // A Vista ainda não arrancou, e a Dados deu erro: a Vista nunca arranca.
    t.state('s1', 'running');
    t.state('s1', 'error');
    await waitFor(() => t.manager.get(race.id).phase === 'done', LONG);
    expect(t.manager.get(race.id).split?.pending).toHaveLength(1);
    await expect(t.manager.integrate(race.id)).rejects.toThrow(
      /Ainda há partes por arrancar \(«Vista»\)/,
    );
    expect(t.manager.get(race.id).integration ?? null).toBeNull();
  });
});

describe('conflitos', SLOW, () => {
  /** Duas partes mudam a mesma linha de a.txt, sem o contrato prever. */
  async function conflicting() {
    const t = await setup({ costs: { s1: 1 } });
    const raceId = await t.three({ s1: 'versão um\n', s2: 'versão dois\n' });
    const integration = integrationOf(await t.manager.integrate(raceId));
    return { t, raceId, integration };
  }

  it('pára na parte que choca, com a ponta limpa; a sessão de resolução parte da ponta; continuar segue', async () => {
    const { t, raceId, integration } = await conflicting();
    const race = t.manager.get(raceId);
    expect(race.phase).toBe('done');
    expect(integration.state).toBe('conflict');
    expect(integration.conflict).toEqual({
      sessionId: 's2',
      branch: t.treeOf('s2').branch,
      files: ['a.txt'],
      resolver: null,
    });
    expect(integration.steps.map((s) => [s.title, s.merged, s.conflicts])).toEqual([
      ['Um', true, []],
      ['Dois', false, ['a.txt']],
    ]);
    // A ponta ficou no último estado bom: limpa, sem merge a meio e só com o que a Um fez.
    const tip = integration.tip;
    expect(git(tip.path, 'status', '--porcelain')).toBe('');
    expect(await exists(path.join(tip.path, '.git'))).toBe(true);
    expect(await readFile(path.join(tip.path, 'a.txt'), 'utf8')).toBe('versão um\n');
    expect(await exists(path.join(tip.path, 'tres', 'f3.txt'))).toBe(false);
    const tipHead = git(tip.path, 'rev-parse', 'HEAD');

    await expect(t.manager.continueIntegration(raceId)).rejects.toThrow(
      /Ainda ninguém está a resolver/,
    );

    const opened = await t.manager.resolve(raceId, t.project);
    expect(opened.session.session.id).toBe('s4');
    expect(integrationOf(opened.race).conflict?.resolver).toBe('s4');
    // Uma sessão normal, com o agente de quem produz primeiro, a partir da ponta.
    expect(t.created[3]).toEqual({
      id: 's4',
      agent: 'claude',
      after: `tip:${raceId}`,
      raceId,
    });
    expect(t.anchors.size).toBe(0);
    expect(t.treeOf('s4').base).toBe(tipHead);
    const message = t.sent.get('s4')?.[0] ?? '';
    expect(message).toContain(t.treeOf('s2').branch);
    expect(message).toContain('- a.txt');
    expect(message).toContain('«Dois»');
    expect(message).toContain('«Um»');
    expect(message).toContain('verificação «Testes»');
    // Não há duas resoluções ao mesmo tempo.
    await expect(t.manager.resolve(raceId, t.project)).rejects.toThrow(/Já há uma sessão/);

    // Ainda a trabalhar.
    t.state('s4', 'running');
    await expect(t.manager.continueIntegration(raceId)).rejects.toThrow(/ainda está a trabalhar/);
    t.state('s4', 'idle');
    // Parou, mas nada foi juntado.
    await expect(t.manager.continueIntegration(raceId)).rejects.toThrow(/ainda não foi juntado/);

    // O merge começa mas não se grava: mudanças por gravar também recusam.
    const resolverTree = t.treeOf('s4');
    try {
      git(resolverTree.path, 'merge', '--no-commit', t.treeOf('s2').branch);
    } catch {
      // Conflito esperado.
    }
    await writeFile(path.join(resolverTree.cwd, 'a.txt'), 'resolvido\n');
    await expect(t.manager.continueIntegration(raceId)).rejects.toThrow(/mudanças por gravar/);
    git(resolverTree.path, 'add', '-A');
    git(resolverTree.path, 'commit', '--quiet', '--no-edit');

    const finished = await t.manager.continueIntegration(raceId);
    const after = integrationOf(finished);
    expect(after.state).toBe('ready');
    expect(finished.phase).toBe('assembled');
    expect(after.conflict).toBeNull();
    expect(after.steps.map((s) => [s.title, s.merged, s.conflicts])).toEqual([
      ['Um', true, []],
      ['Dois', true, ['a.txt']],
      ['Três', true, []],
    ]);
    expect(after.steps[1]?.checks).toEqual([
      { label: 'Testes', state: 'passed', preexisting: false },
    ]);
    // A ponta é agora a worktree da sessão de resolução; a anterior saiu.
    expect(after.tip.path).toBe(resolverTree.path);
    expect(await exists(tip.path)).toBe(false);
    expect(await readFile(path.join(after.tip.path, 'a.txt'), 'utf8')).toBe('resolvido\n');
    expect(await exists(path.join(after.tip.path, 'tres', 'f3.txt'))).toBe(true);
    expect(after.metrics.conflicts).toBe(1);
    expect(after.metrics.costUsd).toBe(1);
    expect(t.reviewer).toHaveBeenCalledTimes(1);

    // Fechar tira as pistas, a sessão de resolução e a ponta.
    await t.manager.close(raceId);
    expect(t.closed.map(([id]) => id).sort()).toEqual(['s1', 's2', 's3', 's4']);
    expect(await exists(resolverTree.path)).toBe(false);
  });

  it('fechar durante a integração recusa; guardar uma pista mantém o branch', async () => {
    const { t, raceId } = await conflicting();
    const race = t.manager.get(raceId);
    race.phase = 'assembling';
    await expect(t.manager.close(raceId)).rejects.toThrow(/integração acabe/);
    race.phase = 'done';
    await t.manager.resolve(raceId, t.project);
    const kept = t.treeOf('s3').branch;
    const dropped = t.treeOf('s2').branch;
    await t.manager.close(raceId, 's3');
    expect(t.closed.find(([id]) => id === 's3')?.[1]).toBe('keep');
    expect(t.closed.find(([id]) => id === 's4')?.[1]).toBe('discard');
    expect(git(t.project.cwd, 'branch', '--list', kept)).toContain(kept);
    expect(git(t.project.cwd, 'branch', '--list', dropped)).toBe('');
  });

  it('depois de um reinício o conflito fica registado, sem sessão, e resolve-se outra vez a partir da ponta', async () => {
    const { t, raceId } = await conflicting();
    const snapshot = t.registry.recovery();
    const registry2 = new RaceRegistry(() => undefined);
    const second = t.make(registry2);
    second.restoreRecovery(snapshot);
    const restored = second.get(raceId);
    const integration = integrationOf(restored);
    expect(integration.state).toBe('conflict');
    expect(integration.conflict?.resolver).toBeNull();
    expect(restored.phase).toBe('done');
    // A ponta continua reclamada: não aparece como órfã.
    expect(second.worktreePaths()).toEqual([integration.tip.path]);
    // Nada arrancou sozinho.
    expect(t.created).toHaveLength(3);
    await expect(second.continueIntegration(raceId)).rejects.toThrow(/Ainda ninguém/);

    const opened = await second.resolve(raceId, t.project);
    expect(opened.session.session.id).toBe('s4');
    expect(t.treeOf('s4').base).toBe(git(integration.tip.path, 'rev-parse', 'HEAD'));
    expect(t.sent.get('s4')?.[0]).toContain('- a.txt');
  });
});

describe('trazer', SLOW, () => {
  it('traz a ponta para o projeto; com um conflito no projeto nada muda; fechar tira a ponta', async () => {
    const t = await setup();
    const raceId = await t.three({ s1: 'da integração\n' });
    const integration = integrationOf(await t.manager.integrate(raceId));
    expect(integration.state).toBe('ready');

    // O projeto mexeu na mesma linha: o merge conflitua e o projeto fica como estava.
    await writeFile(path.join(t.project.cwd, 'a.txt'), 'do projeto\n');
    git(t.project.cwd, 'commit', '--quiet', '-am', 'o projeto mexeu');
    const head = git(t.project.cwd, 'rev-parse', 'HEAD');
    const conflict = await t.manager.bring(raceId);
    expect(conflict.merged).toBe(false);
    expect(conflict.conflicts).toEqual(['a.txt']);
    expect(conflict.into).toBe('main');
    expect(git(t.project.cwd, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(t.project.cwd, 'status', '--porcelain')).toBe('');
    expect(integrationOf(t.manager.get(raceId)).state).toBe('ready');
    expect(integrationOf(t.manager.get(raceId)).brought).toBeNull();

    // Desfeito o choque, traz.
    git(t.project.cwd, 'reset', '--quiet', '--hard', 'HEAD~1');
    const brought = await t.manager.bring(raceId);
    expect(brought.merged).toBe(true);
    expect(integrationOf(brought.race).brought).toEqual({ into: 'main' });
    expect(integrationOf(brought.race).state).toBe('brought');
    expect(await readFile(path.join(t.project.cwd, 'a.txt'), 'utf8')).toBe('da integração\n');
    expect(await exists(path.join(t.project.cwd, 'dois', 'f2.txt'))).toBe(true);
    expect(git(t.project.cwd, 'log', '-1', '--format=%s')).toContain('Trazer');
    // Já trazida: não se traz outra vez.
    await expect(t.manager.bring(raceId)).rejects.toThrow(/Não há nenhuma integração por trazer/);

    // Trazida e recuperada: só falta fechar, e o branch (já no projeto) sai com a worktree.
    const second = t.make(new RaceRegistry(() => undefined));
    second.restoreRecovery(t.registry.recovery());
    expect(integrationOf(second.get(raceId)).state).toBe('brought');
    expect(second.get(raceId).phase).toBe('assembled');
    await second.close(raceId);
    expect(await exists(integration.tip.path)).toBe(false);
    expect(git(t.project.cwd, 'branch', '--list', integration.tip.branch)).toBe('');
  });
});

describe('recuperação', () => {
  const base = (integration: Race['integration'], phase: Race['phase']): Race =>
    ({
      id: 'r',
      kind: 'split',
      projectId: 'p',
      text: 'x',
      lanes: [],
      phase,
      split: { pending: [], warnings: [] },
      integration,
    }) as Race;
  const tip = { branch: 'b', path: 'p', top: 't', base: 'c' };
  const integration = (state: 'merging' | 'conflict' | 'ready' | 'brought') =>
    ({
      state,
      tip,
      steps: [],
      conflict:
        state === 'conflict' ? { sessionId: 's', branch: 'x', files: ['a'], resolver: 'r1' } : null,
      final: null,
      review: null,
      warnings: [],
      metrics: { costUsd: null, slowestMs: 0, totalMs: 0, conflicts: 0, failures: 0 },
      brought: state === 'brought' ? { into: 'main' } : null,
    }) as Race['integration'];

  it('a meio e pronta por trazer voltam a "acabada", sem integração (a ponta fica órfã)', () => {
    for (const [state, phase] of [
      ['merging', 'assembling'],
      ['ready', 'assembled'],
    ] as const) {
      const race = base(integration(state), phase);
      restoreIntegration(race);
      expect(race.integration).toBeNull();
      expect(race.phase).toBe('done');
    }
    const orphan = base(undefined, 'assembling');
    restoreIntegration(orphan);
    expect(orphan.phase).toBe('done');
  });

  it('um conflito fica registado sem a sessão; uma integração trazida fica como estava', () => {
    const conflict = base(integration('conflict'), 'done');
    restoreIntegration(conflict);
    expect(conflict.integration?.state).toBe('conflict');
    expect(conflict.integration?.conflict?.resolver).toBeNull();
    expect(conflict.integration?.conflict?.files).toEqual(['a']);
    const brought = base(integration('brought'), 'assembled');
    restoreIntegration(brought);
    expect(brought.integration?.state).toBe('brought');
    expect(brought.phase).toBe('assembled');
  });

  it('o gestor reclama só as pontas que continuam registadas', () => {
    const sessions = {} as IntegrationSessions & SplitSessions;
    const manager = new SplitManager({
      sessions,
      emit: () => undefined,
      integration: { sessions, worktrees: {} as never },
    });
    manager.restoreRecovery([
      { ...base(integration('merging'), 'assembling'), id: 'a' },
      { ...base(integration('conflict'), 'done'), id: 'b' },
      { ...base(integration('brought'), 'assembled'), id: 'c' },
    ]);
    expect(manager.worktreePaths()).toEqual(['p', 'p']);
    expect(manager.get('a').integration ?? null).toBeNull();
    expect(manager.get('a').phase).toBe('done');
  });
});
