import {
  RequestEnvelope,
  engineCommandSchemas,
  type AgentKind,
  type EngineCommandName,
  type EngineCommandPayload,
  type EngineCommandResult,
  type EngineEvent,
  type ResponseEnvelope,
} from '@solline/protocol';
import { CLAUDE_MODES, ClaudeSdkAdapter } from './adapters/claude/sdk.ts';
import type { AgentAdapterFactory } from './adapters/types.ts';
import { SessionManager } from './session-manager.ts';
import { ENGINE_VERSION } from './version.ts';

export interface EngineOptions {
  claudeExecutable?: string | undefined;
  /** Para onde vão os eventos (no utilityProcess, a MessagePort). */
  emit?: (event: EngineEvent) => void;
  /** Sem definições do utilizador nem do projeto (testes e smoke). */
  isolated?: boolean;
  /** Para testes: troca os adaptadores reais. */
  adapters?: Partial<Record<AgentKind, AgentAdapterFactory>>;
}

type Handlers = {
  [C in EngineCommandName]: (payload: EngineCommandPayload<C>) => Promise<EngineCommandResult<C>>;
};

/** O motor recebe envelopes de pedido e devolve envelopes de resposta. Não sabe do Electron. */
export class Engine {
  readonly sessions: SessionManager;
  readonly #handlers: Handlers;

  constructor(options: EngineOptions = {}) {
    const claude: AgentAdapterFactory = (start, sink) =>
      new ClaudeSdkAdapter(
        { ...start, claudeExecutable: options.claudeExecutable, loadSettings: !options.isolated },
        sink,
      );
    this.sessions = new SessionManager({
      emit: options.emit ?? (() => undefined),
      adapters: { claude, ...options.adapters },
      staticModes: { claude: CLAUDE_MODES },
      defaultModes: { claude: 'default' },
    });
    const s = this.sessions;
    const ok = {} as Record<string, never>;
    this.#handlers = {
      'engine.ping': async () => ({
        pong: true,
        engineVersion: ENGINE_VERSION,
        pid: process.pid,
        receivedAt: Date.now(),
      }),
      'session.start': (p) => s.create(p),
      'session.resume': (p) => s.resume(p.sessionId),
      'session.send': async (p) => ({ turnId: await s.send(p.sessionId, p.text) }),
      'session.interrupt': async (p) => (await s.interrupt(p.sessionId), ok),
      'session.setMode': async (p) => (await s.setMode(p.sessionId, p.mode), ok),
      'session.setModel': async (p) => (await s.setModel(p.sessionId, p.model), ok),
      'session.setEffort': async (p) => (await s.setEffort(p.sessionId, p.effort), ok),
      'permission.answer': async (p) => (s.answer(p.sessionId, p.requestId, p.answer), ok),
    };
  }

  async handle(raw: unknown): Promise<ResponseEnvelope> {
    // Só passam comandos do motor: os do main e os desconhecidos ficam aqui.
    const parsed = RequestEnvelope.safeParse(raw);
    if (!parsed.success) {
      const id =
        typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string'
          ? raw.id
          : '';
      return { kind: 'response', id, ok: false, error: { message: 'Pedido inválido' } };
    }
    const { id, payload, command } = parsed.data;
    try {
      const schema = engineCommandSchemas[command];
      const input = schema.payload.parse(payload ?? {});
      const handler = this.#handlers[command] as (payload: unknown) => Promise<unknown>;
      const result = schema.result.parse(await handler(input));
      return { kind: 'response', id, ok: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { kind: 'response', id, ok: false, error: { message } };
    }
  }

  async dispose(): Promise<void> {
    await this.sessions.disposeAll();
  }
}
