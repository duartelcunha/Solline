import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { CodexTransport } from '../src/index.ts';

export interface CodexRecord {
  dir: 'in' | 'out';
  msg: Record<string, unknown>;
}

export function loadCodexFixture(name: string): CodexRecord[] {
  const file = path.join(import.meta.dirname, 'fixtures', 'codex', `${name}.jsonl`);
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as CodexRecord);
}

/**
 * A mesma gravação, mas com a edição recusada: a resposta ao pedido passa a decline, a edição
 * fica "declined" e o diff do turno desaparece. Poupa uma corrida real (e quota do Codex).
 */
export function declinedVariant(records: CodexRecord[]): CodexRecord[] {
  return records
    .filter((r) => r.msg.method !== 'turn/diff/updated')
    .map((r) => {
      const msg = structuredClone(r.msg);
      if (r.dir === 'out' && msg.method === undefined && 'result' in msg) {
        msg.result = { decision: 'decline' };
      }
      const params = msg.params as { item?: { type?: string; status?: string } } | undefined;
      if (msg.method === 'item/completed' && params?.item?.type === 'fileChange') {
        params.item.status = 'declined';
      }
      return { dir: r.dir, msg };
    });
}

function lines(stream: PassThrough, onMessage: (msg: Record<string, unknown>) => void): void {
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let i = buffer.indexOf('\n');
    while (i !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      i = buffer.indexOf('\n');
      if (line) onMessage(JSON.parse(line) as Record<string, unknown>);
    }
  });
}

export interface FakeCodexOptions {
  account?: unknown;
  models?: unknown[];
  sandbox?: 'ready' | 'notConfigured';
  threadId?: string;
  /** Quantos turn/start falham antes de os aceitar. */
  failTurnStarts?: number;
  /** Segura a resposta ao turn/start até esta promessa resolver. */
  holdTurnStart?: Promise<void>;
  /** Resposta ao account/login/start (por omissão, um login do ChatGPT). */
  login?: unknown;
  /** Os servidores MCP que o config/read devolve (por omissão, nenhum). */
  mcpServers?: string[];
  /** O que o mcpServerStatus/list devolve; por omissão, desligados os que o thread/start desligou. */
  mcpStatus?: { name: string; runtimeStatus: string | null }[];
  /** O config/read falha. */
  failConfigRead?: boolean;
}

const DEFAULT_MODELS = [
  {
    id: 'gpt-6-luna',
    model: 'gpt-6-luna',
    displayName: 'GPT-6-Luna',
    description: 'Fast and affordable model for easier tasks.',
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: '' },
      { reasoningEffort: 'medium', description: '' },
      { reasoningEffort: 'high', description: '' },
    ],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.6-terra',
    model: 'gpt-5.6-terra',
    displayName: 'GPT-5.6-Terra',
    description: 'Deep work.',
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: '' },
      { reasoningEffort: 'ultra', description: '' },
    ],
    defaultReasoningEffort: 'low',
  },
  {
    id: 'escondido',
    model: 'escondido',
    displayName: 'Escondido',
    description: '',
    hidden: true,
    isDefault: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: 'low',
  },
];

/**
 * Um app-server falso e programável: responde ao arranque sozinho, guarda o que o adaptador
 * manda e deixa o teste mandar notificações e pedidos.
 */
