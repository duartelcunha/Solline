import {
  RequestEnvelope,
  commandSchemas,
  type CommandName,
  type CommandResult,
  type ResponseEnvelope,
} from '@solline/protocol';
import { runSdkCheck } from './sdk-check.ts';
import { SessionManager } from './session-manager.ts';
import { ENGINE_VERSION } from './version.ts';

export interface EngineOptions {
  claudeExecutable?: string | undefined;
  /** Para testes: troca a verificação real do SDK. */
  sdkCheck?: typeof runSdkCheck;
}

type Handlers = { [C in CommandName]: () => Promise<CommandResult<C>> };

/** O motor recebe envelopes de pedido e devolve envelopes de resposta. Não sabe do Electron. */
export class Engine {
  readonly sessions = new SessionManager();
  readonly #handlers: Handlers;

  constructor(options: EngineOptions = {}) {
    const sdkCheck = options.sdkCheck ?? runSdkCheck;
    this.#handlers = {
      'engine.ping': async () => ({
        pong: true,
        engineVersion: ENGINE_VERSION,
        pid: process.pid,
        receivedAt: Date.now(),
      }),
      'engine.sdkCheck': () => sdkCheck({ claudeExecutable: options.claudeExecutable }),
    };
  }

  async handle(raw: unknown): Promise<ResponseEnvelope> {
    const parsed = RequestEnvelope.safeParse(raw);
    if (!parsed.success) {
      const id =
        typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string'
          ? raw.id
          : '';
      return { kind: 'response', id, ok: false, error: { message: 'Pedido inválido' } };
    }
    const { id, command, payload } = parsed.data;
    try {
      const schema = commandSchemas[command];
      schema.payload.parse(payload ?? {});
      const result = schema.result.parse(await this.#handlers[command]());
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
