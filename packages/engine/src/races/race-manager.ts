import type {
  EngineEvent,
  Race,
  RaceLaneSpec,
  RacePhase,
  CommandResult,
  SessionStartPayload,
  SessionState,
} from '@solline/protocol';
import type { RawFile } from '../checkpoints/unified-diff.ts';
import { judgeBothWays, type Judge, type Verdict } from '../verify/judge.ts';
import type { CheckVerdict } from '../verify/verify.ts';
import { needsJudge, rankLanes, type LaneOutcome } from './rank.ts';

/**
 * As corridas: o mesmo pedido em várias pistas, cada uma uma sessão normal na sua worktree. A
 * corrida não tem agentes próprios: abre as sessões pelo SessionManager, manda-lhes o pedido e
 * segue o estado de cada uma pelos eventos. Quando todas param, ordena-as: pela execução primeiro
 * (diff e verificações de cada pista), e o juiz cego só nos empates do topo.
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
}

export type RaceBegin = Omit<SessionStartPayload, 'agent' | 'model' | 'mode' | 'effort'> & {
  text: string;
  lanes: readonly RaceLaneSpec[];
};

type SessionCreateResult = CommandResult<'session.create'>;

const STOPPED: ReadonlySet<SessionState> = new Set(['idle', 'error']);

export class RaceManager {
  readonly #races = new Map<string, Race>();
  readonly #sessions: RaceSessions;
  readonly #emit: (event: EngineEvent) => void;
  /** As pistas que já começaram a trabalhar (parada antes disso não conta como acabada). */
  readonly #started = new Set<string>();
  readonly #judge: Judge | undefined;

  constructor(options: {
    sessions: RaceSessions;
    emit: (event: EngineEvent) => void;
    /** Sem juiz, os empates do topo ficam para ti. */
    judge?: Judge;
  }) {
    this.#sessions = options.sessions;
    this.#emit = options.emit;
    this.#judge = options.judge;
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

  /** O que as sessões fazem chega aqui: o estado de cada pista e o fim da corrida. */
  observe(event: EngineEvent): void {
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
        void this.rank(race.id);
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
    if (race.phase !== 'done') return race;
    race.phase = 'ranking';
    this.#changed(race);
    const outcomes: (LaneOutcome & { cwd: string })[] = await Promise.all(
      race.lanes.map(async (lane) => {
        const outcome = await this.#sessions
          .outcome(lane.sessionId)
          .catch(() => ({ cwd: '', files: [], checks: [] }));
        return { sessionId: lane.sessionId, ...outcome };
      }),
    );
    const tied = needsJudge(outcomes);
    let judged: { verdict: Verdict } | { error: string } | undefined;
    if (tied.length > 1 && this.#judge) {
      judged = await judgeBothWays(this.#judge, {
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
    if (race.phase !== 'ranking') return race;
    race.verdict = rankLanes(outcomes, judged);
    race.phase = 'ranked';
    this.#changed(race);
    return race;
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
