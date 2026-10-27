import { describe, expect, it } from 'vitest';
import type { EngineEvent, Race } from '@solline/protocol';
import type { RawFile } from '../src/checkpoints/unified-diff.ts';
import { RaceManager, type RaceSessions } from '../src/races/race-manager.ts';
import { needsJudge, patchKey, rankLanes, type LaneOutcome } from '../src/races/rank.ts';
import type { Judge } from '../src/verify/judge.ts';
import type { CheckVerdict } from '../src/verify/verify.ts';
import { waitFor } from './helpers.ts';

/** Um ficheiro mudado com estas linhas acrescentadas (o resto do RawFile não interessa aqui). */
function file(path: string, added: string[]): RawFile {
  return {
    header: [],
    hunks: [],
    diff: {
      path,
      status: 'modified',
      binary: false,
      additions: added.length,
      deletions: 0,
      hunks: [
        {
          id: `${path}:1`,
          header: '@@ -1 +1 @@',
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1 + added.length,
          lines: [
            { kind: 'context', text: 'x', oldNo: 1, newNo: 1 },
            ...added.map((text, i) => ({
              kind: 'add' as const,
              text,
              oldNo: null,
              newNo: i + 2,
            })),
          ],
        },
      ],
    },
  } as unknown as RawFile;
}

const check = (state: CheckVerdict['state'], preexisting = false): CheckVerdict => ({
  id: 'test',
  label: 'Testes',
  state,
  tail: null,
  preexisting,
});

const lane = (sessionId: string, files: RawFile[], checks: CheckVerdict[] = []): LaneOutcome => ({
  sessionId,
  files,
  checks,
});

describe('ordenar uma corrida', () => {
  it('o mesmo patch com espaços diferentes é a mesma solução', () => {
    expect(patchKey([file('a.ts', ['  const x = 1;'])])).toBe(
      patchKey([file('a.ts', ['const x = 1;   ', ''])]),
    );
    expect(patchKey([file('a.ts', ['const x = 1;'])])).not.toBe(
      patchKey([file('a.ts', ['const x = 2;'])]),
    );
  });

  it('a execução manda: quem parte uma verificação desce, e as que já falhavam não contam', () => {
    const verdict = rankLanes([
      lane('partiu', [file('a.ts', ['a'])], [check('failed')]),
      lane('ja-falhava', [file('a.ts', ['b'])], [check('failed', true)]),
      lane('vazia', []),
    ]);
    expect(verdict.lanes.map((l) => l.sessionId)).toEqual(['ja-falhava', 'partiu', 'vazia']);
    expect(verdict.lanes.map((l) => l.rank)).toEqual([1, 2, 3]);
    expect(verdict.lanes[2]?.empty).toBe(true);
    expect(verdict.judged).toBe(false);
    expect(verdict.tie).toBeNull();
  });

  it('o consenso desempata: duas pistas no mesmo patch ganham à que ficou sozinha', () => {
    const outcomes = [
      lane('sozinha', [file('a.ts', ['outra'])]),
      lane('um', [file('a.ts', ['igual'])]),
      lane('dois', [file('a.ts', ['igual'])]),
    ];
    expect(needsJudge(outcomes)).toEqual([]);
    const verdict = rankLanes(outcomes);
    expect(verdict.lanes.map((l) => l.sessionId)).toEqual(['um', 'dois', 'sozinha']);
    expect(verdict.lanes[0]?.group).toBe(verdict.lanes[1]?.group);
  });

  it('o juiz só entra num empate no topo entre soluções diferentes', () => {
    const tied = [lane('a', [file('a.ts', ['1'])]), lane('b', [file('a.ts', ['2'])])];
    expect(needsJudge(tied).map((o) => o.sessionId)).toEqual(['a', 'b']);
    // Sem juiz, o empate fica para ti.
    expect(rankLanes(tied).tie).toEqual(['a', 'b']);
    const judged = rankLanes(tied, {
      verdict: {
        order: ['b', 'a'],
        notes: { b: { best: 'curto', worst: 'sem testes' } },
        tie: null,
      },
    });
    expect(judged.lanes.map((l) => l.sessionId)).toEqual(['b', 'a']);
    expect(judged.lanes[0]).toMatchObject({ best: 'curto', worst: 'sem testes' });
    expect(judged.judged).toBe(true);
    expect(judged.tie).toBeNull();
    // Todas vazias: nada a julgar.
    expect(needsJudge([lane('x', []), lane('y', [])])).toEqual([]);
  });

  it('o juiz em erro deixa a ordem da execução e o empate marcado', () => {
    const tied = [lane('a', [file('a.ts', ['1'])]), lane('b', [file('a.ts', ['2'])])];
    const verdict = rankLanes(tied, { error: 'sem rede' });
    expect(verdict.lanes).toHaveLength(2);
    expect(verdict.judgeError).toBe('sem rede');
    expect(verdict.tie).toEqual(['a', 'b']);
  });
});

