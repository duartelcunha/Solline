import type {
  CanUseTool,
  EffortLevel,
  ModelInfo,
  Options,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentCapabilities,
  AskBlock,
  ConversationDelta,
  ModeOption,
  PermissionAnswer,
  Question,
  SessionSettings,
} from '@solline/protocol';
import { AsyncQueue } from '../async-queue.ts';
import { sanitizedEnv } from '../env.ts';
import { PermissionBroker, type BrokerOutcome } from '../permission-broker.ts';
import { ClaudeNormalizer } from './claude-normalizer.ts';
import { toolSummary } from './claude-tools.ts';
import type { AdapterSink, AgentAdapter, AgentStartOptions, AgentStartResult } from './types.ts';

export interface ClaudeSdkOptions extends AgentStartOptions {
  claudeExecutable?: string | undefined;
  /** Lê as definições do utilizador e do projeto, como o CLI. Desligar nos testes. */
  loadSettings?: boolean;
  /** Para testes: troca o query() do SDK. */
  queryFn?: typeof sdkQuery;
  /** Ambiente de partida (por omissão o process.env), antes de limpo. */
  env?: NodeJS.ProcessEnv;
  newId?: () => string;
  /** Tempo máximo à espera do arranque do claude.exe. */
  startTimeoutMs?: number;
}

/** Nomes curtos escolhidos pelo Duarte (Ask, Edits, Plan, Auto); descrições em pt-PT. */
export const CLAUDE_MODES: readonly ModeOption[] = [
  {
    id: 'default',
    label: 'Ask',
    description: 'Pede autorização antes de editar ficheiros ou correr comandos.',
  },
  { id: 'acceptEdits', label: 'Edits', description: 'Aceita edições de ficheiros sem perguntar.' },
  { id: 'plan', label: 'Plan', description: 'Só lê e planeia; não muda nada até aprovares.' },
  {
    id: 'auto',
    label: 'Auto',
    description: 'Um classificador aprova ou recusa cada ação e só pergunta quando não sabe.',
  },
];

const CONTROL_TIMEOUT_MS = 15_000;
const STDERR_LIMIT = 4_000;

export const CRASH_MESSAGE = 'A ligação ao Claude caiu. A conversa está guardada: podes retomar.';

