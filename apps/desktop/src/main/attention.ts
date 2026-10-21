import type { EngineEvent, SessionInfo, SessionState } from '@solline/protocol';

/**
 * Quando avisar fora da app: uma sessão que passa a precisar de ti ou acaba um turno, e só
 * com a janela sem foco (com foco, o bot já o mostra). Função pura; o main mostra o aviso
 * do Windows e faz piscar a barra de tarefas.
 */

export interface Tracked {
  agent: string;
  project: string;
  state: SessionState;
}

export interface Attention {
  sessionId: string;
  title: string;
  body: string;
  /** Precisa de ti: além do aviso, a barra de tarefas pisca até voltares. */
  urgent: boolean;
}

const LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

export function agentLabel(agent: string): string {
  return LABELS[agent] ?? agent.charAt(0).toUpperCase() + agent.slice(1);
}

export class AttentionTracker {
  readonly #sessions = new Map<string, Tracked>();

  /** Uma sessão nova (ou retomada), com o nome do projeto para o título do aviso. */
  track(session: Pick<SessionInfo, 'id' | 'agent' | 'state'>, project: string): void {
    this.#sessions.set(session.id, { agent: session.agent, project, state: session.state });
  }

  /** O aviso que este evento merece, ou null. Atualiza sempre o estado guardado. */
  observe(event: EngineEvent, focused: boolean): Attention | null {
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
    if (previous === 'running' && event.state === 'idle') {
      return { sessionId: event.sessionId, title, body: 'Turno acabado', urgent: false };
    }
    return null;
  }
}
