import type {
  EngineEvent,
  Race,
  RaceLaneSpec,
  RacePhase,
  CommandResult,
  RaceProposal,
  SessionStartPayload,
  SessionState,
} from '@solline/protocol';
import type { RawFile } from '../checkpoints/unified-diff.ts';
import { judgeBothWays, type Judge, type Verdict } from '../verify/judge.ts';
import { failures, type CheckVerdict } from '../verify/verify.ts';
import type { Worktree } from '../worktrees/worktrees.ts';
import type { Assembler, AssemblerLane, CheckContext } from './assembler.ts';
import { needsJudge, rankLanes, type LaneOutcome } from './rank.ts';

/**
 * As corridas: o mesmo pedido em várias pistas, cada uma uma sessão normal na sua worktree. A
 * corrida não tem agentes próprios: abre as sessões pelo SessionManager, manda-lhes o pedido e
 * segue o estado de cada uma pelos eventos. Quando todas param, ordena-as: pela execução primeiro
 * (diff e verificações de cada pista), e o juiz cego só nos empates do topo. Depois monta-se o
 * resultado pedaço a pedaço, traz-se para o projeto e fecham-se as pistas.
 */

export interface RaceSessions {
  create(payload: SessionStartPayload): Promise<SessionCreateResult>;
  send(sessionId: string, text: string): Promise<unknown>;
  close(
    sessionId: string,
    worktree?: 'bring' | 'keep' | 'discard',
    dropQueue?: boolean,
  ): Promise<unknown>;
  /** O que a pista mudou face à base e as suas verificações (com a base ao lado). */
  outcome(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ cwd: string; files: readonly RawFile[]; checks: readonly CheckVerdict[] }>;
  /** A worktree da pista (não há, se a sessão já não existe). */
  worktreeOf(sessionId: string): Worktree | undefined;
  /** O que correr para verificar o trabalho desta pista. */
  checkContext(sessionId: string): CheckContext;
}

export type RaceBegin = Omit<SessionStartPayload, 'agent' | 'model' | 'mode' | 'effort'> & {
  text: string;
  lanes: readonly RaceLaneSpec[];
};

type SessionCreateResult = CommandResult<'session.create'>;

const STOPPED: ReadonlySet<SessionState> = new Set(['idle', 'error']);

export class RaceManager {
  readonly #ranking = new Map<string, AbortController>();
  #stopping = false;
  readonly #beforeEffect: (command: string, raceId: string) => () => void;
  readonly #races = new Map<string, Race>();
  readonly #sessions: RaceSessions;
  readonly #emit: (event: EngineEvent) => void;
  /** As pistas que já começaram a trabalhar (parada antes disso não conta como acabada). */
  readonly #started = new Set<string>();
  readonly #judge: Judge | undefined;
  readonly #assembler: Assembler | undefined;
  /** A worktree completa de cada montagem (só em memória: ao reiniciar, a não trazida vira órfã). */
  readonly #assemblies = new Map<string, Worktree>();

  constructor(options: {
    beforeEffect?: (command: string, raceId: string) => () => void;
    sessions: RaceSessions;
    emit: (event: EngineEvent) => void;
    /** Sem juiz, os empates do topo ficam para ti. */
    judge?: Judge;
    /** Sem montador, as corridas ordenam mas não montam (sem git, por exemplo). */
    assembler?: Assembler;
  }) {
    this.#sessions = options.sessions;
    this.#beforeEffect = options.beforeEffect ?? (() => () => undefined);
    this.#emit = options.emit;
    this.#judge = options.judge;
    this.#assembler = options.assembler;
  }

