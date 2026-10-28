import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrainResult } from './tool.ts';

/**
 * O canal local por onde o shim (o servidor MCP por stdio dos agentes Codex e ACP) fala com o
 * motor: um named pipe no Windows, um socket Unix numa pasta privada nos outros sistemas, com
 * um nome aleatório. Mensagens JSON, uma por linha:
 *
 *   shim -> motor: {"type":"hello","token":"…"}  e  {"type":"call","id":1,"name":"…","args":{…}}
 *   motor -> shim: {"type":"ready","tools":[…]}  {"type":"result","id":1,"text":"…","isError":false}
 *                  {"type":"error","message":"…"}  (fatal: o motor fecha a ligação a seguir)
 *
 * Quem é o chamador decide-o o token, que o motor deu a esta sessão e só a ela. Um token
 * desconhecido, fechado ou já revogado recebe sempre o mesmo "unauthorized".
 */

export const BRAIN_PIPE_ENV = 'SOLLINE_BRAIN_PIPE';
export const BRAIN_TOKEN_ENV = 'SOLLINE_BRAIN_TOKEN';

const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_HELLO_TIMEOUT_MS = 5_000;
const MAX_SOCKETS = 128;
const MAX_SOCKETS_PER_TOKEN = 8;
const MAX_PENDING_PER_SOCKET = 16;
const MAX_HELLO_BYTES = 1024;

/** O que o canal precisa de uma sessão ligada. */
export interface ChannelSession {
  /** As ferramentas já descritas em JSON Schema (o que o MCP tools/list devolve). */
  tools(): readonly ChannelTool[];
  call(name: string, args: unknown): Promise<BrainResult>;
}

export interface ChannelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface BrainChannelOptions {
  maxMessageBytes?: number;
  helloTimeoutMs?: number;
}

interface Issued {
  session: ChannelSession;
  sockets: Set<net.Socket>;
}

