import type { CheckSpec, WorktreeStats } from '@solline/protocol';
import type { RunCommand } from '../checks/run.ts';
import { verify, type CheckVerdict } from '../verify/verify.ts';
import type { BringResult, Worktree, WorktreeManager } from '../worktrees/worktrees.ts';
import { chosenPatches, propose, type Assembly } from './assembly.ts';

/**
 * A montagem de uma corrida numa worktree própria: parte do mesmo commit das pistas, aplica os
 * pedaços escolhidos, liga as dependências da melhor pista e corre as verificações do projeto
 * (com a base ao lado, para separar o que a montagem partiu do que já estava partido).
 */

export interface AssemblerLane {
  sessionId: string;
  /** 1 é a melhor (a ordem do veredicto). */
  rank: number;
  worktree: Worktree;
}

export interface CheckContext {
  specs: readonly CheckSpec[];
  env: Record<string, string>;
  run?: RunCommand | undefined;
}

export interface Built {
  worktree: Worktree;
  stats: WorktreeStats;
  checks: CheckVerdict[];
}

export class Assembler {
  readonly #worktrees: WorktreeManager;

  constructor(options: { worktrees: WorktreeManager }) {
    this.#worktrees = options.worktrees;
  }

  /** O que cada pista mudou, partido em zonas e candidatos (a escolha de partida incluída). */
  async propose(lanes: readonly AssemblerLane[]): Promise<Assembly> {
    return propose(
      await Promise.all(
        lanes.map(async (lane) => ({
          sessionId: lane.sessionId,
          rank: lane.rank,
          files: await this.#worktrees.diff(lane.worktree),
        })),
      ),
    );
  }

  /**
   * Monta as escolhas (ids de candidatos). Se qualquer passo falhar, a worktree da montagem é
   * deitada fora: ou há uma montagem inteira, ou nada.
   */
  async build(
    lanes: readonly AssemblerLane[],
    picks: readonly string[],
    context: CheckContext,
    signal?: AbortSignal,
  ): Promise<Built> {
    const best = [...lanes].sort((a, b) => a.rank - b.rank)[0];
    if (!best) throw new Error('A corrida já não tem pistas disponíveis.');
    if (lanes.some((l) => l.worktree.base !== best.worktree.base))
      throw new Error('As pistas partiram de commits diferentes: não se podem juntar.');
    // Recalcula agora: as escolhas valem para o que as pistas têm neste momento.
    const patches = chosenPatches(await this.propose(lanes), picks);
    const worktree = await this.#worktrees.createFrom(best.worktree);
    try {
      await this.#worktrees.apply(worktree, patches);
      await this.#worktrees.linkDependencies(best.worktree, worktree);
      const stats = await this.#worktrees.stats(worktree);
      const checks =
        context.specs.length === 0
          ? []
          : await verify(worktree.cwd, {
              specs: context.specs,
              baseline: () => this.#worktrees.baseline(worktree),
              env: context.env,
              ...(context.run ? { run: context.run } : {}),
              ...(signal ? { signal } : {}),
            });
      return { worktree, stats, checks };
    } catch (error) {
      await this.#worktrees.remove(worktree, 'always').catch(() => undefined);
      throw error;
    }
  }

  /** Traz a montagem para o branch atual do projeto (merge, como numa sessão). */
  bring(worktree: Worktree, message: string): Promise<{ result: BringResult; wt: Worktree }> {
    return this.#worktrees.bring(worktree, message);
  }

  /** Tira a worktree da montagem. 'always' deita o branch fora; 'if-merged' só se já foi trazido. */
  discard(
    assembly: Pick<Worktree, 'path' | 'top' | 'branch'>,
    branch: 'always' | 'if-merged',
  ): Promise<void> {
    return this.#worktrees.remove(assembly, branch);
  }
}