interface AskEntry {
  turnId: string;
  block: AskBlock;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[] | undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what}: sem resposta em ${ms / 1000} s`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function capabilitiesFrom(models: ModelInfo[]): AgentCapabilities {
  const auto = models.some((model) => model.supportsAutoMode);
  return {
    models: models.map((model) => ({
      id: model.value,
      resolved: model.resolvedModel ?? null,
      label: model.displayName,
      description: model.description,
      efforts: model.supportsEffort ? [...(model.supportedEffortLevels ?? [])] : [],
    })),
    modes: CLAUDE_MODES.filter((mode) => mode.id !== 'auto' || auto),
    effort: models.some((model) => model.supportsEffort),
    interrupt: true,
    resume: true,
    cost: true,
    context: true,
    thinking: true,
  };
}

function parseQuestions(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input.questions) ? (input.questions as unknown[]) : [];
  return raw.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const q = item as Record<string, unknown>;
    const options = Array.isArray(q.options) ? (q.options as unknown[]) : [];
    return [
      {
        question: typeof q.question === 'string' ? q.question : '',
        header: typeof q.header === 'string' ? q.header : '',
        multiSelect: q.multiSelect === true,
        options: options.flatMap((option) => {
          if (typeof option !== 'object' || option === null) return [];
          const o = option as Record<string, unknown>;
          return typeof o.label === 'string'
            ? [
                {
                  label: o.label,
                  description: typeof o.description === 'string' ? o.description : '',
                },
              ]
            : [];
        }),
      },
    ];
  });
}

/** Constrói o cartão certo para o pedido: plano, pergunta ou permissão. */
export function askBlockFor(
  toolName: string,
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2],
): AskBlock {
  const id = options.requestId || options.toolUseID;
  if (toolName === 'ExitPlanMode') {
    return {
      kind: 'plan',
      id,
      plan: typeof input.plan === 'string' ? input.plan : '',
      status: 'pending',
    };
  }
  if (toolName === 'AskUserQuestion') {
    return { kind: 'question', id, questions: parseQuestions(input), status: 'pending' };
  }
  const reason = options.decisionReason ?? options.title;
  return {
    kind: 'permission',
    id,
    toolName,
    toolUseId: options.toolUseID,
    title: toolSummary(toolName, input),
    ...(reason ? { description: reason } : {}),
    input,
    canAlwaysAllow: !options.suppressAlwaysAllowRule && (options.suggestions?.length ?? 0) > 0,
    defaultToNo: options.defaultToNo === true,
    status: 'pending',
  };
}

/** A resposta da interface no formato que o SDK espera. */
export function toPermissionResult(
  entry: Pick<AskEntry, 'block' | 'input' | 'suggestions'>,
  outcome: BrokerOutcome,
): PermissionResult {
  const { block, input } = entry;
  switch (outcome.decision) {
    case 'allow-once':
      return { behavior: 'allow', updatedInput: input };
    case 'allow-always':
      return {
        behavior: 'allow',
        updatedInput: input,
        updatedPermissions: entry.suggestions ?? [],
      };
    case 'answer':
      return { behavior: 'allow', updatedInput: { ...input, answers: outcome.answers } };
    case 'deny':
      return {
        behavior: 'deny',
        message:
          outcome.message ??
          (block.kind === 'plan'
            ? 'The user did not approve the plan. Stay in plan mode and ask what should change.'
            : block.kind === 'question'
              ? 'The user chose not to answer.'
              : 'The user denied this action.'),
      };
    case 'cancelled':
      return { behavior: 'deny', message: 'The request was cancelled before the user answered.' };
  }
}

function statusFor(outcome: BrokerOutcome): AskBlock['status'] {
  switch (outcome.decision) {
    case 'allow-once':
    case 'answer':
      return 'allowed';
    case 'allow-always':
      return 'allowed-always';
    case 'deny':
      return 'denied';
    case 'cancelled':
      return 'cancelled';
  }
}

/**
 * O Claude através do Agent SDK: um query() de longa duração por sessão, em
 * streaming-input, alimentado por uma fila própria.
 */
export class ClaudeSdkAdapter implements AgentAdapter {
  readonly agent = 'claude' as const;
  readonly #options: ClaudeSdkOptions;
  readonly #sink: AdapterSink;
  readonly #normalizer: ClaudeNormalizer;
  readonly #broker = new PermissionBroker();
  readonly #asks = new Map<string, AskEntry>();
  readonly #newId: () => string;
  #queue: AsyncQueue<SDKUserMessage> | undefined;
  #query: Query | undefined;
  #pump: Promise<void> | undefined;
  #closing = false;
  #running = false;
  #crashed = false;
  #agentSessionId: string | null;
  #capabilities: AgentCapabilities | undefined;
  #settings: SessionSettings;
  #stderr = '';

  constructor(options: ClaudeSdkOptions, sink: AdapterSink) {
    this.#options = options;
    this.#sink = sink;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#normalizer = new ClaudeNormalizer({ newId: this.#newId });
    this.#agentSessionId = options.resume ?? null;
    this.#settings = {
      model: options.model ?? null,
      effort: options.effort ?? null,
      mode: options.mode,
    };
  }

  agentSessionId(): string | null {
    return this.#agentSessionId;
  }

  capabilities(): AgentCapabilities {
    if (!this.#capabilities) throw new Error('A sessão ainda não arrancou');
    return this.#capabilities;
  }

  async start(): Promise<AgentStartResult> {
    const query = this.#options.queryFn ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
    const queue = new AsyncQueue<SDKUserMessage>();
    this.#queue = queue;
    this.#sink.state('starting');
    const q = query({ prompt: queue, options: this.#sdkOptions() });
    this.#query = q;
    this.#pump = this.#runPump(q);
    try {
      const init = await withTimeout(
        q.initializationResult(),
        this.#options.startTimeoutMs ?? 90_000,
        'Arranque do Claude',
      );
      this.#capabilities = capabilitiesFrom(init.models);
      if (!this.#settings.model) this.#settings.model = init.models[0]?.value ?? null;
    } catch (error) {
      this.#closing = true;
      queue.close();
      q.close();
      throw new Error(this.#withStderr(error), { cause: error });
    }
    this.#sink.state('idle');
    return { settings: { ...this.#settings }, capabilities: this.#capabilities };
  }

  async send(text: string): Promise<string> {
    const queue = this.#queue;
    if (!queue || queue.closed || this.#crashed) throw new Error('A sessão não está ligada');
    const turnId = this.#newId();
    this.#emit(this.#normalizer.userTurn(turnId, text));
    this.#running = true;
    this.#sink.state('running');
    queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid: turnId as SDKUserMessage['uuid'],
    });
    return turnId;
  }

  async interrupt(): Promise<void> {
    const q = this.#query;
    // #444: interromper sem turno a correr (logo após o init) pode pendurar o canal.
    if (!q || !this.#running) return;
    this.#normalizer.markInterrupted();
    this.#cancelAsks('interrupt');
    await this.#control(q.interrupt(), 'Interromper');
  }

  async setMode(mode: string): Promise<void> {
    const q = this.#requireQuery();
    await this.#control(q.setPermissionMode(mode as PermissionMode), 'Mudar o modo');
    this.#applySettings({ mode });
  }

  async setModel(model: string): Promise<void> {
    const q = this.#requireQuery();
    await this.#control(q.setModel(model), 'Mudar o modelo');
    this.#applySettings({ model });
  }

  async setEffort(effort: string): Promise<void> {
    const q = this.#requireQuery();
    await this.#control(
      q.applyFlagSettings({ effortLevel: effort as EffortLevel }),
      'Mudar o effort',
    );
    this.#applySettings({ effort });
  }

  answerPermission(requestId: string, answer: PermissionAnswer): boolean {
    const entry = this.#asks.get(requestId);
    if (!entry) return false;
    const { block } = entry;
    if (
      answer.decision === 'allow-always' &&
      !(block.kind === 'permission' && block.canAlwaysAllow)
    ) {
      throw new Error('Este pedido não aceita "Permitir sempre"');
    }
    if (answer.decision === 'answer' && block.kind !== 'question') {
      throw new Error('Este pedido não é uma pergunta');
    }
    return this.#broker.answer(requestId, answer);
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#cancelAsks('closed');
    this.#queue?.close();
    this.#query?.close();
    if (this.#pump) await withTimeout(this.#pump, 5_000, 'Fechar a sessão').catch(() => undefined);
  }

  #sdkOptions(): Options {
    const options = this.#options;
    return {
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort as EffortLevel } : {}),
      permissionMode: options.mode as PermissionMode,
      includePartialMessages: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: options.loadSettings === false ? [] : ['user', 'project', 'local'],
      canUseTool: this.#canUseTool,
      env: sanitizedEnv(options.env),
      stderr: (data) => {
        this.#stderr = (this.#stderr + data).slice(-STDERR_LIMIT);
      },
      ...(options.resume ? { resume: options.resume } : {}),
      ...(options.claudeExecutable ? { pathToClaudeCodeExecutable: options.claudeExecutable } : {}),
    };
  }

  readonly #canUseTool: CanUseTool = async (toolName, input, options) => {
    const { turnId, deltas } = this.#normalizer.ensureAssistantTurn();
    this.#emit(deltas);
    const block = askBlockFor(toolName, input, options);
    const entry: AskEntry = { turnId, block, input, suggestions: options.suggestions };
    this.#asks.set(block.id, entry);
    this.#sink.ask(turnId, block);
    this.#sink.state('needs-you');
    const outcome = await this.#broker.wait(block.id, options.signal);
    this.#asks.delete(block.id);
    const answers = outcome.decision === 'answer' ? outcome.answers : undefined;
    const resolved: AskBlock =
      block.kind === 'question' && answers
        ? { ...block, status: statusFor(outcome), answers }
        : { ...block, status: statusFor(outcome) };
    this.#emit([{ type: 'block.upsert', turnId, block: resolved }]);
    if (!this.#crashed)
      this.#sink.state(this.#asks.size > 0 ? 'needs-you' : this.#running ? 'running' : 'idle');
    return toPermissionResult(entry, outcome);
  };

  async #runPump(q: Query): Promise<void> {
    try {
      for await (const message of q) this.#handle(message);
      if (!this.#closing) this.#crash(new Error('O canal com o Claude fechou sem aviso'));
    } catch (error) {
      if (!this.#closing) this.#crash(error);
    }
  }

  #handle(message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') {
      this.#agentSessionId = message.session_id;
    }
    this.#emit(this.#normalizer.push(message));
    if (message.type === 'result') {
      this.#running = false;
      if (this.#asks.size === 0) this.#sink.state('idle');
      void this.#refreshContext();
    }
  }

  async #refreshContext(): Promise<void> {
    const q = this.#query;
    if (!q) return;
    try {
      const usage = await withTimeout(q.getContextUsage({ detail: 'summary' }), 10_000, 'Contexto');
      this.#sink.delta({
        type: 'usage',
        usage: {
          context: {
            usedTokens: usage.totalTokens,
            maxTokens: usage.maxTokens,
            percent: usage.percentage,
          },
        },
      });
    } catch {
      // O contexto é informativo: sem resposta, o medidor fica com o último valor.
    }
  }

  #emit(deltas: ConversationDelta[]): void {
    for (const delta of deltas) {
      if (delta.type === 'settings') Object.assign(this.#settings, delta.settings);
      this.#sink.delta(delta);
    }
  }

  #applySettings(settings: Partial<SessionSettings>): void {
    this.#emit([{ type: 'settings', settings }]);
  }

  #cancelAsks(reason: string): void {
    this.#broker.cancelAll(reason);
  }

  #requireQuery(): Query {
    if (!this.#query || this.#crashed) throw new Error('A sessão não está ligada');
    return this.#query;
  }

  async #control<T>(promise: Promise<T>, what: string): Promise<T> {
    try {
      return await withTimeout(promise, CONTROL_TIMEOUT_MS, what);
    } catch (error) {
      // #359/#384/#385: no Windows o canal pode fechar a meio ("Stream closed").
      if (/stream closed|not connected|ProcessTransport/i.test(String(error))) this.#crash(error);
      throw new Error(`${what} falhou: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  #crash(error: unknown): void {
    if (this.#crashed || this.#closing) return;
    this.#crashed = true;
    this.#running = false;
    console.error(`[claude-sdk] sessão caiu: ${this.#withStderr(error)}`);
    this.#cancelAsks('crashed');
    this.#queue?.close();
    this.#sink.state('error', CRASH_MESSAGE);
  }

  #withStderr(error: unknown): string {
    const reason = error instanceof Error ? error.message : String(error);
    const tail = this.#stderr.trim().slice(-500);
    return tail ? `${reason}\n${tail}` : reason;
  }
}
