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
import { engineTimeout } from './engine-timeouts.ts';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Arranca o motor num utilityProcess e fala com ele por uma MessagePort.
 * Se o motor morrer, avisa a interface.
 */
export class EngineHost {
  get running(): boolean {
    return Boolean(this.#child);
  }
  get failedToStart(): boolean {
    return this.#initializationFailed;
  }
  #ready = false;
  #initializationFailed = false;
  #child: UtilityProcess | undefined;
  #port: Electron.MessagePortMain | undefined;
  #stopping = false;
  #recoveryKey: Buffer | undefined;
  readonly #pending = new Map<string, Pending>();
  readonly #onEvent: (event: EngineEvent) => void;

  constructor(onEvent: (event: EngineEvent) => void) {
    this.#onEvent = onEvent;
  }

  start(recoveryKey?: Buffer): void {
    if (this.#child) return;
    if (recoveryKey) this.#recoveryKey = Buffer.from(recoveryKey);
    if (!this.#recoveryKey) throw new Error('Chave de recuperação indisponível');
    this.#stopping = false;
    this.#ready = false;
    this.#initializationFailed = false;
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
    child.postMessage({ type: 'connect', recoveryKey: new Uint8Array(this.#recoveryKey) }, [port2]);
    child.on('exit', (code) => {
      if (this.#child !== child) return;
      this.#failAll(new Error(`O motor parou (código ${code})`));
      this.#child = undefined;
      this.#port = undefined;
      if (this.#stopping) return;
      this.#onEvent({
        kind: 'event',
        type: 'engine.error',
        message:
          'O motor parou. Restaura a interface para consultar o último estado guardado; os agentes só retomam por tua ação.',
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
    const timeout = engineTimeout(command);
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

  async restartFailed(key?: Buffer): Promise<void> {
    const child = this.#child;
    if (!child || !this.#initializationFailed) return;
    await this.#restart(child, key);
  }

  async restartStopped(key?: Buffer): Promise<void> {
    const child = this.#child;
    if (!child || (await this.request('engine.snapshot', {})).lifecycle !== 'stopped')
      throw new Error('O motor ainda não confirmou que terminou.');
    await this.#restart(child, key);
  }

  async #restart(child: UtilityProcess, key?: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('O motor anterior ainda não terminou.')),
        5000,
      );
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.stop();
    });
    this.start(key);
  }

  #onMessage(data: unknown): void {
    const event = EngineEvent.safeParse(data);
    if (event.success) {
      if (event.data.type === 'engine.ready') {
        this.#ready = true;
        console.info(`[engine] pronto v${event.data.engineVersion} pid ${event.data.pid}`);
      }
      if (event.data.type === 'engine.error' && !event.data.sessionId && !this.#ready)
        this.#initializationFailed = true;
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
