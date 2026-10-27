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
import type { BrokerOutcome } from '../../permission-broker.ts';
import { SessionShell } from '../shared/session-shell.ts';
import { ClaudeNormalizer } from './normalizer.ts';
import { toolShape, toolSummary } from './tools.ts';
import { withContext } from '../shared/turns.ts';
import type {
  AdapterSink,
  AgentAdapter,
  AgentStartOptions,
  AgentStartResult,
  SendOptions,
} from '../types.ts';
import { CRAFT_RULES } from '../../quality/craft.ts';
import { claudeBrain, type ClaudeBrain } from '../../brain/claude.ts';

export interface ClaudeSdkOptions extends AgentStartOptions {
  claudeExecutable?: string | undefined;
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
    description: 'Pergunta antes de editar ou correr comandos',
    risk: 'ask',
  },
  {
    id: 'acceptEdits',
    label: 'Edits',
    description: 'Edita sem perguntar',
    risk: 'edits',
  },
  {
    id: 'plan',
    label: 'Plan',
    description: 'Só lê e planeia até aprovares',
    risk: 'plan',
  },
  {
    id: 'auto',
    label: 'Auto',
    description: 'Decide sozinho e pergunta na dúvida',
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

export function capabilitiesFrom(models: ModelInfo[]): AgentCapabilities {
  const auto = models.some((model) => model.supportsAutoMode);
  const efforts = (model: ModelInfo | undefined) =>
    model?.supportsEffort ? [...(model.supportedEffortLevels ?? [])] : [];
  const listed = models.map((model) => ({
    id: model.value,
    resolved: model.resolvedModel ?? null,
    label: model.displayName,
    description: model.description,
    efforts: efforts(model),
  }));
  return {
    models: listed,
    modes: CLAUDE_MODES.filter((mode) => mode.id !== 'auto' || auto),
    effort: listed.some((model) => model.efforts.length > 0),
    effortOrder: [...EFFORT_LEVELS],
    features: { cost: true, context: true, resume: true, rewind: true, steer: true },
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

interface ClaudePoint {
  session: string;
  /** null: a sessão inteira, como estava ao retomar. */
  at: string | null;
}

function parsePoint(token: string): ClaudePoint {
  const parsed = JSON.parse(token) as Partial<ClaudePoint>;
  if (typeof parsed.session !== 'string') throw new Error('Ponto de rebobinar inválido');
  return { session: parsed.session, at: typeof parsed.at === 'string' ? parsed.at : null };
}

/**
 * O Claude através do Agent SDK: um query() de longa duração por sessão, em
 * streaming-input, alimentado por uma fila própria.
 */
export class ClaudeSdkAdapter implements AgentAdapter {
  readonly #options: ClaudeSdkOptions;
  readonly #sink: AdapterSink;
  readonly #normalizer: ClaudeNormalizer;
  /** Os pedidos, as quedas e o estado da sessão. */
  readonly #shell: SessionShell;
  /** Ferramentas pedidas e ainda sem resultado: só com uma a correr se pode guiar. */
  readonly #inFlight = new Set<string>();
  /** Mensagens guiadas por ler; armed: uma ferramenta acabou desde que foram mandadas. */
  readonly #steers = new Map<string, { turnId: string; text: string; armed: boolean }>();
  /** Ferramentas da Solline só de leitura: correm sem pedir autorização. */
  readonly #autoAllow = new Set<string>();
  #queue: AsyncQueue<SDKUserMessage> | undefined;
  #query: Query | undefined;
  #pump: Promise<void> | undefined;
  #agentSessionId: string | null;
  #capabilities: AgentCapabilities | undefined;
  #settings: SessionSettings;
  #stderr = '';
  /** A última entrada da conversa no Claude: é aí que um fork volta (resumeSessionAt). */
  #point: ClaudePoint | null;

  constructor(options: ClaudeSdkOptions, sink: AdapterSink) {
    this.#options = options;
    this.#sink = sink;
    this.#shell = new SessionShell(sink);
    this.#normalizer = new ClaudeNormalizer();
    this.#point = options.fork
      ? parsePoint(options.fork)
      : options.resume
        ? { session: options.resume, at: null }
        : null;
    // Um fork só tem id quando o Claude o criar (no system/init).
    this.#agentSessionId = options.fork ? null : (options.resume ?? null);
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

  rewindPoint(): string | null {
    return this.#point ? JSON.stringify(this.#point) : null;
  }

  capabilities(): AgentCapabilities {
    if (!this.#capabilities) throw new Error('A sessão ainda não arrancou');
    return this.#capabilities;
  }

  async start(): Promise<AgentStartResult> {
    // O SDK só se carrega quando faz falta: nos testes com queryFn e sem cérebro, nunca.
    const brain = this.#options.brain;
    const sdk =
      this.#options.queryFn && !brain ? undefined : await import('@anthropic-ai/claude-agent-sdk');
    const query = this.#options.queryFn ?? sdk?.query;
    if (!query) throw new Error('O Agent SDK não carregou');
    const queue = new AsyncQueue<SDKUserMessage>();
    this.#queue = queue;
    this.#shell.starting();
    const inProcess = brain && sdk ? claudeBrain(sdk, brain) : undefined;
    // As ferramentas só de leitura da Solline passam pelo canUseTool sem perguntar. Não vão em
    // allowedTools: o SDK avisa que isso tira o canUseTool a essas ferramentas.
    for (const name of inProcess?.allowedTools ?? []) this.#autoAllow.add(name);
    const q = query({ prompt: queue, options: this.#sdkOptions(inProcess) });
    this.#query = q;
    this.#pump = this.#runPump(q);
    try {
      const init = await withTimeout(
        q.initializationResult(),
        START_TIMEOUT_MS,
        'Arranque do Claude',
      );
      this.#capabilities = capabilitiesFrom(init.models);
      if (!this.#settings.model) this.#settings.model = this.#capabilities.models[0]?.id ?? null;
    } catch (error) {
      this.#shell.close();
      queue.close();
      q.close();
      throw new Error(this.#withStderr(error), { cause: error });
    }
    this.#shell.ready();
    return { settings: { ...this.#settings }, capabilities: this.#capabilities };
  }

  async send(text: string, options: SendOptions = {}): Promise<string> {
    const queue = this.#queue;
    if (!queue || queue.closed || this.#shell.crashed) throw new Error('A sessão não está ligada');
    const turnId = options.turnId ?? crypto.randomUUID();
    this.#emit(this.#normalizer.userTurn(turnId, text));
    this.#shell.turnStarted();
    queue.push({
      type: 'user',
      message: { role: 'user', content: withContext(text, options.context) },
      parent_tool_use_id: null,
      uuid: turnId as SDKUserMessage['uuid'],
    });
    return turnId;
  }

  /**
   * Guia a meio: só com uma ferramenta a correr, porque o SDK lê uma mensagem 'next' quando a
   * ferramenta acaba, no mesmo turno (um só result). Sem ferramenta a correr, a mensagem
   * podia ficar para depois do result e abrir outro turno: vai para a fila.
   */
  async steer(text: string, id: string): Promise<'joined' | 'too-late'> {
    const queue = this.#queue;
    if (!queue || queue.closed || !this.#shell.running || this.#inFlight.size === 0) {
      return 'too-late';
    }
    const { turnId, deltas } = this.#normalizer.ensureAssistantTurn();
    this.#emit([
      ...deltas,
      { type: 'block.upsert', turnId, block: { kind: 'steer', id, text, status: 'waiting' } },
    ]);
    this.#steers.set(id, { turnId, text, armed: false });
    queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid: id as SDKUserMessage['uuid'],
      priority: 'next',
    });
    return 'joined';
  }

  /** As ferramentas a correr e as mensagens guiadas que o agente ainda não leu. */
  #track(message: SDKMessage): void {
    // Com mensagens parciais, a ferramenta começa no stream antes da mensagem inteira chegar.
    if (message.type === 'stream_event') {
      const event = message.event;
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        this.#inFlight.add(event.content_block.id);
      }
      return;
    }
    if (message.type === 'assistant') {
      for (const part of message.message.content) {
        if (part.type === 'tool_use') this.#inFlight.add(part.id);
      }
      // A primeira resposta depois de uma ferramenta acabar já leu as mensagens guiadas.
      for (const [id, steer] of this.#steers) {
        if (!steer.armed) continue;
        this.#steers.delete(id);
        this.#emit([
          {
            type: 'block.upsert',
            turnId: steer.turnId,
            block: { kind: 'steer', id, text: steer.text, status: 'absorbed' },
          },
        ]);
      }
    } else if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const part of message.message.content) {
        if (typeof part === 'object' && part.type === 'tool_result') {
          this.#inFlight.delete(part.tool_use_id);
          for (const steer of this.#steers.values()) steer.armed = true;
        }
      }
    } else if (message.type === 'result') {
      this.#inFlight.clear();
      // Turno acabado (ou interrompido) antes de a ler: o SDK lê-a a seguir e a primeira
      // resposta que vier marca-a como lida.
      for (const steer of this.#steers.values()) steer.armed = true;
    }
  }

  async interrupt(): Promise<void> {
    const q = this.#query;
    // #444: interromper sem turno a correr (logo após o init) pode pendurar o canal.
    if (!q || !this.#shell.running) return;
    this.#normalizer.markInterrupted();
    this.#shell.interrupted();
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
    return this.#shell.answer(requestId, answer);
  }

  async close(): Promise<void> {
    this.#shell.close();
    this.#queue?.close();
    this.#query?.close();
    if (this.#pump) await withTimeout(this.#pump, 5_000, 'Fechar a sessão').catch(() => undefined);
  }

  #sdkOptions(brain?: ClaudeBrain): Options {
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
      systemPrompt: { type: 'preset', preset: 'claude_code', append: CRAFT_RULES },
      // Sem confiança, só as definições do utilizador: nada do .claude/ nem do CLAUDE.md da pasta.
      settingSources:
        options.loadSettings === false
          ? []
          : options.projectTrusted
            ? ['user', 'project', 'local']
            : ['user'],
      canUseTool: this.#canUseTool,
      env: options.env ?? sanitizedEnv(),
      stderr: (data) => {
        this.#stderr = (this.#stderr + data).slice(-STDERR_LIMIT);
      },
      ...(options.mcpServers?.length || brain
        ? {
            mcpServers: {
              ...Object.fromEntries(
                (options.mcpServers ?? []).map((s) => [
                  s.name,
                  {
                    type: 'stdio' as const,
                    command: s.command,
                    args: [...s.args],
                    env: { ...s.env },
                  },
                ]),
              ),
              // Por último: o nome "solline" é da Solline, nenhum servidor do catálogo o ocupa.
              ...(brain ? { [brain.server.name]: brain.server } : {}),
            },
          }
        : {}),
      ...(options.fork && this.#point
        ? {
            resume: this.#point.session,
            forkSession: true,
            ...(this.#point.at ? { resumeSessionAt: this.#point.at } : {}),
          }
        : options.resume
          ? { resume: options.resume }
          : {}),
      ...(options.spawn ? { spawnClaudeCodeProcess: options.spawn } : {}),
      ...(options.claudeExecutable ? { pathToClaudeCodeExecutable: options.claudeExecutable } : {}),
    };
  }

  readonly #canUseTool: CanUseTool = async (toolName, input, options) => {
    if (this.#autoAllow.has(toolName)) return { behavior: 'allow', updatedInput: input };
    const { turnId, deltas } = this.#normalizer.ensureAssistantTurn();
    this.#emit(deltas);
    const trusted = this.#options.projectTrusted === true;
    const asked = askBlockFor(toolName, input, options, trusted);
    // As ferramentas de um servidor que corre programas pedem sempre (nunca "Permitir sempre").
    const risky = (this.#options.mcpServers ?? []).some(
      (s) => s.executesCode && toolName.startsWith(`mcp__${s.name}__`),
    );
    const block: AskBlock =
      risky && asked.kind === 'permission' ? { ...asked, canAlwaysAllow: false } : asked;
    const entry: AskEntry = { turnId, block, input, suggestions: options.suggestions };
    const outcome = await this.#shell.ask(turnId, block, undefined, options.signal);
    return toPermissionResult(entry, outcome, trusted);
  };

  async #runPump(q: Query): Promise<void> {
    try {
      for await (const message of q) this.#handle(message);
      if (!this.#shell.closing) this.#crash(new Error('O canal com o Claude fechou sem aviso'));
    } catch (error) {
      if (!this.#shell.closing) this.#crash(error);
    }
  }

  #handle(message: SDKMessage): void {
    this.#track(message);
    if (message.type === 'system' && message.subtype === 'init') {
      this.#agentSessionId = message.session_id;
    }
    // As entradas da conversa (não as parciais do streaming) marcam o ponto de rebobinar.
    if ((message.type === 'assistant' || message.type === 'user') && message.uuid) {
      const session = message.session_id ?? this.#agentSessionId;
      if (session) this.#point = { session, at: message.uuid };
    }
    this.#emit(this.#normalizer.push(message));
    if (message.type === 'result') {
      this.#shell.turnEnded();
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

  #requireQuery(): Query {
    if (!this.#query || this.#shell.crashed) throw new Error('A sessão não está ligada');
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
    if (!this.#shell.crash(CRASH_MESSAGE)) return;
    console.error(`[claude-sdk] sessão caiu: ${this.#withStderr(error)}`);
    this.#queue?.close();
  }

  #withStderr(error: unknown): string {
    const reason = error instanceof Error ? error.message : String(error);
    const tail = this.#stderr.trim().slice(-500);
    return tail ? `${reason}\n${tail}` : reason;
  }
}
