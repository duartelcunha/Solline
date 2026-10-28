import type { EngineEvent, SessionInfo, SessionState } from '@solline/protocol';

/**
 * Quando avisar fora da app, e só com a janela sem foco (com foco, o bot já o mostra): uma
 * sessão que passa a precisar de ti, que acaba um turno, que cai, ou cujas verificações falham.
 * Um aviso por acontecimento. Função pura; o main mostra a janela própria da Solline
 * sem roubar foco, e a ação explícita abre a conversa correspondente.
 */

export interface Tracked {
  agent: string;
  project: string;
  state: SessionState;
  /** A última ronda de verificações que já deu aviso (uma vez por ronda). */
  checksWarned: string | null;
}

export interface Attention {
  sessionId: string;
  title: string;
  body: string;
  /** Identifica pedidos que precisam de intervenção. */
  urgent: boolean;
}

const LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

export function agentLabel(agent: string): string {
  return LABELS[agent] ?? agent.charAt(0).toUpperCase() + agent.slice(1);
}

export class AttentionTracker {
  readonly #sessions = new Map<string, Tracked>();
  /** Rondas de verificações que já deram aviso: sessões na mesma pasta partilham a ronda. */
  readonly #warnedRounds = new Set<string>();

  /** Uma sessão nova (ou retomada), com o nome do projeto para o título do aviso. */
  track(session: Pick<SessionInfo, 'id' | 'agent' | 'state'>, project: string): void {
    this.#sessions.set(session.id, {
      agent: session.agent,
      project,
      state: session.state,
      checksWarned: null,
    });
  }

  /**
   * As pistas de uma repartição que arrancam depois da primeira só aparecem num race.state:
   * passam a ser seguidas aqui, sem tocar no conteúdo delas. As que já se seguem ficam como estão.
   */
  trackLanes(
    lanes: readonly { sessionId: string; agent: string; state: SessionState }[],
    project: string,
  ): void {
    for (const lane of lanes) {
      if (this.#sessions.has(lane.sessionId)) continue;
      this.track({ id: lane.sessionId, agent: lane.agent, state: lane.state }, project);
    }
  }

  /**
   * Como `trackLanes`, mas só para repartições abertas: as pistas de uma repartição fechada já
   * foram deitadas fora e não voltam a seguir-se com um `race.state` tardio.
   */
  trackRace(
    race: {
      kind: string;
      phase: string;
      lanes: readonly { sessionId: string; agent: string; state: SessionState }[];
    },
    project: string,
  ): void {
    if (race.kind !== 'split' || race.phase === 'closed') return;
    this.trackLanes(race.lanes, project);
  }

  /** O aviso que este evento merece, ou null. Atualiza sempre o estado guardado. */
  observe(event: EngineEvent, focused: boolean): Attention | null {
    if (event.type === 'session.checks') return this.#checks(event, focused);
    if (event.type === 'consult.request') return this.#consult(event, focused);
    if (event.type !== 'session.state') return null;
    const session = this.#sessions.get(event.sessionId);
    if (!session) return null;
    const previous = session.state;
    session.state = event.state;
    if (focused || previous === event.state) return null;
    const title = `${agentLabel(session.agent)} · ${session.project}`;
    if (event.state === 'needs-you') {
      return { sessionId: event.sessionId, title, body: 'Precisa de ti', urgent: true };
    }
    if ((previous === 'running' || previous === 'needs-you') && event.state === 'idle') {
      return { sessionId: event.sessionId, title, body: 'Turno acabado', urgent: false };
    }
    if (event.state === 'error') {
      return { sessionId: event.sessionId, title, body: 'Caiu', urgent: false };
    }
    return null;
  }

  /**
   * Um agente pede para perguntar a outro ou delegar: a sessão fica à espera como num pedido de
   * permissão, por isso avisa como ele (a frase é a que o motor escreve, sem o texto do agente).
   */
  #consult(
    event: Extract<EngineEvent, { type: 'consult.request' }>,
    focused: boolean,
  ): Attention | null {
    const session = this.#sessions.get(event.sessionId);
    if (!session || focused) return null;
    return {
      sessionId: event.sessionId,
      title: `${agentLabel(session.agent)} · ${session.project}`,
      body: `Precisa de ti: ${event.request.summary}`,
      urgent: true,
    };
  }

  #checks(
    event: Extract<EngineEvent, { type: 'session.checks' }>,
    focused: boolean,
  ): Attention | null {
    const session = this.#sessions.get(event.sessionId);
    const { checks } = event;
    if (!session || !checks.turnId || checks.turnId === session.checksWarned) return null;
    const failed = checks.results.filter((r) => r.state === 'failed' || r.state === 'timeout');
    if (failed.length === 0) return null;
    session.checksWarned = checks.turnId;
    if (this.#warnedRounds.has(checks.turnId)) return null;
    this.#warnedRounds.add(checks.turnId);
    if (focused) return null;
    const labels = failed.map((r) => checks.specs.find((s) => s.id === r.id)?.label ?? r.id);
    return {
      sessionId: event.sessionId,
      title: `${agentLabel(session.agent)} · ${session.project}`,
      body: `${labels.join(', ')} ${failed.length === 1 ? 'falhou' : 'falharam'}`,
      urgent: false,
    };
  }
}
