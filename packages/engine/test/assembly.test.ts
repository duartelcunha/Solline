import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineEvent, Race } from '@solline/protocol';
import { Assembler, type AssemblerLane } from '../src/races/assembler.ts';
import { chosenPatches } from '../src/races/assembly.ts';
import { RaceManager, type RaceSessions } from '../src/races/race-manager.ts';
import type { Worktree } from '../src/worktrees/worktrees.ts';
import { WorktreeManager } from '../src/worktrees/worktrees.ts';

let root: string;
let project: string;
let worktrees: WorktreeManager;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

const LINES = Array.from({ length: 40 }, (_, i) => `linha ${i + 1}`);
const text = (edit: Record<number, string> = {}) =>
  LINES.map((line, i) => edit[i + 1] ?? line).join('\n') + '\n';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'solline-asm-'));
  project = path.join(root, 'project');
  await mkdir(project);
  git(project, 'init', '--quiet', '-b', 'main');
  git(project, 'config', 'user.email', 'teste@solline.local');
  git(project, 'config', 'user.name', 'Teste');
  git(project, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(project, 'main.txt'), text());
  git(project, 'add', '-A');
  git(project, 'commit', '--quiet', '-m', 'início');
  worktrees = new WorktreeManager({ root: path.join(root, 'data', 'worktrees') });
}, 30_000);

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Duas pistas a partir do mesmo commit: A e B mexem na zona de cima de maneira diferente e
 *  escrevem o mesmo no fim e num ficheiro novo. */
async function twoLanes(): Promise<AssemblerLane[]> {
  const a = (await worktrees.create(project, 'p'))!;
  const b = (await worktrees.create(project, 'p'))!;
  await writeFile(path.join(a.cwd, 'main.txt'), text({ 2: 'A dois', 38: 'ambas' }));
  await writeFile(path.join(b.cwd, 'main.txt'), text({ 2: 'B dois', 38: 'ambas' }));
  await writeFile(path.join(a.cwd, 'novo.txt'), 'x\n');
  await writeFile(path.join(b.cwd, 'novo.txt'), 'x\n');
  return [
    { sessionId: 'a', rank: 1, worktree: a },
    { sessionId: 'b', rank: 2, worktree: b },
  ];
}

const NO_CHECKS = { specs: [], env: {}, run: undefined };