describe('RaceManager.rank', () => {
  function setup(outcomes: Record<string, LaneOutcome>, judge?: Judge) {
    const races: Race[] = [];
    let n = 0;
    const sessions: RaceSessions = {
      create: async (payload) =>
        ({
          session: {
            id: `s${++n}`,
            agent: payload.agent,
            state: 'starting',
            settings: { model: payload.model ?? null },
          },
        }) as never,
      send: async () => undefined,
      close: async () => undefined,
      outcome: async (id) => ({ cwd: '/wt', ...(outcomes[id] ?? lane(id, [])) }),
      worktreeOf: () => undefined,
      checkContext: () => ({ specs: [], env: {}, run: undefined }),
    };
    const manager = new RaceManager({
      sessions,
      emit: (e: EngineEvent) => {
        if (e.type === 'race.state') races.push(e.race);
      },
      ...(judge ? { judge } : {}),
    });
    const finish = (ids: string[]) => {
      for (const state of ['busy', 'idle'] as const)
        for (const sessionId of ids)
          manager.observe({ kind: 'event', type: 'session.state', sessionId, state } as never);
    };
    return { manager, races, finish };
  }

  it('quando param todas, ordena e chama o juiz nas duas ordens só no empate', async () => {
    const calls: string[][] = [];
    const judge: Judge = async (input) => {
      calls.push(input.candidates.map((c) => c.id));
      return { order: ['s2', 's1'], notes: {} };
    };
    const { manager, races, finish } = setup(
      {
        s1: lane('s1', [file('a.ts', ['1'])]),
        s2: lane('s2', [file('a.ts', ['2'])]),
      },
      judge,
    );
    const { race } = await manager.begin({
      projectId: 'p',
      cwd: '/p',
      trusted: true,
      text: 'faz',
      lanes: [{ agent: 'claude' }, { agent: 'claude' }],
    });
    finish(['s1', 's2']);
    await waitFor(() => races.at(-1)?.phase === 'ranked');
    expect(races.map((r) => r.phase)).toContain('ranking');
    expect(calls).toEqual([
      ['s1', 's2'],
      ['s2', 's1'],
    ]);
    const verdict = manager.get(race.id).verdict;
    expect(verdict?.lanes.map((l) => l.sessionId)).toEqual(['s2', 's1']);
    expect(verdict?.judged).toBe(true);
  });

  it('uma pista cujo resultado falha não deita a corrida abaixo', async () => {
    const { manager, races, finish } = setup({ s1: lane('s1', [file('a.ts', ['1'])]) });
    const sessions = await manager.begin({
      projectId: 'p',
      cwd: '/p',
      trusted: true,
      text: 'faz',
      lanes: [{ agent: 'claude' }, { agent: 'claude' }],
    });
    finish(['s1', 's2']);
    await waitFor(() => races.at(-1)?.phase === 'ranked');
    const verdict = manager.get(sessions.race.id).verdict;
    expect(verdict?.lanes.map((l) => [l.sessionId, l.empty])).toEqual([
      ['s1', false],
      ['s2', true],
    ]);
  });
});
