import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { MessageChannelMain, app, utilityProcess, type UtilityProcess } from 'electron';
import {
  EngineEvent,
  ResponseEnvelope,
  commandSchemas,
  type CommandName,
  type CommandResult,
  type RequestEnvelope,
} from '@solline/protocol';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const TIMEOUT_MS: Record<CommandName, number> = {
  'engine.ping': 5_000,
  'engine.sdkCheck': 150_000,
};

/** Arranca o motor num utilityProcess e fala com ele por uma MessagePort. */
export class EngineHost {
  #child: UtilityProcess | undefined;
  #port: Electron.MessagePortMain | undefined;
  readonly #pending = new Map<string, Pending>();

  start(): void {
    const child = utilityProcess.fork(join(__dirname, 'engine.js'), [], {
      serviceName: 'Solline Engine',
      stdio: 'inherit',
      env: { ...process.env, SOLLINE_PACKAGED: app.isPackaged ? '1' : '0' },
    });
    const { port1, port2 } = new MessageChannelMain();
    port1.on('message', (event) => this.#onMessage(event.data));
    port1.start();
    child.postMessage({ type: 'connect' }, [port2]);
    child.on('exit', (code) => {
      this.#failAll(new Error(`O motor parou (código ${code})`));
      this.#child = undefined;
      this.#port = undefined;
    });
    this.#child = child;
    this.#port = port1;
  }

  async request<C extends CommandName>(
    command: C,
    payload: unknown = {},
  ): Promise<CommandResult<C>> {
    const port = this.#port;
    if (!port) throw new Error('O motor não está a correr');
    const schema = commandSchemas[command];
    const input = schema.payload.parse(payload);
    const id = randomUUID();
    const envelope: RequestEnvelope = { kind: 'request', id, command, payload: input };
    const raw = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`O motor não respondeu a ${command} a tempo`));
      }, TIMEOUT_MS[command]);
      this.#pending.set(id, { resolve, reject, timer });
      port.postMessage(envelope);
    });
    return schema.result.parse(raw) as CommandResult<C>;
  }

  stop(): void {
    this.#failAll(new Error('O motor foi desligado'));
    this.#port?.close();
    this.#child?.kill();
  }

  #onMessage(data: unknown): void {
    const event = EngineEvent.safeParse(data);
    if (event.success) {
      console.info(
        `[engine] ${event.data.type} v${event.data.engineVersion} pid ${event.data.pid}`,
      );
      return;
    }
    const response = ResponseEnvelope.safeParse(data);
    if (!response.success) return;
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
