import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  applyDelta,
  type AgentCapabilities,
  type Checks,
  type EngineEvent,
  type Quality,
  type SessionInfo,
  type Timeline,
  type Turn,
  type Usage,
} from '@solline/protocol';

/** Tudo o que a interface sabe de uma sessão. Só muda por eventos do motor. */
export interface SessionData {
  info: SessionInfo;
  projectId: string;
  capabilities: AgentCapabilities | null;
  turns: Turn[];
  usage: Usage;
  /** Mensagem calma quando a sessão caiu. */
  error: string | null;
  /** O último comando que falhou (mudar modelo, enviar...). */
  actionError: string | null;
  /** Checkpoints, o que está por rever e o que "Desfazer" desfaz. Chega do motor. */
  timeline: Timeline | null;
  /** Texto que volta à caixa de mensagem (depois de rebobinar a conversa). */
  draft: string | null;
  /** A segunda opinião: se está ligada e o que o revisor achou do último turno. */
  quality: Quality | null;
  /** As verificações do projeto (tipos, lint, testes) depois do último turno que mudou ficheiros. */
  checks: Checks | null;
  /** O último "Trazer" deu conflitos nestes ficheiros (para pedir ao agente que os resolva). */
  conflicts: { files: string[]; into: string } | null;
  /** Desde quando a sessão está no estado atual (ms). */
  stateSince: number;
  /** Quando acabou o último turno (ms), ou null se ainda não acabou nenhum. */
  turnEndedAt: number | null;
}

export type SessionStore = StoreApi<SessionData>;

export const EMPTY_USAGE: Usage = { costUsd: null, models: [], context: null, tokens: null };

export function createSessionStore(
  info: SessionInfo,
  projectId: string,
  capabilities: AgentCapabilities | null,
): SessionStore {
  return createStore<SessionData>(() => ({
    info,
    projectId,
    capabilities,
    turns: [],
    usage: EMPTY_USAGE,
    error: null,
    actionError: null,
    timeline: null,
    draft: null,
    quality: null,
    checks: null,
    conflicts: null,
    stateSince: Date.now(),
    turnEndedAt: null,
  }));
}

/** Aplica um evento do motor ao estado de uma sessão (função pura). */
export function reduceSession(data: SessionData, event: EngineEvent): SessionData {
  switch (event.type) {
    case 'session.event': {
      const { delta } = event;
      switch (delta.type) {
        case 'usage':
          return { ...data, usage: { ...data.usage, ...delta.usage } };
        case 'settings':
          return {
            ...data,
            info: { ...data.info, settings: { ...data.info.settings, ...delta.settings } },
          };
        case 'meta':
          return { ...data, info: { ...data.info, agentSessionId: delta.agentSessionId } };
        case 'capabilities':
          return { ...data, capabilities: delta.capabilities };
        case 'turn.start': {
          const turns = applyDelta(data.turns, delta);
          const first = delta.turn.role === 'user' && data.turns.length === 0;
          const text = delta.turn.blocks.find((b) => b.kind === 'text');
          const title = first && text?.kind === 'text' ? titleFrom(text.text) : data.info.title;
          return { ...data, turns, info: { ...data.info, title } };
        }
        default:
          return { ...data, turns: applyDelta(data.turns, delta) };
      }
    }
    case 'permission.request':
      return {
        ...data,
        turns: applyDelta(data.turns, {
          type: 'block.upsert',
          turnId: event.turnId,
          block: event.request,
        }),
      };
    case 'session.timeline':
      return { ...data, timeline: event.timeline };
    case 'session.quality':
      return { ...data, quality: event.quality };
    case 'session.checks':
      return { ...data, checks: event.checks };
    case 'session.workspace':
      return { ...data, info: { ...data.info, workspace: event.workspace } };
    case 'session.state': {
      if (event.state === data.info.state) return data;
      const now = Date.now();
      return {
        ...data,
        info: { ...data.info, state: event.state },
        stateSince: now,
        turnEndedAt:
          (data.info.state === 'running' || data.info.state === 'needs-you') &&
          event.state === 'idle'
            ? now
            : data.turnEndedAt,
        error: event.state === 'error' ? (event.error ?? 'A sessão parou.') : null,
      };
    }
    default:
      return data;
  }
}

function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || 'Nova sessão';
}
