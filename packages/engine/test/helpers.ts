import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ModelInfo,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import {
  applyDelta,
  type AskBlock,
  type ConversationDelta,
  type SessionState,
  type Turn,
} from '@solline/protocol';
import {
  builtinRegistry,
  withFactories,
  type AdapterSink,
  type AgentAdapterFactory,
  type AgentRegistry,
} from '../src/index.ts';

/** O registo de verdade (isolado) com o adaptador de alguns agentes trocado. */
export function testRegistry(factories: Record<string, AgentAdapterFactory>): AgentRegistry {
  return withFactories(builtinRegistry({ isolated: true }), factories);
}

export type FixtureRecord =
  | { kind: 'message'; message: SDKMessage }
  | {
      kind: 'canUseTool';
      toolName: string;
      input: Record<string, unknown>;
      options: Record<string, unknown> & { toolUseID: string; requestId: string };
    };

export function loadFixture(name: string): FixtureRecord[] {
  const file = path.join(import.meta.dirname, 'fixtures', `${name}.jsonl`);
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as FixtureRecord);
}

export function messagesOf(records: FixtureRecord[]): SDKMessage[] {
  return records.flatMap((r) => (r.kind === 'message' ? [r.message] : []));
}

/** Junta os deltas como a interface faz e devolve o estado final. */
export function reduce(deltas: ConversationDelta[]): Turn[] {
  return deltas.reduce<Turn[]>((turns, delta) => applyDelta(turns, delta), []);
}

export interface RecordingSink extends AdapterSink {
  deltas: ConversationDelta[];
  states: { state: SessionState; error?: string | undefined }[];
  asks: { turnId: string; request: AskBlock }[];
  nextAsk(): Promise<AskBlock>;
}

export function recordingSink(): RecordingSink {
  const waiters: ((ask: AskBlock) => void)[] = [];
  const sink: RecordingSink = {
    deltas: [],
    states: [],
    asks: [],
    delta: (delta) => sink.deltas.push(delta),
    state: (state, error) => sink.states.push({ state, error }),
    ask: (turnId, request) => {
      sink.asks.push({ turnId, request });
      waiters.shift()?.(request);
    },
    nextAsk: () => new Promise((resolve) => waiters.push(resolve)),
  };
  return sink;
}

export interface FakeQueryControl {
  queryFn: typeof sdkQuery;
  /** As opções com os servidores que chegaram depois por setMcpServers (o que o Claude vê). */
  options(): Options;
  /** As opções tal como o query() as recebeu (o que vai para a linha de comando do claude.exe). */
  rawOptions(): Options;
  permissionResults: PermissionResult[];
  calls: { method: string; args: unknown[] }[];
  /** true depois do close() do query. */
  closed(): boolean;
  /** Faz o processo "morrer": o iterador lança como no bug #359. */
  crash(message?: string): void;
}

/**
 * Um query() falso que reproduz uma fixture gravada: espera pela mensagem do
 * utilizador, emite as mensagens e chama o canUseTool onde a gravação o chamou.
 */
export function fakeQuery(
  records: FixtureRecord[],
  extra: { models?: ModelInfo[] } = {},
): FakeQueryControl {
  let captured: Options | undefined;
  /** Os servidores que chegaram por setMcpServers (pelo stdin, não pela linha de comando). */
  let setServers: Options['mcpServers'];
  let closedFlag = false;
  let crashWith: ((error: Error) => void) | undefined;
  const control: FakeQueryControl = {
    options: () => {
      if (!captured) throw new Error('query() ainda não foi chamado');
      if (!setServers) return captured;
      return { ...captured, mcpServers: { ...captured.mcpServers, ...setServers } };
    },
    rawOptions: () => {
      if (!captured) throw new Error('query() ainda não foi chamado');
      return captured;
    },
    permissionResults: [],
    calls: [],
    closed: () => closedFlag,
    crash: (message = 'Stream closed') => crashWith?.(new Error(message)),
    queryFn: (({
      prompt,
      options,
    }: {
      prompt: AsyncIterable<SDKUserMessage>;
      options: Options;
    }) => {
      captured = options;
      const crashed = new Promise<never>((_, reject) => {
        crashWith = reject;
      });
      crashed.catch(() => undefined);
      let closed = false;
      async function* run(): AsyncGenerator<SDKMessage, void> {
        const iterator = prompt[Symbol.asyncIterator]();
        const first = await Promise.race([iterator.next(), crashed]);
        if (first.done) return;
        for (const record of records) {
          if (closed) return;
          if (record.kind === 'message') {
            yield record.message;
            continue;
          }
          const controller = new AbortController();
          const result = await Promise.race([
            options.canUseTool!(record.toolName, record.input, {
              ...record.options,
              signal: controller.signal,
            } as Parameters<NonNullable<Options['canUseTool']>>[2]),
            crashed,
          ]);
          if (result) control.permissionResults.push(result);
        }
        await Promise.race([iterator.next(), crashed]);
      }
      const generator = run();
      const call =
        (method: string) =>
        async (...args: unknown[]) => {
          control.calls.push({ method, args });
        };
      const query = Object.assign(generator, {
        initializationResult: async () => ({
          models: extra.models ?? [
            {
              value: 'default',
              resolvedModel: 'claude-opus-5-5',
              displayName: 'Default (recommended)',
              description: 'Opus 5.5',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
              supportsAutoMode: true,
            },
            {
              value: 'haiku',
              resolvedModel: 'claude-haiku-5-5',
              displayName: 'Haiku',
              description: 'Haiku 5.5',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high'],
            },
          ],
          commands: [],
          agents: [],
          output_style: 'default',
          available_output_styles: [],
          account: {},
        }),
        interrupt: call('interrupt'),
        setMcpServers: async (servers: NonNullable<Options['mcpServers']>) => {
          control.calls.push({ method: 'setMcpServers', args: [servers] });
          setServers = servers;
          return { added: Object.keys(servers), removed: [], errors: {} };
        },
        setPermissionMode: call('setPermissionMode'),
        setModel: call('setModel'),
        applyFlagSettings: call('applyFlagSettings'),
        getContextUsage: async () => ({
          categories: [],
          totalTokens: 20_000,
          maxTokens: 200_000,
          rawMaxTokens: 200_000,
          percentage: 10,
        }),
        close: () => {
          closed = true;
          closedFlag = true;
        },
      });
      return query as unknown as Query;
    }) as typeof sdkQuery,
  };
  return control;
}

export function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor: tempo esgotado'));
      setTimeout(tick, 5);
    };
    tick();
  });
}