  /** Abre as pistas uma a uma (cada worktree num commit limpo) e manda-lhes o mesmo pedido. */
  async begin(payload: RaceBegin): Promise<{ race: Race; sessions: SessionCreateResult[] }> {
    const id = crypto.randomUUID();
    const { text, lanes, ...project } = payload;
    const sessions: SessionCreateResult[] = [];
    try {
      for (const lane of lanes) {
        sessions.push(
          await this.#sessions.create({
            ...project,
            agent: lane.agent,
            ...(lane.model ? { model: lane.model } : {}),
            worktree: 'always',
            raceId: id,
          }),
        );
      }
    } catch (error) {
      // Uma pista que não abre desfaz as outras: uma corrida coxa não compara nada.
      await Promise.all(
        sessions.map((s) =>
          this.#sessions.close(s.session.id, 'discard', true).catch(() => undefined),
        ),
      );
      throw error;
    }
    const race: Race = {
      id,
      projectId: payload.projectId,
      text,
      phase: 'running',
      lanes: sessions.map((s, i) => ({
        sessionId: s.session.id,
        agent: s.session.agent,
        model: lanes[i]?.model ?? s.session.settings.model ?? null,
        state: s.session.state,
      })),
    };
    this.#races.set(id, race);
    this.#changed(race);
    await Promise.all(sessions.map((s) => this.#sessions.send(s.session.id, text)));
    return { race: { ...race }, sessions };
  }

  get(raceId: string): Race {
    const race = this.#races.get(raceId);
    if (!race) throw new Error('Corrida desconhecida');
    return race;
  }

  recovery(): Race[] {
    return structuredClone([...this.#races.values()]);
  }

  restoreRecovery(races: Race[]): void {
    for (const race of structuredClone(races)) {
      if (race.phase === 'running' || race.phase === 'ranking') race.phase = 'done';
      // A worktree de uma montagem por trazer não sobrevive ao reinício (fica como órfã, que se
      // traz ou se deita fora na lista); uma já trazida só falta fechar.
      if (race.phase === 'assembling' || (race.phase === 'assembled' && !race.assembly?.brought)) {
        race.phase = 'ranked';
        race.assembly = null;
      }
      for (const lane of race.lanes) lane.state = 'error';
      this.#races.set(race.id, race);
    }
  }

  /** O que as sessões fazem chega aqui: o estado de cada pista e o fim da corrida. */
  observe(event: EngineEvent): void {
    if (this.#stopping) return;
    if (event.type !== 'session.state') return;
    for (const race of this.#races.values()) {
      const lane = race.lanes.find((l) => l.sessionId === event.sessionId);
      if (!lane || lane.state === event.state) continue;
      lane.state = event.state;
      if (!STOPPED.has(event.state)) this.#started.add(lane.sessionId);
      if (
        race.phase === 'running' &&
        race.lanes.every((l) => this.#started.has(l.sessionId) && STOPPED.has(l.state))
      ) {
        race.phase = 'done';
        this.#changed(race);
        void this.rank(race.id).catch((error) =>
          this.#emit({
            kind: 'event',
            type: 'engine.error',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        continue;
      }
      this.#changed(race);
    }
  }

  /**
   * Ordena a corrida: o resultado de cada pista, a ordem pela execução e o juiz só se houver um
   * empate no topo entre soluções diferentes. Nunca descarta pistas: só as ordena.
   */
  async rank(raceId: string): Promise<Race> {
    const race = this.get(raceId);
    if (this.#stopping || race.phase !== 'done') return race;
    const abort = new AbortController();
    this.#ranking.set(raceId, abort);
    try {
      return await this.#rank(race, abort.signal);
    } finally {
      this.#ranking.delete(raceId);
    }
  }

  async #rank(race: Race, signal: AbortSignal): Promise<Race> {
    const raceId = race.id;
    const completed = this.#beforeEffect('race.rank', raceId);
    race.phase = 'ranking';
    this.#changed(race);
    const outcomes: (LaneOutcome & { cwd: string })[] = await Promise.all(
      race.lanes.map(async (lane) => {
        const outcome = await this.#sessions
          .outcome(lane.sessionId, signal)
          .catch(() => ({ cwd: '', files: [], checks: [] }));
        return { sessionId: lane.sessionId, ...outcome };
      }),
    );
    if (signal.aborted) return race;
    const tied = needsJudge(outcomes);
    let judged: { verdict: Verdict } | { error: string } | undefined;
    if (tied.length > 1 && this.#judge) {
      judged = await judgeBothWays(this.#judge, {
        signal,
        cwd: outcomes.find((o) => o.cwd)?.cwd ?? '',
        request: race.text,
        candidates: tied.map((o) => ({
          id: o.sessionId,
          diff: o.files.map((f) => f.diff),
          checks: o.checks,
        })),
      })
        .then((verdict) => ({ verdict }))
        .catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        }));
    }
    // Fechada entretanto: o veredicto já não interessa.
    if (signal.aborted || race.phase !== 'ranking') return race;
    race.verdict = rankLanes(outcomes, judged);
    race.phase = 'ranked';
    this.#changed(race);
    completed();
    return race;
  }

  /** O que se pode montar com as pistas, zona a zona, com a escolha de partida. */
  async proposal(raceId: string): Promise<RaceProposal> {
    const race = this.get(raceId);
    if (race.phase !== 'ranked' && race.phase !== 'assembled')
      throw new Error('Só se monta uma corrida já ordenada.');
    const assembler = this.#requireAssembler();
    return (await assembler.propose(this.#lanes(race))).proposal;
  }

  /**
   * Monta as escolhas numa worktree nova e verifica-a. Se falhar, a corrida fica como estava;
   * montar outra vez troca a montagem anterior (se ainda não foi trazida).
   */
  async assemble(raceId: string, picks: readonly string[]): Promise<Race> {
    const race = this.get(raceId);
    const before = race.phase;
    if (before !== 'ranked' && before !== 'assembled')
      throw new Error('Só se monta uma corrida já ordenada.');
    if (race.assembly?.brought) throw new Error('A montagem já foi trazida para o projeto.');
    const assembler = this.#requireAssembler();
    const lanes = this.#lanes(race);
    const best = [...lanes].sort((a, b) => a.rank - b.rank)[0];
    if (!best) throw new Error('As pistas já não estão disponíveis.');
    race.phase = 'assembling';
    this.#changed(race);
    try {
      const built = await assembler.build(
        lanes,
        picks,
        this.#sessions.checkContext(best.sessionId),
      );
      const previous = this.#assemblies.get(raceId);
      if (previous) await assembler.discard(previous, 'always').catch(() => undefined);
      this.#assemblies.set(raceId, built.worktree);
      race.assembly = {
        branch: built.worktree.branch,
        path: built.worktree.path,
        top: built.worktree.top,
        ...built.stats,
        checks: built.checks.map((c) => ({
          label: c.label,
          state: c.state,
          preexisting: c.preexisting,
        })),
        failures: failures(built.checks),
        brought: null,
      };
      race.phase = 'assembled';
    } catch (error) {
      race.phase = before;
      throw error;
    } finally {
      this.#changed(race);
    }
    return race;
  }

  /** Traz a montagem para o branch atual do projeto. Com conflitos, nada muda no projeto. */
  async bring(
    raceId: string,
  ): Promise<{ race: Race; merged: boolean; conflicts: string[]; into: string }> {
    const race = this.get(raceId);
    const worktree = this.#assemblies.get(raceId);
    if (race.phase !== 'assembled' || !race.assembly || race.assembly.brought)
      throw new Error('Não há nenhuma montagem por trazer.');
    if (!worktree) throw new Error('A montagem já não está disponível.');
    const title = race.text.split('\n')[0]?.trim().slice(0, 72) ?? '';
    const { result, wt } = await this.#requireAssembler().bring(
      worktree,
      `Montagem da corrida: ${title}`,
    );
    if (result.merged) {
      this.#assemblies.set(raceId, wt);
      race.assembly = { ...race.assembly, brought: { into: result.into } };
      this.#changed(race);
    }
    return { race, merged: result.merged, conflicts: result.conflicts, into: result.into };
  }

  /**
   * Fecha a corrida (o main já confirmou): deita fora as pistas, guardando o branch de uma se
   * pedido, e a montagem (o branch dela só fica se já tiver sido trazido).
   */
  async close(raceId: string, keep?: string): Promise<{ closed: boolean; race: Race }> {
    const race = this.get(raceId);
    if (race.phase === 'closed') return { closed: true, race };
    if (race.phase === 'running' || race.phase === 'ranking' || race.phase === 'assembling')
      throw new Error('Espera que a corrida acabe de trabalhar antes de a fechar.');
    if (keep !== undefined && !race.lanes.some((l) => l.sessionId === keep))
      throw new Error('Essa pista não é desta corrida.');
    for (const lane of race.lanes) {
      await this.#sessions
        .close(lane.sessionId, lane.sessionId === keep ? 'keep' : 'discard', true)
        .catch((error: unknown) => {
          // Uma pista que já não existe (o motor reiniciou) não impede de fechar a corrida.
          if (this.#sessions.worktreeOf(lane.sessionId)) throw error;
        });
    }
    if (race.assembly)
      await this.#assembler?.discard(race.assembly, race.assembly.brought ? 'if-merged' : 'always');
    this.#assemblies.delete(raceId);
    race.phase = 'closed';
    this.#changed(race);
    return { closed: true, race };
  }

  #requireAssembler(): Assembler {
    if (!this.#assembler) throw new Error('As corridas não montam neste projeto.');
    return this.#assembler;
  }

  /** As pistas com worktree, com a posição do veredicto (a ordem de abertura sem veredicto). */
  #lanes(race: Race): AssemblerLane[] {
    return race.lanes.flatMap((lane, index) => {
      const worktree = this.#sessions.worktreeOf(lane.sessionId);
      const rank = race.verdict?.lanes.find((v) => v.sessionId === lane.sessionId)?.rank;
      return worktree ? [{ sessionId: lane.sessionId, rank: rank ?? index + 1, worktree }] : [];
    });
  }

  stopForRecovery(): void {
    this.#stopping = true;
    for (const abort of this.#ranking.values()) abort.abort();
    for (const race of this.#races.values()) if (race.phase === 'ranking') race.phase = 'done';
  }

  setPhase(raceId: string, phase: RacePhase): void {
    const race = this.get(raceId);
    race.phase = phase;
    this.#changed(race);
  }

  #changed(race: Race): void {
    this.#emit({
      kind: 'event',
      type: 'race.state',
      race: { ...race, lanes: race.lanes.map((l) => ({ ...l })) },
    });
  }
}
