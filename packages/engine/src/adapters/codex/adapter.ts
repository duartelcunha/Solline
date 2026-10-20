import type {
  AgentCapabilities,
  AskBlock,
  ConversationDelta,
  ModelOption,
  PermissionAnswer,
  PermissionBlock,
  SessionSettings,
} from '@solline/protocol';
import { PermissionBroker, type BrokerOutcome } from '../../permission-broker.ts';
import { JsonRpcPeer, StderrTail, type RequestId } from '../../rpc/json-rpc.ts';
import { clip } from '../claude/tools.ts';
import { crashMessage, errorNotice, withTimeout } from '../shared/turns.ts';
import type { AdapterSink, AgentAdapter, AgentStartOptions, AgentStartResult } from '../types.ts';
import { CODEX_MODES, DEFAULT_CODEX_MODE, threadPolicy, turnOverrides } from './modes.ts';
import { mcpApprovalResponse, mcpServersConfig, mcpToolApproval } from './mcp.ts';
import { CodexNormalizer, displayCommand } from './normalizer.ts';
import { initializeCodex, spawnCodex, type CodexTransport } from './transport.ts';
import type { ReviewDecision } from './protocol/ReviewDecision';
import type { CommandExecutionApprovalDecision } from './protocol/v2/CommandExecutionApprovalDecision';
import type { CommandExecutionRequestApprovalParams } from './protocol/v2/CommandExecutionRequestApprovalParams';
import type { FileChangeRequestApprovalParams } from './protocol/v2/FileChangeRequestApprovalParams';
import type { GetAccountResponse } from './protocol/v2/GetAccountResponse';
import type { McpServerElicitationRequestParams } from './protocol/v2/McpServerElicitationRequestParams';
import type { Model } from './protocol/v2/Model';
import type { ModelListResponse } from './protocol/v2/ModelListResponse';
import type { ThreadStartResponse } from './protocol/v2/ThreadStartResponse';
import type { TurnStartParams } from './protocol/v2/TurnStartParams';
import type { TurnStartResponse } from './protocol/v2/TurnStartResponse';
import type { WindowsSandboxReadinessResponse } from './protocol/v2/WindowsSandboxReadinessResponse';

export type { CodexTransport } from './transport.ts';

export interface CodexAdapterOptions extends AgentStartOptions {
  /** Caminho absoluto do codex.exe. */
  executable?: string | undefined;
  /** Para testes: liga a outro transporte em vez de arrancar o codex.exe. */
  transport?: (() => CodexTransport) | undefined;
}

/** A ordem do effort que a Solline mostra; níveis novos do Codex vão para o fim. */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const START_TIMEOUT_MS = 60_000;
const CONTROL_TIMEOUT_MS = 30_000;

export const CODEX_LOGIN_MESSAGE =
  'O Codex não tem sessão iniciada. Carrega em "Entrar com ChatGPT" no seletor de agentes e volta a abrir a sessão.';

function modelOption(model: Model): ModelOption {
  return {
    id: model.id,
    resolved: model.model !== model.id ? model.model : null,
    label: model.displayName,
    description: model.description,
    efforts: model.supportedReasoningEfforts.map((e) => e.reasoningEffort),
  };
}

function effortOrder(models: readonly ModelOption[]): string[] {
  const seen = models.flatMap((m) => m.efforts);
  const extra = seen.filter((e, i) => !EFFORT_ORDER.includes(e) && seen.indexOf(e) === i);
  return [...EFFORT_ORDER.filter((e) => seen.includes(e)), ...extra];
}

type ApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'execCommandApproval'
  | 'applyPatchApproval';

interface AskEntry {
  turnId: string;
  block: PermissionBlock;
  rpcId: RequestId;
}

/** A resposta da interface no formato de cada pedido de aprovação do Codex. */
export function codexDecision(
  method: ApprovalMethod,
  outcome: BrokerOutcome,
): CommandExecutionApprovalDecision | ReviewDecision {
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    switch (outcome.decision) {
      case 'allow-once':
        return 'approved';
      case 'allow-always':
        return 'approved_for_session';
      case 'cancelled':
        return 'abort';
      default:
        return { denied: { rejection: 'The user denied this action.' } };
    }
  }
  switch (outcome.decision) {
    case 'allow-once':
      return 'accept';
    case 'allow-always':
      return 'acceptForSession';
    case 'cancelled':
      return 'cancel';
    default:
      return 'decline';
  }
}

