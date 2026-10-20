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
    if (result) reply(id, result());
    else send({ id, error: { code: -32601, message: 'fake' } });
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