describe('montar o resultado de uma corrida', { timeout: 60_000 }, () => {
  it('propõe zonas e candidatos: o consenso e a melhor pista entram de partida', async () => {
    const lanes = await twoLanes();
    const { proposal } = await new Assembler({ worktrees }).propose(lanes);
    expect(proposal.skipped).toEqual([]);
    const main = proposal.files.find((f) => f.path === 'main.txt')!;
    // A zona de cima tem duas alternativas (uma por pista); a da pista melhor entra.
    const top = main.slots[0]!;
    expect(top.candidates.map((c) => [c.lanes, c.preferred])).toEqual([
      [['a'], true],
      [['b'], false],
    ]);
    // O fim, escrito igual nas duas pistas, é um só candidato com dois votos.
    const end = main.slots[1]!;
    expect(end.candidates).toHaveLength(1);
    expect(end.candidates[0]).toMatchObject({ lanes: ['a', 'b'], preferred: true });
    // O ficheiro novo, igual nas duas, também.
    const novo = proposal.files.find((f) => f.path === 'novo.txt')!;
    expect(novo.status).toBe('added');
    expect(novo.slots[0]?.candidates[0]).toMatchObject({ lanes: ['a', 'b'], preferred: true });
  });

  it('monta as escolhas numa worktree nova e traz por merge; as pistas ficam como estavam', async () => {
    const lanes = await twoLanes();
    const assembler = new Assembler({ worktrees });
    const { proposal, parts } = await assembler.propose(lanes);
    const preferred = proposal.files.flatMap((f) =>
      f.slots.flatMap((s) => s.candidates.filter((c) => c.preferred).map((c) => c.id)),
    );
    expect(parts.size).toBe(4);

    const built = await assembler.build(lanes, preferred, NO_CHECKS);
    expect(built.stats).toEqual({ files: 2, additions: 3, deletions: 2 });
    expect(built.checks).toEqual([]);
    const file = await readFile(path.join(built.worktree.cwd, 'main.txt'), 'utf8');
    expect(file).toBe(text({ 2: 'A dois', 38: 'ambas' }));
    expect(await readFile(path.join(built.worktree.cwd, 'novo.txt'), 'utf8')).toBe('x\n');
    // O projeto e as pistas não mudaram com a montagem.
    expect(await readFile(path.join(project, 'main.txt'), 'utf8')).toBe(text());
    expect(await readFile(path.join(lanes[1]!.worktree.cwd, 'main.txt'), 'utf8')).toBe(
      text({ 2: 'B dois', 38: 'ambas' }),
    );

    // Trocar a zona de cima pela alternativa da pista B, noutra montagem.
    const bTop = proposal.files[0]!.slots[0]!.candidates.find((c) => c.lanes[0] === 'b')!;
    const rest = preferred.filter((id) => !id.startsWith('main.txt:1:'));
    const second = await assembler.build(lanes, [...rest, bTop.id], NO_CHECKS);
    expect(await readFile(path.join(second.worktree.cwd, 'main.txt'), 'utf8')).toBe(
      text({ 2: 'B dois', 38: 'ambas' }),
    );
    await assembler.discard(second.worktree, 'always');

    const { result } = await assembler.bring(built.worktree, 'Montagem da corrida: teste');
    expect(result).toMatchObject({ merged: true, conflicts: [], into: 'main' });
    expect(await readFile(path.join(project, 'main.txt'), 'utf8')).toBe(
      text({ 2: 'A dois', 38: 'ambas' }),
    );
    await assembler.discard(built.worktree, 'if-merged');
    expect(git(project, 'branch', '--list', built.worktree.branch)).toBe('');
  });

  it('recusa duas escolhas na mesma zona, uma escolha que já não existe e nenhuma escolha', async () => {
    const lanes = await twoLanes();
    const assembly = await new Assembler({ worktrees }).propose(lanes);
    const [first, second] = assembly.proposal.files[0]!.slots[0]!.candidates;
    expect(() => chosenPatches(assembly, [first!.id, second!.id])).toThrow('mesma zona');
    expect(() => chosenPatches(assembly, ['main.txt:2:inventado'])).toThrow('já não existe');
    expect(() => chosenPatches(assembly, [])).toThrow('pelo menos um');
    // Os patches saem de baixo para cima: aplicar um não desloca o que fica acima.
    const all = chosenPatches(assembly, [
      first!.id,
      assembly.proposal.files[0]!.slots[1]!.candidates[0]!.id,
    ]);
    expect(all.map((p) => p.label)).toEqual(['main.txt (linha 35)', 'main.txt (linha 1)']);
  });

  it('o que uma pista escreveu numa zona entra inteiro, mesmo em vários hunks', async () => {
    const a = (await worktrees.create(project, 'p'))!;
    const b = (await worktrees.create(project, 'p'))!;
    // A mexe em dois sítios afastados; B reescreve o meio todo e liga-os numa só zona.
    await writeFile(path.join(a.cwd, 'main.txt'), text({ 2: 'A cima', 20: 'A baixo' }));
    const middle = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [i + 4, `B ${i + 4}`]));
    await writeFile(path.join(b.cwd, 'main.txt'), text(middle));
    const lanes: AssemblerLane[] = [
      { sessionId: 'a', rank: 1, worktree: a },
      { sessionId: 'b', rank: 2, worktree: b },
    ];
    const assembler = new Assembler({ worktrees });
    const { proposal } = await assembler.propose(lanes);
    const slots = proposal.files[0]!.slots;
    expect(slots).toHaveLength(1);
    const fromA = slots[0]!.candidates.find((c) => c.lanes[0] === 'a')!;
    expect(fromA.hunks).toHaveLength(2);
    const built = await assembler.build(lanes, [fromA.id], NO_CHECKS);
    expect(await readFile(path.join(built.worktree.cwd, 'main.txt'), 'utf8')).toBe(
      text({ 2: 'A cima', 20: 'A baixo' }),
    );
    await assembler.discard(built.worktree, 'always');
  });

  it('corre as verificações na montagem e separa o que já falhava na base', async () => {
    const lanes = await twoLanes();
    const assembler = new Assembler({ worktrees });
    const { proposal } = await assembler.propose(lanes);
    const picks = proposal.files.flatMap((f) =>
      f.slots.flatMap((s) => s.candidates.filter((c) => c.preferred).map((c) => c.id)),
    );
    const ran: string[] = [];
    const run = async (command: string, options: { cwd: string }) => {
      ran.push(`${command}@${path.basename(options.cwd)}`);
      return { state: 'failed' as const, tail: 'falha', durationMs: 0 };
    };
    const built = await assembler.build(lanes, picks, {
      specs: [{ id: 'testes', label: 'Testes', command: 'npm test', enabled: true }],
      env: {},
      run,
    });
    // Falhou na montagem e também na base: já falhava, não conta contra a montagem.
    expect(built.checks).toMatchObject([{ id: 'testes', state: 'failed', preexisting: true }]);
    expect(ran).toHaveLength(2);
    await assembler.discard(built.worktree, 'always');
  });

  it('deita fora a worktree se um pedaço não encaixar', async () => {
    const lanes = await twoLanes();
    const assembler = new Assembler({ worktrees });
    const { proposal } = await assembler.propose(lanes);
    const picks = proposal.files.flatMap((f) =>
      f.slots.flatMap((s) => s.candidates.filter((c) => c.preferred).map((c) => c.id)),
    );
    // A pista de que depende o resultado muda a meio: o candidato escolhido deixa de existir.
    await writeFile(path.join(lanes[0]!.worktree.cwd, 'main.txt'), text({ 20: 'outra zona' }));
    const before = git(project, 'worktree', 'list').split('\n').length;
    await expect(assembler.build(lanes, picks, NO_CHECKS)).rejects.toThrow('já não existe');
    expect(git(project, 'worktree', 'list').split('\n').length).toBe(before);
  });
});

