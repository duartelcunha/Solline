import type {
  AgentKind,
  CommandPayload,
  CommandResult,
  EngineEvent,
  PermissionAnswer,
  SessionInfo,
} from '@solline/protocol';
import type { AgentAdapter, AgentAdapterFactory, AdapterSink } from './adapters/types.ts';

interface Entry {
  info: SessionInfo;
  adapter: AgentAdapter;
}

/**
 * Todas as conversas vivas do motor. Cada uma tem o seu adaptador; o que o adaptador
 * conta passa a eventos da Ponte com o id da sessão.
 * shortcut: as sessões só vivem em memória e desaparecem ao fechar a app; o M3 traz o
 * histórico (listSessions/getSessionMessages).
 */
export class SessionManager {
  readonly #sessions = new Map<string, Entry>();
  readonly #emit: (event: EngineEvent) => void;
  readonly #adapters: Record<AgentKind, AgentAdapterFactory>;

  constructor(options: {
    emit: (event: EngineEvent) => void;
    adapters: Record<AgentKind, AgentAdapterFactory>;
  }) {
    this.#emit = options.emit;
    this.#adapters = options.adapters;
  }

  create(payload: CommandPayload<'session.create'>): Promise<CommandResult<'session.create'>> {
    const info: SessionInfo = {
      id: crypto.randomUUID(),
      agent: payload.agent,
      cwd: payload.cwd,
      // O título vem da primeira mensagem, na interface.
      title: 'Nova sessão',
      state: 'starting',
      settings: {
        model: payload.model ?? null,
        effort: payload.effort ?? null,
        mode: payload.mode,
      },
      agentSessionId: null,
    };
    return this.#start(info);
  }

  /** Abre de novo uma sessão que caiu, com resume no agente e as mesmas definições. */
  async resume(sessionId: string): Promise<CommandResult<'session.resume'>> {
    const entry = this.#get(sessionId);
    const resumeId = entry.adapter.agentSessionId();
    if (!resumeId) throw new Error('Esta sessão ainda não tem histórico no agente para retomar');
    await entry.adapter.close();
    return this.#start(entry.info, resumeId);
  }

  send(sessionId: string, text: string): Promise<string> {
    return this.#get(sessionId).adapter.send(text);
  }

  interrupt(sessionId: string): Promise<void> {
    return this.#get(sessionId).adapter.interrupt();
  }

  setMode(sessionId: string, mode: string): Promise<void> {
    return this.#get(sessionId).adapter.setMode(mode);
  }

  setModel(sessionId: string, model: string): Promise<void> {
    return this.#get(sessionId).adapter.setModel(model);
  }

  async setEffort(sessionId: string, effort: string): Promise<void> {
    const { adapter } = this.#get(sessionId);
    if (!adapter.setEffort || !adapter.capabilities().effort) {
      throw new Error('Este agente não tem níveis de effort');
    }
    await adapter.setEffort(effort);
  }

  answer(sessionId: string, requestId: string, answer: PermissionAnswer): void {
    const answered = this.#get(sessionId).adapter.answerPermission(requestId, answer);
    if (!answered) throw new Error('Este pedido já não está à espera de resposta');
  }

  async disposeAll(): Promise<void> {
    const entries = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(entries.map((entry) => entry.adapter.close()));
  }

  async #start(info: SessionInfo, resume?: string): Promise<CommandResult<'session.create'>> {
    const { model, effort, mode } = info.settings;
    const adapter = this.#adapters[info.agent](
      { cwd: info.cwd, model: model ?? undefined, effort: effort ?? undefined, mode, resume },
      this.#sinkFor(info),
    );
    const isNew = !this.#sessions.has(info.id);
    this.#sessions.set(info.id, { info, adapter });
    try {
      const started = await adapter.start();
      info.settings = started.settings;
      info.state = 'idle';
      return { session: { ...info }, capabilities: started.capabilities };
    } catch (error) {
      // Uma sessão que nunca arrancou não fica; uma retomada fica, em erro, para tentar outra vez.
      if (isNew) this.#sessions.delete(info.id);
      throw error;
    }
  }

  #sinkFor(info: SessionInfo): AdapterSink {
    const emit = this.#emit;
    return {
      delta: (delta) => {
        if (delta.type === 'settings') info.settings = { ...info.settings, ...delta.settings };
        if (delta.type === 'meta') info.agentSessionId = delta.agentSessionId;
        emit({ kind: 'event', type: 'session.event', sessionId: info.id, delta });
      },
      state: (state, error) => {
        info.state = state;
        emit({
          kind: 'event',
          type: 'session.state',
          sessionId: info.id,
          state,
          ...(error ? { error } : {}),
        });
      },
      ask: (turnId, request) => {
        emit({ kind: 'event', type: 'permission.request', sessionId: info.id, turnId, request });
      },
    };
  }

  #get(sessionId: string): Entry {
    const entry = this.#sessions.get(sessionId);
    if (!entry) throw new Error('Sessão desconhecida (o motor pode ter reiniciado)');
    return entry;
  }
}
