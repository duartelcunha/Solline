import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  findModel,
  type AgentKind,
  type EngineCommandResult,
  type EngineEvent,
  type ModeOption,
  type PermissionAnswer,
  type SessionInfo,
  type SessionStartPayload,
} from '@solline/protocol';
import type { AgentAdapter, AgentAdapterFactory, AdapterSink } from './adapters/types.ts';

type SessionResult = EngineCommandResult<'session.start'>;

/** A pasta tem de ser absoluta e existir; o main já a tirou de um projeto conhecido. */
async function defaultCheckCwd(cwd: string): Promise<void> {
  if (!isAbsolute(cwd)) throw new Error('A pasta da sessão tem de ser um caminho absoluto');
  const isDir = await stat(cwd).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!isDir) throw new Error('A pasta do projeto já não existe');
}

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
  readonly #staticModes: Partial<Record<AgentKind, readonly ModeOption[]>>;
  readonly #defaultModes: Partial<Record<AgentKind, string>>;
  readonly #checkCwd: (cwd: string) => Promise<void>;

  constructor(options: {
    emit: (event: EngineEvent) => void;
    adapters: Record<AgentKind, AgentAdapterFactory>;
    /** Modos que cada agente aceita antes de arrancar (o pedido de criação é validado aqui). */
    staticModes?: Partial<Record<AgentKind, readonly ModeOption[]>>;
    /** Modo com que cada agente arranca quando o pedido não traz nenhum. */
    defaultModes?: Partial<Record<AgentKind, string>>;
    /** Para testes: troca a verificação da pasta. */
    checkCwd?: (cwd: string) => Promise<void>;
  }) {
    this.#emit = options.emit;
    this.#adapters = options.adapters;
    this.#staticModes = options.staticModes ?? {};
    this.#defaultModes = options.defaultModes ?? {};
    this.#checkCwd = options.checkCwd ?? defaultCheckCwd;
  }

  async create(payload: SessionStartPayload): Promise<SessionResult> {
    await this.#checkCwd(payload.cwd);
    const known = this.#staticModes[payload.agent];
    if (payload.mode && known && !known.some((m) => m.id === payload.mode)) {
      throw new Error(`Modo desconhecido para este agente: ${payload.mode}`);
    }
    const info: SessionInfo = {
      id: crypto.randomUUID(),
      projectId: payload.projectId,
      agent: payload.agent,
      cwd: payload.cwd,
      // O título vem da primeira mensagem, na interface.
      title: 'Nova sessão',
      state: 'starting',
      settings: {
        model: payload.model ?? null,
        effort: payload.effort ?? null,
        mode: payload.mode ?? this.#defaultModes[payload.agent] ?? 'default',
      },
      agentSessionId: null,
    };
    return this.#start(info);
  }

  /** Abre de novo uma sessão que caiu, com resume no agente e as mesmas definições. */
  async resume(sessionId: string): Promise<SessionResult> {
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

  /** Modo, modelo e effort só passam se o agente os anunciou nas capacidades. */
  async setMode(sessionId: string, mode: string): Promise<void> {
    const { adapter } = this.#get(sessionId);
    if (!adapter.capabilities().modes.some((m) => m.id === mode)) {
      throw new Error(`Modo desconhecido para este agente: ${mode}`);
    }
    await adapter.setMode(mode);
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const { adapter } = this.#get(sessionId);
    if (!findModel(adapter.capabilities().models, model)) {
      throw new Error(`Modelo desconhecido para este agente: ${model}`);
    }
    await adapter.setModel(model);
  }

  async setEffort(sessionId: string, effort: string): Promise<void> {
    const { adapter, info } = this.#get(sessionId);
    const capabilities = adapter.capabilities();
    if (!adapter.setEffort || !capabilities.effort) {
      throw new Error('Este agente não tem níveis de effort');
    }
    const model = findModel(capabilities.models, info.settings.model);
    const allowed = model ? model.efforts : capabilities.models.flatMap((m) => m.efforts);
    if (!allowed.includes(effort)) {
      throw new Error(`Este modelo não tem o effort ${effort}`);
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

  async #start(info: SessionInfo, resume?: string): Promise<SessionResult> {
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
      // Um modo que o agente aceitou no arranque mas não anuncia (por exemplo Auto num modelo
      // sem suporte) volta ao modo por omissão: a interface nunca mostra um modo que não há.
      const fallback = this.#defaultModes[info.agent];
      const modes = started.capabilities.modes;
      if (
        fallback &&
        fallback !== info.settings.mode &&
        !modes.some((m) => m.id === info.settings.mode) &&
        modes.some((m) => m.id === fallback)
      ) {
        await adapter.setMode(fallback);
        info.settings = { ...info.settings, mode: fallback };
      }
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