describe('a montagem na corrida', { timeout: 60_000 }, () => {
  function setup(lanes: AssemblerLane[]) {
    const closed: [string, string | undefined][] = [];
    const races: Race[] = [];
    const sessions: RaceSessions = {
      create: async () => {
        throw new Error('não abre pistas');
      },
      send: async () => undefined,
      close: async (id, worktree) => {
        closed.push([id, worktree]);
        return { closed: true };
      },
      outcome: async () => ({ cwd: '', files: [], checks: [] }),
      worktreeOf: (id) => lanes.find((l) => l.sessionId === id)?.worktree as Worktree | undefined,
      checkContext: () => NO_CHECKS,
    };
    const manager = new RaceManager({
      sessions,
      emit: (event: EngineEvent) => {
        if (event.type === 'race.state') races.push(event.race);
      },
      assembler: new Assembler({ worktrees }),
    });
    manager.restoreRecovery([
      {
        kind: 'race',
        id: 'r',
        projectId: 'p',
        text: 'Muda o ficheiro\ncom duas linhas',
        phase: 'ranked',
        lanes: lanes.map((l) => ({
          sessionId: l.sessionId,
          agent: 'scripted',
          model: null,
          state: 'idle' as const,
        })),
      },
    ]);
    return { manager, closed, races };
  }

  it('monta, traz e fecha: as pistas saem (uma guardada) e o branch da montagem sai com elas', async () => {
    const lanes = await twoLanes();
    const { manager, closed, races } = setup(lanes);
    const proposal = await manager.proposal('r');
    const picks = proposal.files.flatMap((f) =>
      f.slots.flatMap((s) => s.candidates.filter((c) => c.preferred).map((c) => c.id)),
    );
    const assembled = await manager.assemble('r', picks);
    expect(assembled.phase).toBe('assembled');
    expect(assembled.assembly).toMatchObject({ files: 2, failures: 0, brought: null });
    expect(races.map((r) => r.phase)).toEqual(['assembling', 'assembled']);
    // A montagem está em uso: não aparece como worktree órfã na mesa.
    expect(manager.worktreePaths()).toEqual([assembled.assembly!.path]);

    const brought = await manager.bring('r');
    expect(brought).toMatchObject({ merged: true, into: 'main' });
    expect(brought.race.assembly?.brought).toEqual({ into: 'main' });
    expect(git(project, 'log', '-1', '--format=%s', '--first-parent')).toContain('Trazer');
    await expect(manager.assemble('r', picks)).rejects.toThrow('já foi trazida');

    const closing = await manager.close('r', 'b');
    expect(closing.race.phase).toBe('closed');
    expect(manager.worktreePaths()).toEqual([]);
    expect(closed).toEqual([
      ['a', 'discard'],
      ['b', 'keep'],
    ]);
    expect(git(project, 'branch', '--list', assembled.assembly!.branch)).toBe('');
  });

  it('montar de novo troca a montagem anterior, e fechar com uma por trazer deita-a fora', async () => {
    const lanes = await twoLanes();
    const { manager } = setup(lanes);
    const proposal = await manager.proposal('r');
    const picks = proposal.files.flatMap((f) =>
      f.slots.flatMap((s) => s.candidates.filter((c) => c.preferred).map((c) => c.id)),
    );
    const first = (await manager.assemble('r', picks)).assembly!;
    const second = (await manager.assemble('r', picks)).assembly!;
    expect(second.branch).not.toBe(first.branch);
    expect(git(project, 'branch', '--list', first.branch)).toBe('');
    expect(git(project, 'branch', '--list', second.branch)).toContain(second.branch);
    await manager.close('r');
    expect(git(project, 'branch', '--list', second.branch)).toBe('');
  });

  it('uma montagem que falha deixa a corrida como estava', async () => {
    const lanes = await twoLanes();
    const { manager } = setup(lanes);
    await expect(manager.assemble('r', ['main.txt:2:inventado'])).rejects.toThrow('já não existe');
    expect(manager.get('r')).toMatchObject({ phase: 'ranked' });
    await expect(manager.assemble('r', [])).rejects.toThrow('pelo menos um');
    expect(manager.get('r').phase).toBe('ranked');
  });

  it('não fecha enquanto trabalha; não monta sem ordenar; ao reiniciar a montagem por trazer volta a ordenada', async () => {
    const lanes = await twoLanes();
    const { manager } = setup(lanes);
    manager.setPhase('r', 'running');
    await expect(manager.close('r')).rejects.toThrow('acabe de trabalhar');
    await expect(manager.proposal('r')).rejects.toThrow('já ordenada');
    manager.setPhase('r', 'ranked');
    const picks = (await manager.proposal('r')).files.flatMap((f) =>
      f.slots.flatMap((s) => s.candidates.filter((c) => c.preferred).map((c) => c.id)),
    );
    await manager.assemble('r', picks);
    const snapshot = manager.recovery();
    const { manager: restarted } = setup(lanes);
    restarted.restoreRecovery([
      { ...snapshot[0]!, id: 'again' },
      {
        ...snapshot[0]!,
        id: 'brought',
        assembly: { ...snapshot[0]!.assembly!, brought: { into: 'main' } },
      },
      { ...snapshot[0]!, id: 'mid', phase: 'assembling' },
    ]);
    expect(restarted.get('again')).toMatchObject({ phase: 'ranked', assembly: null });
    expect(restarted.get('mid')).toMatchObject({ phase: 'ranked', assembly: null });
    expect(restarted.get('brought')).toMatchObject({ phase: 'assembled' });
  });
});
