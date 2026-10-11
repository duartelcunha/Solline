import type {
  AgentKind,
  CommandPayload,
  CommandResult,
  EngineEvent,
  PermissionAnswer,
  SessionInfo,
} from '@solline/protocol';
import type {
  AgentAdapter,
  AgentAdapterFactory,
  AdapterSink,
  AgentStartOptions,
} from './adapters/types.ts';

interface Entry {
  info: SessionInfo;
  adapter: AgentAdapter;
  options: AgentStartOptions;
}

export interface SessionManagerOptions {
  emit: (event: EngineEvent) => void;
  adapters: Record<AgentKind, AgentAdapterFactory>;
  newId?: () => string;
  now?: () => number;
}

/**
 * Todas as conversas vivas do motor. Cada uma tem o seu adaptador; o que o adaptador
 * conta passa a eventos da Ponte com o id da sessão.
 */
export class SessionManager {
  readonly #sessions = new Map<string, Entry>();
  readonly #options: SessionManagerOptions;

  constructor(options: SessionManagerOptions) {
    this.#options = options;
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((entry) => ({ ...entry.info }));
  }

  get size(): number {
    return this.#sessions.size;
  }

  async create(
    payload: CommandPayload<'session.create'>,
  ): Promise<CommandResult<'session.create'>> {
    const id = (this.#options.newId ?? (() => crypto.randomUUID()))();
    const info: SessionInfo = {
      id,
      agent: payload.agent,
      cwd: payload.cwd,
      title: 'Nova sessão',
      createdAt: (this.#options.now ?? Date.now)(),
      state: 'starting',
      settings: {
        model: payload.model ?? null,
        effort: payload.effort ?? null,
        mode: payload.mode,
      },
      agentSessionId: null,
    };
    const options: AgentStartOptions = {
      cwd: payload.cwd,
      model: payload.model,
      effort: payload.effort,
      mode: payload.mode,
      resume: payload.resume,
    };
    return this.#start(info, options);
  }

  /** Abre de novo uma sessão que caiu, com resume no agente e as mesmas definições. */
  async resume(sessionId: string): Promise<CommandResult<'session.resume'>> {
    const entry = this.#get(sessionId);
    const resumeId = entry.adapter.agentSessionId();
    if (!resumeId) throw new Error('Esta sessão ainda não tem histórico no agente para retomar');
    await entry.adapter.close();
    const { model, effort, mode } = entry.info.settings;
    const options: AgentStartOptions = {
      cwd: entry.info.cwd,
      model: model ?? undefined,
      effort: effort ?? undefined,
      mode,
      resume: resumeId,
    };
    return this.#start(entry.info, options);
  }

  async send(sessionId: string, text: string): Promise<string> {
    const entry = this.#get(sessionId);
    if (entry.info.title === 'Nova sessão') entry.info.title = titleFrom(text);
    return entry.adapter.send(text);
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

  async close(sessionId: string): Promise<void> {
    const entry = this.#sessions.get(sessionId);
    if (!entry) return;
    this.#sessions.delete(sessionId);
    await entry.adapter.close();
  }

  async disposeAll(): Promise<void> {
    const entries = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(entries.map((entry) => entry.adapter.close()));
  }

  async #start(
    info: SessionInfo,
    options: AgentStartOptions,
  ): Promise<CommandResult<'session.create'>> {
    const factory = this.#options.adapters[info.agent];
    const adapter = factory(options, this.#sinkFor(info));
    const entry: Entry = { info, adapter, options };
    const isNew = !this.#sessions.has(info.id);
    this.#sessions.set(info.id, entry);
    try {
      const started = await adapter.start();
      info.settings = started.settings;
      info.agentSessionId = adapter.agentSessionId();
      info.state = 'idle';
      return { session: { ...info }, capabilities: started.capabilities };
    } catch (error) {
      // Uma sessão que nunca arrancou não fica na lista; uma retomada fica, em erro.
      if (isNew) this.#sessions.delete(info.id);
      throw error;
    }
  }

  #sinkFor(info: SessionInfo): AdapterSink {
    const emit = this.#options.emit;
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

export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || 'Nova sessão';
}