/** O token nunca se guarda em claro no mapa: só o seu resumo. */
function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class BrainChannel {
  readonly #maxBytes: number;
  readonly #helloTimeoutMs: number;
  readonly #tokens = new Map<string, Issued>();
  readonly #sockets = new Set<net.Socket>();
  #server: net.Server | undefined;
  #address: Promise<string> | undefined;
  #folder: string | undefined;
  #closed = false;

  constructor(options: BrainChannelOptions = {}) {
    this.#maxBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.#helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  }

  /** Começa a ouvir (uma vez) e devolve o endereço para o shim; nada se abre antes de ser preciso. */
  listen(): Promise<string> {
    if (this.#closed) return Promise.reject(new Error('O canal da Solline já está fechado'));
    this.#address ??= this.#open().catch((error: unknown) => {
      this.#address = undefined;
      throw error;
    });
    return this.#address;
  }

  async #open(): Promise<string> {
    const id = randomBytes(16).toString('hex');
    let address: string;
    if (process.platform === 'win32') {
      address = `\\\\.\\pipe\\solline-brain-${id}`;
    } else {
      // mkdtemp cria a pasta só para o dono (0700): nenhum outro utilizador chega ao socket.
      this.#folder = await mkdtemp(path.join(tmpdir(), 'solline-brain-'));
      address = path.join(this.#folder, `${id}.sock`);
    }
    const server = net.createServer((socket) => this.#accept(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (error) => console.error(`[brain] canal com erro: ${error.message}`));
    return address;
  }

  /** Dá um token novo a uma sessão. revoke() fecha as ligações dele e mata o token. */
  issue(session: ChannelSession): { token: string; revoke: () => void } {
    const token = randomBytes(32).toString('base64url');
    const key = digest(token);
    this.#tokens.set(key, { session, sockets: new Set() });
    return {
      token,
      revoke: () => {
        const issued = this.#tokens.get(key);
        if (!issued) return;
        this.#tokens.delete(key);
        for (const socket of issued.sockets) socket.destroy();
      },
    };
  }

  /** Quantos tokens vivos há (para os testes e para ver que nada fica para trás). */
  get activeTokens(): number {
    return this.#tokens.size;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#tokens.clear();
    for (const socket of this.#sockets) socket.destroy();
    const server = this.#server;
    this.#server = undefined;
    this.#address = undefined;
    if (server?.listening)
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    if (this.#folder)
      await rm(this.#folder, { recursive: true, force: true }).catch(() => undefined);
    this.#folder = undefined;
  }

  #accept(socket: net.Socket): void {
    if (this.#sockets.size >= MAX_SOCKETS) {
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    const conn: Connection = { socket, issued: null, key: null, pending: 0, dead: false };
    const hello = setTimeout(() => {
      if (!conn.issued) this.#fatal(conn, 'unauthorized');
    }, this.#helloTimeoutMs);
    socket.on('close', () => {
      clearTimeout(hello);
      conn.issued?.sockets.delete(socket);
    });
    let buffer = Buffer.alloc(0);
    // Antes do hello, quem liga ainda não provou nada: só cabe um hello (128 ligações x 1 MiB
    // por autenticar enchiam a memória do motor).
    const limit = () => (conn.issued ? this.#maxBytes : Math.min(this.#maxBytes, MAX_HELLO_BYTES));
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const end = buffer.indexOf(0x0a);
        if (end < 0) {
          if (buffer.length > limit()) this.#fatal(conn, 'message too large');
          return;
        }
        const line = buffer.subarray(0, end);
        buffer = buffer.subarray(end + 1);
        if (line.length > limit()) return this.#fatal(conn, 'message too large');
        if (line.length === 0) continue;
        this.#message(conn, line.toString('utf8'));
        if (conn.dead || socket.destroyed) return;
      }
    });
  }

  #message(conn: Connection, line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return this.#fatal(conn, 'bad message');
    }
    if (!isRecord(message) || typeof message.type !== 'string') {
      return this.#fatal(conn, 'bad message');
    }
    if (!conn.issued) {
      if (message.type !== 'hello' || typeof message.token !== 'string') {
        return this.#fatal(conn, 'unauthorized');
      }
      const key = digest(message.token);
      const issued = this.#tokens.get(key);
      if (!issued || issued.sockets.size >= MAX_SOCKETS_PER_TOKEN) {
        return this.#fatal(conn, 'unauthorized');
      }
      conn.issued = issued;
      conn.key = key;
      issued.sockets.add(conn.socket);
      this.#send(conn.socket, { type: 'ready', tools: issued.session.tools() });
      return;
    }
    if (message.type !== 'call') return this.#fatal(conn, 'bad message');
    const id = message.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || typeof message.name !== 'string') {
      return this.#fatal(conn, 'bad message');
    }
    // O token pode ter sido revogado entre a ligação e esta chamada.
    if (!conn.key || this.#tokens.get(conn.key) !== conn.issued) {
      return this.#fatal(conn, 'unauthorized');
    }
    if (conn.pending >= MAX_PENDING_PER_SOCKET) {
      this.#send(conn.socket, {
        type: 'result',
        id,
        text: 'Too many calls at once.',
        isError: true,
      });
      return;
    }
    conn.pending += 1;
    const issued = conn.issued;
    void issued.session
      .call(message.name, message.args)
      .catch((): BrainResult => ({ text: 'Erro interno da Solline.', isError: true }))
      .then((result) => {
        conn.pending -= 1;
        // Revogado enquanto corria: o resultado não sai (o socket já foi fechado).
        if (!conn.key || this.#tokens.get(conn.key) !== issued || conn.socket.destroyed) return;
        this.#send(conn.socket, { type: 'result', id, text: result.text, isError: result.isError });
      });
  }

  #send(socket: net.Socket, message: Record<string, unknown>): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
  }

  #fatal(conn: Connection, message: string): void {
    const socket = conn.socket;
    if (conn.dead || socket.destroyed) return;
    conn.dead = true;
    socket.end(`${JSON.stringify({ type: 'error', message })}\n`);
    // Se o outro lado não ler, não fica pendurado.
    setTimeout(() => socket.destroy(), 1_000).unref();
  }
}

interface Connection {
  socket: net.Socket;
  issued: Issued | null;
  key: string | null;
  pending: number;
  /** Já levou um erro fatal: nada do que ainda chegar conta. */
  dead: boolean;
}
