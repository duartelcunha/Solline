import type { Readable, Writable } from 'node:stream';

/** Erro que o outro lado devolveu a um pedido. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export type RequestId = string | number;
type RequestHandler = (params: unknown, id: RequestId) => unknown;
type NotificationHandler = (method: string, params: unknown) => void;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

const STDERR_LIMIT = 4_000;

export interface JsonRpcPeerOptions {
  /** O que vem do agente (stdout dele). */
  input: Readable;
  /** O que vai para o agente (stdin dele). */
  output: Writable;
  /** O Codex fala JSON-RPC sem o campo "jsonrpc"; o ACP manda "2.0". */
  jsonrpc: boolean;
  /** Linhas que não são JSON (banners, avisos): só para o registo. */
  onNoise?: (line: string) => void;
}

/**
 * JSON-RPC por linhas (NDJSON) sobre stdio, nos dois sentidos: pedidos e notificações
 * nossos, pedidos e notificações do agente. Um pedido do agente sem quem o trate recebe
 * logo -32601, para o agente nunca ficar à espera.
 */
export class JsonRpcPeer {
  readonly #output: Writable;
  readonly #jsonrpc: boolean;
  readonly #onNoise: ((line: string) => void) | undefined;
  readonly #pending = new Map<RequestId, Pending>();
  readonly #handlers = new Map<string, RequestHandler>();
  #onNotification: NotificationHandler = () => undefined;
  #nextId = 1;
  #buffer = '';
  #closedWith: Error | null = null;
  readonly #decoder = new TextDecoder('utf-8');
  readonly closed: Promise<Error>;
  #markClosed: (error: Error) => void = () => undefined;

  constructor(options: JsonRpcPeerOptions) {
    this.#output = options.output;
    this.#jsonrpc = options.jsonrpc;
    this.#onNoise = options.onNoise;
    this.closed = new Promise((resolve) => (this.#markClosed = resolve));
    options.input.on('data', (chunk: Buffer | string) => this.#onData(chunk));
    options.input.on('end', () => this.#close(new Error('O agente fechou a ligação')));
    options.input.on('error', (error: Error) => this.#close(error));
    options.output.on('error', (error: Error) => this.#close(error));
  }

  get isClosed(): boolean {
    return this.#closedWith !== null;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.#closedWith) return Promise.reject(this.#closedWith);
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.#pending.delete(id);
              reject(new Error(`${method}: sem resposta em ${timeoutMs / 1000} s`));
            }, timeoutMs);
      this.#pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.#send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#closedWith) return;
    this.#send({ method, ...(params === undefined ? {} : { params }) });
  }

  /** Trata um pedido do agente; o que devolver (ou a promessa) vai como resultado. */
  onRequest(method: string, handler: RequestHandler): void {
    this.#handlers.set(method, handler);
  }

  onNotification(handler: NotificationHandler): void {
    this.#onNotification = handler;
  }

  /** Fecha do nosso lado: rejeita tudo o que estava à espera. */
  close(reason = new Error('Ligação fechada')): void {
    this.#close(reason);
  }

  #send(message: Record<string, unknown>): void {
    const body = this.#jsonrpc ? { jsonrpc: '2.0', ...message } : message;
    this.#output.write(`${JSON.stringify(body)}\n`);
  }

  #onData(chunk: Buffer | string): void {
    this.#buffer +=
      typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true });
    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '').trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) this.#onLine(line);
      newline = this.#buffer.indexOf('\n');
    }
  }

  #onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      message = parsed as Record<string, unknown>;
    } catch {
      this.#onNoise?.(line);
      return;
    }
    const id = message.id as RequestId | undefined;
    const method = typeof message.method === 'string' ? message.method : undefined;
    if (method !== undefined && id !== undefined) {
      void this.#answer(id, method, message.params);
    } else if (method !== undefined) {
      try {
        this.#onNotification(method, message.params);
      } catch (error) {
        this.#onNoise?.(`notificação ${method} falhou: ${String(error)}`);
      }
    } else if (id !== undefined) {
      this.#settle(id, message);
    } else {
      this.#onNoise?.(line);
    }
  }

  async #answer(id: RequestId, method: string, params: unknown): Promise<void> {
    const handler = this.#handlers.get(method);
    if (!handler) {
      this.#send({ id, error: { code: -32601, message: `Método não suportado: ${method}` } });
      return;
    }
    try {
      const result = await handler(params, id);
      if (!this.#closedWith) this.#send({ id, result: result ?? null });
    } catch (error) {
      const rpc =
        error instanceof RpcError
          ? { code: error.code, message: error.message }
          : { code: -32000, message: error instanceof Error ? error.message : String(error) };
      if (!this.#closedWith) this.#send({ id, error: rpc });
    }
  }

  #settle(id: RequestId, message: Record<string, unknown>): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    const error = message.error as { code?: number; message?: string; data?: unknown } | undefined;
    if (error) {
      pending.reject(
        new RpcError(
          error.code ?? -32000,
          `${pending.method}: ${error.message ?? 'erro'}`,
          error.data,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  #close(reason: Error): void {
    if (this.#closedWith) return;
    this.#closedWith = reason;
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#pending.clear();
    this.#markClosed(reason);
  }
}

/** Guarda as últimas linhas do stderr do agente, para juntar à mensagem quando ele cai. */
export class StderrTail {
  #text = '';
  push(chunk: Buffer | string): void {
    this.#text = (this.#text + chunk.toString()).slice(-STDERR_LIMIT);
  }
  tail(max = 500): string {
    return this.#text.trim().slice(-max);
  }
}
