import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { MessageChannelMain, app, utilityProcess, type UtilityProcess } from 'electron';
import {
  EngineEvent,
  ResponseEnvelope,
  engineCommandSchemas,
  type EngineCommandName,
  type EngineCommandResult,
  type RequestEnvelope,
} from '@solline/protocol';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const TIMEOUT_MS: Partial<Record<EngineCommandName, number>> = {
  'engine.ping': 5_000,
  // O Codex arranca um app-server para dizer se tem sessão iniciada ou para começar o login.
  'agents.list': 45_000,
  // Acima do pior caso do motor (initialize + account/login/start, 30 s cada).
  'agents.loginStart': 75_000,
  'session.start': 120_000,
  'session.resume': 120_000,
};

/**
 * Arranca o motor num utilityProcess e fala com ele por uma MessagePort.
 * Se o motor morrer, avisa a interface.
 */
export class EngineHost {
  #child: UtilityProcess | undefined;
  #port: Electron.MessagePortMain | undefined;
  #stopping = false;
  readonly #pending = new Map<string, Pending>();
  readonly #onEvent: (event: EngineEvent) => void;

  constructor(onEvent: (event: EngineEvent) => void) {
    this.#onEvent = onEvent;
  }

  start(): void {
    const child = utilityProcess.fork(join(__dirname, 'engine.js'), [], {
      serviceName: 'Solline Engine',
      stdio: 'inherit',
      env: {
        ...process.env,
        SOLLINE_PACKAGED: app.isPackaged ? '1' : '0',
        SOLLINE_DATA_DIR: app.getPath('userData'),
      },
    });
    const { port1, port2 } = new MessageChannelMain();
    port1.on('message', (event) => this.#onMessage(event.data));
    port1.start();
    child.postMessage({ type: 'connect' }, [port2]);
    child.on('exit', (code) => {
      this.#failAll(new Error(`O motor parou (código ${code})`));
      this.#child = undefined;
      this.#port = undefined;
      if (this.#stopping) return;
      // shortcut: sem reiniciar o motor nem recuperar sessões; o M5 trata da recuperação.
      this.#onEvent({
        kind: 'event',
        type: 'engine.error',
        message: 'O motor parou. Fecha e volta a abrir a Solline.',
      });
    });
    this.#child = child;
    this.#port = port1;
  }

  async request<C extends EngineCommandName>(
    command: C,
    payload: unknown = {},
  ): Promise<EngineCommandResult<C>> {
    const port = this.#port;
    if (!port) throw new Error('O motor não está a correr');
    const schema = engineCommandSchemas[command];
    const input = schema.payload.parse(payload);
    const id = randomUUID();
    const envelope: RequestEnvelope = { kind: 'request', id, command, payload: input };
    const timeout = TIMEOUT_MS[command] ?? DEFAULT_TIMEOUT_MS;
    const raw = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`O motor não respondeu a ${command} a tempo`));
      }, timeout);
      this.#pending.set(id, { resolve, reject, timer });
      port.postMessage(envelope);
    });
    return schema.result.parse(raw) as EngineCommandResult<C>;
  }

  stop(): void {
    this.#stopping = true;
    this.#failAll(new Error('O motor foi desligado'));
    this.#port?.close();
    this.#child?.kill();
  }

  #onMessage(data: unknown): void {
    const event = EngineEvent.safeParse(data);
    if (event.success) {
      if (event.data.type === 'engine.ready') {
        console.info(`[engine] pronto v${event.data.engineVersion} pid ${event.data.pid}`);
      }
      this.#onEvent(event.data);
      return;
    }
    const response = ResponseEnvelope.safeParse(data);
    if (!response.success) {
      console.warn('[engine] mensagem inválida ignorada');
      return;
    }
    const pending = this.#pending.get(response.data.id);
    if (!pending) return;
    this.#pending.delete(response.data.id);
    clearTimeout(pending.timer);
    if (response.data.ok) pending.resolve(response.data.result);
    else pending.reject(new Error(response.data.error.message));
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
