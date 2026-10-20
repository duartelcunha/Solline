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
import { AsyncQueue } from '../../async-queue.ts';
import { sanitizedEnv } from '../../env.ts';
import { PermissionBroker, type BrokerOutcome } from '../../permission-broker.ts';
import { ClaudeNormalizer } from './normalizer.ts';
import { toolShape, toolSummary } from './tools.ts';
import type { AdapterSink, AgentAdapter, AgentStartOptions, AgentStartResult } from '../types.ts';

/**
 * O Claude Code a falar com outro fornecedor (ver agents/profiles.ts): os modelos do init
 * apontam todos para o fornecedor, por isso a lista vem daqui; o custo seria o do Claude e
 * não aparece; não lê definições do utilizador nem do projeto e o "sempre" fica na sessão.
 */
export interface ClaudeProfile {
  models: readonly { id: string; resolved: string | null; label: string; description: string }[];
  hideModes: readonly string[];
}

export interface ClaudeSdkOptions extends AgentStartOptions {
  claudeExecutable?: string | undefined;
  profile?: ClaudeProfile | undefined;
  /** Lê as definições do utilizador e do projeto, como o CLI. Desligar nos testes. */
  loadSettings?: boolean;
  /** Para testes: troca o query() do SDK. */
  queryFn?: typeof sdkQuery;
  /** Para testes: arranca o claude.exe à mão (por exemplo para o matar e provar a supervisão). */
  spawn?: Options['spawnClaudeCodeProcess'];
}

/** Nomes curtos escolhidos pelo Duarte (Ask, Edits, Plan, Auto); descrições em pt-PT. */
export const CLAUDE_MODES: readonly ModeOption[] = [
  {
    id: 'default',
    label: 'Ask',
    description: 'Pede autorização antes de editar ficheiros ou correr comandos.',
    risk: 'ask',
  },
  {
    id: 'acceptEdits',
    label: 'Edits',
    description: 'Aceita edições de ficheiros sem perguntar.',
    risk: 'edits',
  },
  {
    id: 'plan',
    label: 'Plan',
    description: 'Só lê e planeia; não muda nada até aprovares.',
    risk: 'plan',
  },
  {
    id: 'auto',
    label: 'Auto',
    description: 'Um classificador aprova ou recusa cada ação e só pergunta quando não sabe.',
    risk: 'auto',
  },
];

/**
 * Só os modos que a Solline mostra chegam ao SDK: bypassPermissions e dontAsk nunca
 * passam, venha o pedido de onde vier.
 */
export function toPermissionMode(id: string): PermissionMode {
  if (!CLAUDE_MODES.some((mode) => mode.id === id)) {
    throw new Error(`Modo desconhecido para o Claude: ${id}`);
  }
  return id as PermissionMode;
}

/** Como toPermissionMode, mas cai para o fallback (no arranque e no resume). */
export function toPermissionModeOr(id: string, fallback: PermissionMode): PermissionMode {
  return CLAUDE_MODES.some((mode) => mode.id === id) ? (id as PermissionMode) : fallback;
}

const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function toEffortLevel(id: string): EffortLevel {
  if (!EFFORT_LEVELS.includes(id)) throw new Error(`Effort desconhecido: ${id}`);
  return id as EffortLevel;
}

const CONTROL_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 90_000;
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