/**
 * O Codex pelo codex app-server: um processo por sessão, JSON-RPC por stdio. Modelo, effort e
 * modo valem a partir do turno seguinte (o app-server aplica-os no turn/start).
 */
export class CodexAppServerAdapter implements AgentAdapter {
  readonly #options: CodexAdapterOptions;
  readonly #sink: AdapterSink;
  readonly #normalizer = new CodexNormalizer();
  readonly #broker = new PermissionBroker();
  readonly #asks = new Map<string, AskEntry>();
  readonly #stderr = new StderrTail();
  #transport: CodexTransport | undefined;
  #peer: JsonRpcPeer | undefined;
  #threadId: string | null;
  #codexTurnId: string | null = null;
  #capabilities: AgentCapabilities | undefined;
  #settings: SessionSettings;
  #pending: Partial<
    Pick<TurnStartParams, 'model' | 'effort' | 'approvalPolicy' | 'sandboxPolicy'>
  > = {};
  #running = false;
  /** Interromper chegou antes de se saber o id do turno: manda-se assim que se souber. */
  #interruptPending = false;
  #closing = false;
  #crashed = false;

  constructor(options: CodexAdapterOptions, sink: AdapterSink) {
    this.#options = options;
    this.#sink = sink;
    this.#threadId = options.resume ?? null;
    this.#settings = {
      model: options.model ?? null,
      effort: options.effort ?? null,
      mode: options.mode ?? DEFAULT_CODEX_MODE,
    };
  }

  agentSessionId(): string | null {
    return this.#threadId;
  }

  capabilities(): AgentCapabilities {
    if (!this.#capabilities) throw new Error('A sessão ainda não arrancou');
    return this.#capabilities;
  }

  async start(): Promise<AgentStartResult> {
    this.#sink.state('starting');
    const transport = (this.#options.transport ?? (() => this.#spawn()))();
    this.#transport = transport;
    transport.stderr?.on('data', (chunk: Buffer) => this.#stderr.push(chunk));
    const peer = new JsonRpcPeer({
      input: transport.input,
      output: transport.output,
      jsonrpc: false,
    });
    this.#peer = peer;
    peer.onNotification((method, params) => this.#onNotification(method, params));
    for (const method of [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'execCommandApproval',
      'applyPatchApproval',
    ] as const) {
      peer.onRequest(method, (params, id) => this.#approval(method, params, id));
    }
    peer.onRequest('mcpServer/elicitation/request', (params, id) =>
      this.#elicitation(params as McpServerElicitationRequestParams, id),
    );
    peer.onRequest('item/tool/requestUserInput', () => {
      this.#notice('O Codex fez uma pergunta que a Solline ainda não mostra; ficou sem resposta.');
      return { answers: {} };
    });
    void peer.closed.then((reason) => {
      if (!this.#closing) this.#crash(reason);
    });

    try {
      await initializeCodex(peer, START_TIMEOUT_MS);
      const account = await peer.request<GetAccountResponse>(
        'account/read',
        {},
        CONTROL_TIMEOUT_MS,
      );
      if (!account.account && account.requiresOpenaiAuth) throw new Error(CODEX_LOGIN_MESSAGE);
      const list = await peer.request<ModelListResponse>('model/list', {}, CONTROL_TIMEOUT_MS);
      const visible = list.data.filter((m) => !m.hidden);
      const models = visible.map(modelOption);
      const sandboxReady = await this.#sandboxReady(peer);
      // Sem o sandbox do Windows, só o Ask é seguro: ler e Auto dependem dele.
      const modes = CODEX_MODES.filter((m) => sandboxReady || m.id === 'ask');
      this.#capabilities = {
        models,
        modes,
        effort: models.some((m) => m.efforts.length > 0),
        effortOrder: effortOrder(models),
        features: { cost: false, context: true, resume: true },
      };
      if (!modes.some((m) => m.id === this.#settings.mode))
        this.#settings.mode = DEFAULT_CODEX_MODE;
      const model =
        this.#settings.model ?? visible.find((m) => m.isDefault)?.id ?? visible[0]?.id ?? null;
      const policy = threadPolicy(this.#settings.mode);
      // Os servidores MCP desta sessão vão na config do thread, nunca no config.toml.
      const config = mcpServersConfig(this.#options.mcpServers ?? []);
      const params = {
        cwd: this.#options.cwd,
        ...(model ? { model } : {}),
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        ...(config ? { config } : {}),
      };
      const started = this.#threadId
        ? await peer.request<ThreadStartResponse>(
            'thread/resume',
            { threadId: this.#threadId, ...params, excludeTurns: true },
            START_TIMEOUT_MS,
          )
        : await peer.request<ThreadStartResponse>('thread/start', params, START_TIMEOUT_MS);
      this.#threadId = started.thread.id;
      this.#settings.model = started.model ?? model;
      if (this.#settings.effort) this.#pending.effort = this.#settings.effort;
      else this.#settings.effort = started.reasoningEffort ?? null;
      if (!sandboxReady) {
        this.#notice('O sandbox do Windows não está pronto: o Codex pede autorização para tudo.');
      }
    } catch (error) {
      this.#closing = true;
      peer.close();
      await transport.kill();
      throw new Error(this.#withStderr(error), { cause: error });
    }
    this.#emit([
      { type: 'meta', agentSessionId: this.#threadId },
      { type: 'settings', settings: { ...this.#settings } },
    ]);
    this.#sink.state('idle');
    return { settings: { ...this.#settings }, capabilities: this.capabilities() };
  }

  async send(text: string): Promise<string> {
    const peer = this.#peer;
    if (!peer || peer.isClosed || this.#crashed || !this.#threadId) {
      throw new Error('A sessão não está ligada');
    }
    const turnId = crypto.randomUUID();
    this.#emit(this.#normalizer.userTurn(turnId, text));
    this.#running = true;
    this.#sink.state('running');
    this.#interruptPending = false;
    const sent = this.#pending;
    const params: TurnStartParams = {
      threadId: this.#threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      ...sent,
    };
    this.#pending = {};
    peer
      .request<TurnStartResponse>('turn/start', params, CONTROL_TIMEOUT_MS)
      .then((response) => {
        this.#turnKnown(response.turn.id);
      })
      .catch((error: unknown) => {
        if (this.#crashed || this.#closing) return;
        // O que não chegou ao Codex vai no turno seguinte; o que mudou entretanto ganha.
        this.#pending = { ...sent, ...this.#pending };
        const { turnId: assistant, deltas } = this.#normalizer.ensureAssistantTurn();
        this.#emit([
          ...deltas,
          errorNotice(assistant, `O Codex não aceitou a mensagem: ${String(error)}`),
          { type: 'turn.end', turnId: assistant, outcome: 'error' },
        ]);
        this.#running = false;
        this.#sink.state('idle');
      });
    return turnId;
  }

  async interrupt(): Promise<void> {
    const peer = this.#peer;
    if (!peer || !this.#running || !this.#threadId) return;
    this.#normalizer.markInterrupted();
    this.#broker.cancelAll('interrupt');
    if (!this.#codexTurnId) {
      this.#interruptPending = true;
      return;
    }
    await this.#sendInterrupt(this.#codexTurnId);
  }

  #sendInterrupt(turnId: string): Promise<unknown> {
    const peer = this.#peer;
    if (!peer || !this.#threadId) return Promise.resolve();
    return withTimeout(
      peer.request('turn/interrupt', { threadId: this.#threadId, turnId }),
      CONTROL_TIMEOUT_MS,
      'Interromper',
    );
  }

  #turnKnown(turnId: string): void {
    if (!this.#running) return;
    this.#codexTurnId = turnId;
    if (this.#interruptPending) {
      this.#interruptPending = false;
      void this.#sendInterrupt(turnId).catch((error: unknown) => {
        console.error(`[codex] interromper falhou: ${String(error)}`);
      });
    }
  }

  async setMode(mode: string): Promise<void> {
    if (!CODEX_MODES.some((m) => m.id === mode))
      throw new Error(`Modo desconhecido para o Codex: ${mode}`);
    Object.assign(this.#pending, turnOverrides(mode));
    this.#emit([{ type: 'settings', settings: { mode } }]);
  }

  async setModel(model: string): Promise<void> {
    this.#pending.model = model;
    this.#emit([{ type: 'settings', settings: { model } }]);
  }

  async setEffort(effort: string): Promise<void> {
    this.#pending.effort = effort;
    this.#emit([{ type: 'settings', settings: { effort } }]);
  }

  answerPermission(requestId: string, answer: PermissionAnswer): boolean {
    const entry = this.#asks.get(requestId);
    if (!entry) return false;
    if (answer.decision === 'allow-always' && !entry.block.canAlwaysAllow) {
      throw new Error('Este pedido não aceita "Permitir sempre"');
    }
    if (answer.decision === 'deny-always' || answer.decision === 'answer') {
      throw new Error('O Codex não aceita esta resposta a um pedido de autorização');
    }
    return this.#broker.answer(requestId, answer);
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#broker.cancelAll('closed');
    const transport = this.#transport;
    this.#peer?.close();
    if (!transport) return;
    transport.output.end();
    await withTimeout(transport.exited, 5_000, 'Fechar o Codex').catch(() => undefined);
    await transport.kill();
  }

  #spawn(): CodexTransport {
    const executable = this.#options.executable;
    if (!executable) throw new Error('Não encontrei o codex.exe');
    return spawnCodex({
      executable,
      env: this.#options.env ?? {},
      cwd: this.#options.cwd,
      stderr: this.#stderr,
    });
  }

  async #sandboxReady(peer: JsonRpcPeer): Promise<boolean> {
    if (process.platform !== 'win32') return true;
    try {
      const readiness = await peer.request<WindowsSandboxReadinessResponse>(
        'windowsSandbox/readiness',
        undefined,
        CONTROL_TIMEOUT_MS,
      );
      return readiness.status === 'ready';
    } catch {
      return false;
    }
  }

  #onNotification(method: string, params: unknown): void {
    if (method === 'serverRequest/resolved') {
      const requestId = (params as { requestId?: RequestId }).requestId;
      for (const [id, entry] of this.#asks) {
        if (entry.rpcId === requestId) this.#broker.cancel(id, 'resolved');
      }
      return;
    }
    if (method === 'turn/started') {
      const id = (params as { turn?: { id?: string } }).turn?.id;
      if (id) this.#turnKnown(id);
    }
    this.#emit(this.#normalizer.push(method, params));
    if (method === 'turn/completed') {
      this.#running = false;
      this.#interruptPending = false;
      this.#codexTurnId = null;
      if (this.#asks.size === 0) this.#sink.state('idle');
    }
  }

  async #approval(method: ApprovalMethod, params: unknown, rpcId: RequestId): Promise<unknown> {
    const outcome = await this.#ask(this.#approvalBlock(method, params, rpcId), rpcId);
    return { decision: codexDecision(method, outcome) };
  }

  /**
   * As ferramentas MCP pedem autorização por elicitação. Outras elicitações (formulários,
   * endereços) a Solline ainda não mostra e recusa com um aviso.
   */
  async #elicitation(
    params: McpServerElicitationRequestParams,
    rpcId: RequestId,
  ): Promise<unknown> {
    const approval = mcpToolApproval(params);
    if (!approval) {
      this.#notice(
        'Um servidor MCP do Codex pediu dados que a Solline ainda não mostra; foi recusado.',
      );
      return { action: 'decline', content: null, _meta: null };
    }
    // Um servidor desta sessão que corre programas pergunta sempre.
    const risky = (this.#options.mcpServers ?? []).some(
      (s) => s.executesCode && s.name === approval.server,
    );
    const id = `codex-${String(rpcId)}`;
    const block: PermissionBlock = {
      kind: 'permission',
      id,
      toolName: `mcp__${approval.server}__${approval.tool}`,
      toolUseId: id,
      title: approval.title,
      ...(approval.description ? { description: approval.description } : {}),
      input: approval.input,
      category: 'other',
      canAlwaysAllow: !risky && approval.persist.includes('session'),
      alwaysScope: 'session',
      canAlwaysDeny: false,
      defaultToNo: false,
      status: 'pending',
    };
    return mcpApprovalResponse(await this.#ask(block, rpcId));
  }

  async #ask(block: PermissionBlock, rpcId: RequestId): Promise<BrokerOutcome> {
    const { turnId, deltas } = this.#normalizer.ensureAssistantTurn();
    this.#emit(deltas);
    this.#asks.set(block.id, { turnId, block, rpcId });
    this.#sink.ask(turnId, block);
    this.#sink.state('needs-you');
    const outcome = await this.#broker.wait(block.id);
    this.#asks.delete(block.id);
    const status: AskBlock['status'] =
      outcome.decision === 'allow-once'
        ? 'allowed'
        : outcome.decision === 'allow-always'
          ? 'allowed-always'
          : outcome.decision === 'cancelled'
            ? 'cancelled'
            : 'denied';
    this.#emit([{ type: 'block.upsert', turnId, block: { ...block, status } }]);
    if (!this.#crashed) {
      this.#sink.state(this.#asks.size > 0 ? 'needs-you' : this.#running ? 'running' : 'idle');
    }
    return outcome;
  }

  #approvalBlock(method: ApprovalMethod, params: unknown, rpcId: RequestId): PermissionBlock {
    const id = `codex-${String(rpcId)}`;
    const base = {
      kind: 'permission' as const,
      id,
      // O Codex guarda o "sempre" só nesta sessão (acceptForSession).
      canAlwaysAllow: true,
      alwaysScope: 'session' as const,
      canAlwaysDeny: false,
      defaultToNo: false,
      status: 'pending' as const,
    };
    if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      const p = params as FileChangeRequestApprovalParams;
      const item = p.itemId ? this.#normalizer.fileChange(p.itemId) : undefined;
      const changes = item?.changes ?? [];
      return {
        ...base,
        toolName: 'apply_patch',
        toolUseId: p.itemId ?? id,
        title:
          changes.length === 1 && changes[0]
            ? `Editar ${changes[0].path.split(/[\\/]/).at(-1)}`
            : `Editar ${changes.length || 'os'} ficheiros`,
        ...(p.reason ? { description: p.reason } : {}),
        input: { changes: changes.map((c) => ({ path: c.path, kind: c.kind.type })) },
        category: 'edit',
        content: changes.map((c) => ({ type: 'patch' as const, path: c.path, unified: c.diff })),
      };
    }
    const p = params as CommandExecutionRequestApprovalParams & { command?: string | string[] };
    const raw = Array.isArray(p.command) ? p.command.join(' ') : (p.command ?? '');
    const item = p.itemId ? this.#normalizer.command(p.itemId) : undefined;
    const command = displayCommand(raw || item?.command || '', p.commandActions ?? []);
    return {
      ...base,
      toolName: 'shell',
      toolUseId: p.itemId ?? id,
      title: command ? `Correr ${clip(command, 70)}` : 'Correr um comando',
      ...(p.reason ? { description: p.reason } : {}),
      input: { command, cwd: p.cwd ?? null },
      category: 'execute',
      content: [{ type: 'command' as const, command, ...(p.cwd ? { cwd: p.cwd } : {}) }],
    };
  }

  #notice(text: string): void {
    const { turnId, deltas } = this.#normalizer.ensureAssistantTurn();
    this.#emit([
      ...deltas,
      {
        type: 'block.upsert',
        turnId,
        block: { kind: 'notice', id: `${turnId}:${crypto.randomUUID()}`, tone: 'info', text },
      },
    ]);
  }

  #emit(deltas: ConversationDelta[]): void {
    for (const delta of deltas) {
      if (delta.type === 'settings') Object.assign(this.#settings, delta.settings);
      this.#sink.delta(delta);
    }
  }

  #crash(error: unknown): void {
    if (this.#crashed || this.#closing) return;
    this.#crashed = true;
    this.#running = false;
    console.error(`[codex] sessão caiu: ${this.#withStderr(error)}`);
    this.#broker.cancelAll('crashed');
    this.#sink.state('error', crashMessage('Codex'));
  }

  #withStderr(error: unknown): string {
    const reason = error instanceof Error ? error.message : String(error);
    const tail = this.#stderr.tail();
    return tail ? `${reason}\n${tail}` : reason;
  }
}