export function fakeCodexServer(options: FakeCodexOptions = {}) {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const received: Record<string, unknown>[] = [];
  const waiters: ((msg: Record<string, unknown>) => boolean)[] = [];
  const answers = new Map<unknown, (msg: Record<string, unknown>) => void>();
  let exit: (value: unknown) => void = () => undefined;
  const exited = new Promise((resolve) => (exit = resolve));
  let killed = false;
  const threadId = options.threadId ?? 'thread-1';
  let turn = 0;
  let failed = 0;
  let serverId = 100;
  let threadConfig: Record<string, unknown> = {};

  const send = (msg: unknown) => fromServer.write(`${JSON.stringify(msg)}\n`);
  const reply = (id: unknown, result: unknown) => send({ id, result });

  // Como o app-server: quando o stdin fecha, o processo sai.
  toServer.on('finish', () => exit(0));
  lines(toServer, (msg) => {
    received.push(msg);
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i]!(msg)) waiters.splice(i--, 1);
    }
    const id = msg.id;
    if (typeof msg.method !== 'string') {
      answers.get(id)?.(msg);
      return;
    }
    const params = (msg.params ?? {}) as { threadId?: string; model?: string };
    if (msg.method === 'thread/start') {
      threadConfig = ((msg.params as { config?: Record<string, unknown> }).config ?? {}) as Record<
        string,
        unknown
      >;
    }
    const results: Record<string, () => unknown> = {
      initialize: () => ({
        userAgent: 'fake',
        codexHome: 'C:/codex',
        platformFamily: 'windows',
        platformOs: 'windows',
      }),
      'account/read': () =>
        options.account ?? {
          account: { type: 'chatgpt', email: null, planType: 'free' },
          requiresOpenaiAuth: true,
        },
      'model/list': () => ({ data: options.models ?? DEFAULT_MODELS, nextCursor: null }),
      'windowsSandbox/readiness': () => ({ status: options.sandbox ?? 'ready' }),
      'config/read': () => {
        if (options.failConfigRead) throw new Error('config ilegível');
        return {
          config: {
            mcp_servers: Object.fromEntries(
              (options.mcpServers ?? []).map((name) => [name, { command: 'x', enabled: true }]),
            ),
          },
          origins: {},
          layers: null,
        };
      },
      'mcpServerStatus/list': () => {
        const off = (threadConfig.mcp_servers ?? {}) as Record<string, { enabled?: boolean }>;
        const data = (
          options.mcpStatus ??
          (options.mcpServers ?? []).map((name) => ({
            name,
            runtimeStatus: off[name]?.enabled === false ? 'disabled' : 'connected',
          }))
        ).map((s) => ({ ...s, pluginId: null, httpOrigin: null, authStatus: 'unsupported' }));
        return { data, nextCursor: null };
      },
      'thread/start': () => ({
        thread: { id: threadId, turns: [] },
        model: params.model ?? 'gpt-6-luna',
        reasoningEffort: 'medium',
      }),
      'thread/resume': () => ({
        thread: { id: params.threadId ?? threadId, turns: [] },
        model: params.model ?? 'gpt-6-luna',
        reasoningEffort: 'medium',
      }),
      'thread/fork': () => ({
        thread: { id: `${params.threadId ?? threadId}-fork`, turns: [] },
        model: params.model ?? 'gpt-6-luna',
        reasoningEffort: 'medium',
      }),
      'turn/start': () => ({
        turn: { id: `turn-${++turn}`, items: [], status: 'inProgress', error: null },
      }),
      'turn/interrupt': () => ({}),
      // Como o app-server: o turno guiado tem de ser o ativo.
      'turn/steer': () => {
        const expected = (msg.params as { expectedTurnId?: string }).expectedTurnId;
        if (expected !== `turn-${turn}`) throw new Error('turno errado');
        return { turnId: expected };
      },
      'account/login/start': () =>
        options.login ?? {
          type: 'chatgpt',
          loginId: 'login-1',
          authUrl: 'https://auth.openai.com/oauth/authorize?client_id=x&state=y',
        },
      'account/login/cancel': () => ({ status: 'canceled' }),
    };
    if (id === undefined) return;
    if (msg.method === 'turn/start' && options.holdTurnStart) {
      const answer = results['turn/start']!;
      void options.holdTurnStart.then(() => reply(id, answer()));
      return;
    }
    if (msg.method === 'turn/start' && (options.failTurnStarts ?? 0) > failed) {
      failed++;
      send({ id, error: { code: -32000, message: 'ocupado' } });
      return;
    }
    const result = results[msg.method];
    if (!result) {
      send({ id, error: { code: -32601, message: 'fake' } });
      return;
    }
    try {
      reply(id, result());
    } catch (error) {
      send({ id, error: { code: -32000, message: String(error) } });
    }
  });

  const transport: CodexTransport = {
    input: fromServer,
    output: toServer,
    exited,
    kill: async () => {
      killed = true;
      exit(0);
    },
  };

  return {
    transport: () => transport,
    received,
    get killed() {
      return killed;
    },
    turnId: () => `turn-${turn}`,
    threadId,
    notify: (method: string, params: unknown) => send({ method, params }),
    /** Pedido do servidor ao adaptador; devolve a resposta que o adaptador mandar. */
    request(method: string, params: unknown): Promise<Record<string, unknown>> {
      const id = serverId++;
      return new Promise((resolve) => {
        answers.set(id, resolve);
        send({ id, method, params });
      });
    },
    waitFor(match: (msg: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
      const seen = received.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve) =>
        waiters.push((msg) => (match(msg) ? (resolve(msg), true) : false)),
      );
    },
    /** O processo morre. */
    crash: () => fromServer.end(),
  };
}

/**
 * Reproduz uma gravação real: espera pelo que o adaptador manda (pela ordem gravada) e devolve
 * o que o Codex respondeu, trocando os ids dos pedidos pelos do adaptador.
 */
export function replayCodex(records: CodexRecord[]) {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const received: Record<string, unknown>[] = [];
  const ids = new Map<unknown, unknown>();
  let exit: (value: unknown) => void = () => undefined;
  const exited = new Promise((resolve) => (exit = resolve));
  let cursor = 0;
  let pending: Record<string, unknown>[] = [];

  function advance(): void {
    while (cursor < records.length) {
      const record = records[cursor]!;
      if (record.dir === 'out') {
        const want = record.msg;
        const index = pending.findIndex((msg) =>
          typeof want.method === 'string'
            ? msg.method === want.method
            : msg.method === undefined && msg.id === want.id,
        );
        if (index === -1) return;
        const [got] = pending.splice(index, 1);
        if (want.id !== undefined && typeof want.method === 'string') ids.set(want.id, got!.id);
        cursor++;
        continue;
      }
      const msg = { ...record.msg };
      if (msg.method === undefined && msg.id !== undefined) msg.id = ids.get(msg.id) ?? msg.id;
      fromServer.write(`${JSON.stringify(msg)}\n`);
      cursor++;
    }
  }

  lines(toServer, (msg) => {
    received.push(msg);
    pending.push(msg);
    advance();
  });
  toServer.on('finish', () => exit(0));

  const transport: CodexTransport = {
    input: fromServer,
    output: toServer,
    exited,
    kill: async () => exit(0),
  };
  return {
    transport: () => transport,
    received,
    done: () => cursor >= records.length,
    reset: () => {
      pending = [];
    },
  };
}
