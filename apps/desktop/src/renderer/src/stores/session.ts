import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ReviewDraft } from '@solline/protocol/bridge';
import {
  applyDelta,
  type AgentCapabilities,
  type Checks,
  type ConsultRequest,
  type SessionQueue,
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
  composerText: string;
  pendingSend: string | null;
  reviewDraft: ReviewDraft;
  interrupted: boolean;
  /** A segunda opinião: se está ligada e o que o revisor achou do último turno. */
  quality: Quality | null;
  /** As verificações do projeto (tipos, lint, testes) depois do último turno que mudou ficheiros. */
  checks: Checks | null;
  /** O último "Trazer" deu conflitos nestes ficheiros (para pedir ao agente que os resolva). */
  conflicts: { files: string[]; into: string } | null;
  /**
   * Os pedidos de perguntar a outro agente ou delegar que esta sessão fez e esperam por ti (o mais
   * antigo primeiro). Caem com o motor: depois de reiniciar já não há agente à espera.
   */
  consults: ConsultRequest[];
  /** O que escreveste enquanto o agente trabalhava, à espera de seguir. */
  queue: SessionQueue | null;
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
    composerText: '',
    pendingSend: null,
    reviewDraft: { scope: { kind: 'review' }, comments: [], note: '', editing: null },
    interrupted: false,
    quality: null,
    checks: null,
    conflicts: null,
    consults: [],
    queue: null,
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
          // Uma sessão de passagem já vem com o nome do objetivo, e uma bifurcação com o da origem:
          // a primeira mensagem não lho muda.
          const first =
            delta.turn.role === 'user' &&
            data.turns.length === 0 &&
            data.info.origin?.kind !== 'handoff' &&
            data.info.origin?.kind !== 'fork' &&
            data.info.origin?.kind !== 'ask' &&
            data.info.origin?.kind !== 'delegate';
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
    case 'consult.request':
      return {
        ...data,
        consults: [...data.consults.filter((c) => c.id !== event.request.id), event.request],
      };
    case 'consult.settled':
      return { ...data, consults: data.consults.filter((c) => c.id !== event.requestId) };
    case 'session.timeline':
      return { ...data, timeline: event.timeline };
    case 'session.quality':
      return { ...data, quality: event.quality };
    case 'session.checks':
      return { ...data, checks: event.checks };
    case 'session.setup':
      return { ...data, info: { ...data.info, setup: event.setup } };
    case 'session.queue':
      return { ...data, queue: event.queue };
    case 'session.workspace':
      return { ...data, info: { ...data.info, workspace: event.workspace } };
    case 'session.handoff': {
      const { handedTo: _previous, ...info } = data.info;
      return { ...data, info: event.handedTo ? { ...info, handedTo: event.handedTo } : info };
    }
    case 'session.state': {
      if (event.state === data.info.state) return data;
      const now = Date.now();
      return {
        ...data,
        info: { ...data.info, state: event.state },
        interrupted: event.state === 'error' ? data.interrupted : false,
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
