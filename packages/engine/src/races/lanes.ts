import type { CommandResult, RaceLane, SessionStartPayload, SessionState } from '@solline/protocol';
import type { Worktree } from '../worktrees/worktrees.ts';

/**
 * As pistas, a mecânica comum às corridas e às repartições: abrir uma sessão por pista na sua
 * worktree, seguir o estado de cada uma pelos eventos e fechá-las no fim. Não sabe ordenar nem
 * montar: quem a usa decide o que fazer quando as pistas param.
 */

export type SessionCreateResult = CommandResult<'session.create'>;

/** O que o núcleo precisa do SessionManager. */
export interface LaneSessions {
  create(payload: SessionStartPayload): Promise<SessionCreateResult>;
  send(sessionId: string, text: string): Promise<unknown>;
  close(
    sessionId: string,
    worktree?: 'bring' | 'keep' | 'discard',
    dropQueue?: boolean,
  ): Promise<unknown>;
  /** A worktree da pista (não há, se a sessão já não existe). */
  worktreeOf(sessionId: string): Worktree | undefined;
}

/** Uma pista a abrir: o agente, o modelo (opcional) e o texto que recebe. */
export interface LaneOpen {
  agent: SessionStartPayload['agent'];
  model?: string | undefined;
  text: string;
  /** Parte do resultado desta sessão (a worktree dela, gravada) em vez do HEAD do projeto. */
  after?: string | undefined;
  /** Como a sessão se apresenta na origem: pista de uma corrida (por omissão) ou parte de uma repartição. */
  kind?: 'lane' | 'part';
}

export type LaneProject = Omit<
  SessionStartPayload,
  'agent' | 'model' | 'mode' | 'effort' | 'startAfter'
>;

export interface OpenedLanes {
  sessions: SessionCreateResult[];
  /** Manda a cada pista o seu texto (só depois de quem abriu registar o grupo). */
  send(): Promise<void>;
}

export const STOPPED: ReadonlySet<SessionState> = new Set(['idle', 'error']);

export class Lanes {
  readonly #sessions: LaneSessions;
  /** As pistas que já começaram a trabalhar (parada antes disso não conta como acabada). */
  readonly #started = new Set<string>();

  constructor(sessions: LaneSessions) {
    this.#sessions = sessions;
  }

  /**
   * Abre as pistas uma a uma (cada worktree num commit limpo), todas com o mesmo grupo. Uma que
   * não abre desfaz as outras: um grupo coxo não compara nem integra nada.
   */
  async open(
    project: LaneProject,
    group: string,
    lanes: readonly LaneOpen[],
  ): Promise<OpenedLanes> {
    const sessions: SessionCreateResult[] = [];
    try {
      for (const lane of lanes) {
        sessions.push(
          await this.#sessions.create({
            ...project,
            agent: lane.agent,
            ...(lane.model ? { model: lane.model } : {}),
            worktree: 'always',
            raceId: group,
            origin: {
              kind: lane.kind ?? 'lane',
              raceId: group,
              ...(lane.after ? { sessionId: lane.after } : {}),
            },
            ...(lane.after ? { startAfter: lane.after } : {}),
          }),
        );
      }
    } catch (error) {
      await Promise.all(
        sessions.map((s) =>
          this.#sessions.close(s.session.id, 'discard', true).catch(() => undefined),
        ),
      );
      throw error;
    }
    return {
      sessions,
      send: async () => {
        await Promise.all(
          sessions.map((s, i) => this.#sessions.send(s.session.id, lanes[i]?.text ?? '')),
        );
      },
    };
  }

  /** A pista já chegou a trabalhar (uma sessão que só ficou pronta ainda não conta). */
  hasStarted(sessionId: string): boolean {
    return this.#started.has(sessionId);
  }

  /**
   * Regista o estado que um evento trouxe à pista do grupo. Sem pista nem mudança, devolve
   * `undefined`; senão diz se todas já começaram e pararam (`settled`).
   */
  observe(
    lanes: readonly Pick<RaceLane, 'sessionId' | 'state'>[],
    event: { sessionId: string; state: SessionState },
  ): { settled: boolean } | undefined {
    const lane = lanes.find((l) => l.sessionId === event.sessionId);
    if (!lane || lane.state === event.state) return undefined;
    lane.state = event.state;
    if (!STOPPED.has(event.state)) this.#started.add(lane.sessionId);
    return {
      settled: lanes.every((l) => this.#started.has(l.sessionId) && STOPPED.has(l.state)),
    };
  }

  /** Marca como paradas as pistas de um grupo reposto do disco: as sessões não sobreviveram. */
  restored(lanes: readonly Pick<RaceLane, 'state'>[]): void {
    for (const lane of lanes) lane.state = 'error';
  }

  /**
   * Deita fora as pistas, guardando o branch de uma se pedido. Uma pista que já não existe (o
   * motor reiniciou) não impede de fechar.
   */
  async close(sessionIds: readonly string[], keep?: string): Promise<void> {
    for (const sessionId of sessionIds) {
      await this.#sessions
        .close(sessionId, sessionId === keep ? 'keep' : 'discard', true)
        .catch((error: unknown) => {
          if (this.#sessions.worktreeOf(sessionId)) throw error;
        });
    }
  }
}