export function capabilitiesFrom(models: ModelInfo[], profile?: ClaudeProfile): AgentCapabilities {
  const auto = models.some((model) => model.supportsAutoMode);
  const efforts = (model: ModelInfo | undefined) =>
    model?.supportsEffort ? [...(model.supportedEffortLevels ?? [])] : [];
  // Num perfil, cada modelo herda o effort do alias com o mesmo id (ou do primeiro).
  const listed = profile
    ? profile.models.map((m) => ({
        ...m,
        efforts: efforts(models.find((i) => i.value === m.id) ?? models[0]),
      }))
    : models.map((model) => ({
        id: model.value,
        resolved: model.resolvedModel ?? null,
        label: model.displayName,
        description: model.description,
        efforts: efforts(model),
      }));
  return {
    models: listed,
    modes: CLAUDE_MODES.filter(
      (mode) => (mode.id !== 'auto' || auto) && !profile?.hideModes.includes(mode.id),
    ),
    effort: listed.some((model) => model.efforts.length > 0),
    effortOrder: [...EFFORT_LEVELS],
    features: { cost: !profile, context: true, resume: true },
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
  projectTrusted = true,
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
  const { category, content } = toolShape(toolName, input);
  return {
    kind: 'permission',
    id,
    toolName,
    toolUseId: options.toolUseID,
    title: toolSummary(toolName, input),
    category,
    ...(content ? { content } : {}),
    // O SDK não tem "recusar sempre" num pedido: as regras de recusa vivem nas definições.
    canAlwaysDeny: false,
    ...(reason ? { description: reason } : {}),
    input,
    canAlwaysAllow: !options.suppressAlwaysAllowRule && (options.suggestions?.length ?? 0) > 0,
    ...(projectTrusted ? {} : { alwaysScope: 'session' as const }),
    defaultToNo: options.defaultToNo === true,
    status: 'pending',
  };
}

/**
 * A resposta da interface no formato que o SDK espera. Num projeto sem confiança o "sempre"
 * fica na sessão: senão o CLI gravava a regra em <projeto>/.claude/settings.local.json.
 */
export function toPermissionResult(
  entry: Pick<AskEntry, 'block' | 'input' | 'suggestions'>,
  outcome: BrokerOutcome,
  projectTrusted = true,
): PermissionResult {
  const { block, input } = entry;
  switch (outcome.decision) {
    case 'allow-once':
      return { behavior: 'allow', updatedInput: input };
    case 'allow-always': {
      const suggestions = entry.suggestions ?? [];
      return {
        behavior: 'allow',
        updatedInput: input,
        updatedPermissions: projectTrusted
          ? suggestions
          : suggestions.map((update) => ({ ...update, destination: 'session' as const })),
      };
    }
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
    case 'deny-always':
      return { behavior: 'deny', message: 'The user denied this action.' };
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
    case 'deny-always':
      return 'denied-always';
    case 'cancelled':
      return 'cancelled';
  }
}

/**
 * O Claude através do Agent SDK: um query() de longa duração por sessão, em
 * streaming-input, alimentado por uma fila própria.
 */
export class ClaudeSdkAdapter implements AgentAdapter {
  readonly #options: ClaudeSdkOptions;
  readonly #sink: AdapterSink;
  readonly #normalizer: ClaudeNormalizer;
  readonly #broker = new PermissionBroker();
  readonly #asks = new Map<string, AskEntry>();
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
    this.#normalizer = new ClaudeNormalizer();
    this.#agentSessionId = options.resume ?? null;
    this.#settings = {
      model: options.model ?? null,
      // Só reporta o effort que chega mesmo ao SDK (ver #sdkOptions).
      effort: options.effort && EFFORT_LEVELS.includes(options.effort) ? options.effort : null,
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
        START_TIMEOUT_MS,
        'Arranque do Claude',
      );
      this.#capabilities = capabilitiesFrom(init.models, this.#options.profile);
      if (!this.#settings.model) this.#settings.model = this.#capabilities.models[0]?.id ?? null;
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
    const turnId = crypto.randomUUID();
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
    await this.#control(q.setPermissionMode(toPermissionMode(mode)), 'Mudar o modo');
    this.#applySettings({ mode });
  }

  async setModel(model: string): Promise<void> {
    const q = this.#requireQuery();
    await this.#control(q.setModel(model), 'Mudar o modelo');
    this.#applySettings({ model });
  }

  async setEffort(effort: string): Promise<void> {
    const level = toEffortLevel(effort);
    const q = this.#requireQuery();
    await this.#control(q.applyFlagSettings({ effortLevel: level }), 'Mudar o effort');
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
    if (
      answer.decision === 'deny-always' &&
      !(block.kind === 'permission' && block.canAlwaysDeny === true)
    ) {
      throw new Error('Este pedido não aceita "Negar sempre"');
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
      ...(options.effort && EFFORT_LEVELS.includes(options.effort)
        ? { effort: toEffortLevel(options.effort) }
        : {}),
      permissionMode: toPermissionModeOr(options.mode ?? 'default', 'default'),
      includePartialMessages: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // Sem confiança, só as definições do utilizador: nada do .claude/ nem do CLAUDE.md da pasta.
      settingSources:
        options.loadSettings === false || options.profile
          ? []
          : options.projectTrusted
            ? ['user', 'project', 'local']
            : ['user'],
      canUseTool: this.#canUseTool,
      env: options.env ?? sanitizedEnv(),
      stderr: (data) => {
        this.#stderr = (this.#stderr + data).slice(-STDERR_LIMIT);
      },
      ...(options.resume ? { resume: options.resume } : {}),
      ...(options.spawn ? { spawnClaudeCodeProcess: options.spawn } : {}),
      ...(options.claudeExecutable ? { pathToClaudeCodeExecutable: options.claudeExecutable } : {}),
    };
  }

  readonly #canUseTool: CanUseTool = async (toolName, input, options) => {
    const { turnId, deltas } = this.#normalizer.ensureAssistantTurn();
    this.#emit(deltas);
    // Num perfil de fornecedor não há definições gravadas: o "sempre" fica na sessão.
    const trusted = this.#options.projectTrusted === true && !this.#options.profile;
    const block = askBlockFor(toolName, input, options, trusted);
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
    return toPermissionResult(entry, outcome, trusted);
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
