import type { Readable, Writable } from 'node:stream';
import type {
  InitializeResponse,
  NewSessionResponse,
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type {
  AgentCapabilities,
  ConversationDelta,
  PermissionAnswer,
  ModeRisk,
  PermissionBlock,
  SessionSettings,
} from '@solline/protocol';
import { APP_NAME, CLIENT_APP_ID } from '@solline/protocol/app';
import type { BrokerOutcome } from '../../permission-broker.ts';
import { JsonRpcPeer, RpcError, StderrTail, type RequestId } from '../../rpc/json-rpc.ts';
import { killTree, spawnAgent } from '../../rpc/spawn.ts';
import { ENGINE_VERSION } from '../../version.ts';
import { SessionShell } from '../shared/session-shell.ts';
import { crashMessage, withContext, withTimeout } from '../shared/turns.ts';
import type {
  AdapterSink,
  AgentAdapter,
  AgentStartOptions,
  AgentStartResult,
  SendOptions,
} from '../types.ts';
import {
  acpConfig,
  acpSettings,
  capabilitiesFromAcp,
  classifyModeRisk,
  modeChoices,
  safestMode,
  type AcpConfig,
} from './capabilities.ts';
import { AcpNormalizer } from './normalizer.ts';

/** A versão do ACP que a Solline fala (v1 estável). */
export const ACP_PROTOCOL_VERSION = 1;

export interface AcpTransport {
  input: Readable;
  output: Writable;
  stderr?: Readable | undefined;
  exited: Promise<unknown>;
  kill(): Promise<void>;
}

export interface AcpAdapterOptions extends AgentStartOptions {
  /** Nome do agente para as mensagens ("OpenCode"). */
  label: string;
  command?: string | undefined;
  args?: readonly string[] | undefined;
  /** Como entrar, quando o agente pede autenticação ("opencode auth login"). */
  loginHint?: string | undefined;
  /** Para testes: liga a outro transporte em vez de arrancar o processo. */
  transport?: (() => AcpTransport) | undefined;
}

const START_TIMEOUT_MS = 60_000;
const CONTROL_TIMEOUT_MS = 30_000;

/** A resposta da interface como opção do agente: a primeira do tipo pedido. */
export function acpOutcome(
  options: readonly PermissionOption[],
  outcome: BrokerOutcome,
): RequestPermissionResponse {
  const kind =
    outcome.decision === 'allow-once'
      ? 'allow_once'
      : outcome.decision === 'allow-always'
        ? 'allow_always'
        : outcome.decision === 'deny-always'
          ? 'reject_always'
          : outcome.decision === 'deny' || outcome.decision === 'answer'
            ? 'reject_once'
            : null;
  const option =
    (kind && options.find((o) => o.kind === kind)) ??
    (kind === 'reject_once' || kind === 'reject_always'
      ? options.find((o) => o.kind.startsWith('reject'))
      : undefined);
  if (!option) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId: option.optionId } };
}

function isAuthRequired(error: unknown): boolean {
  return (
    (error instanceof RpcError && (error.code === -32000 || /auth/i.test(error.message))) ||
    /auth[_ ]?required|authenticat/i.test(String(error))
  );
}

/**
 * Um agente qualquer que fale ACP v1 por stdio. Não anuncia fs nem terminal: o agente faz o
 * trabalho dele e a Solline mostra e aprova.
 */
export class AcpAdapter implements AgentAdapter {
  readonly #options: AcpAdapterOptions;
  readonly #sink: AdapterSink;
  readonly #normalizer = new AcpNormalizer();
  readonly #stderr = new StderrTail();
  #transport: AcpTransport | undefined;
  #peer: JsonRpcPeer | undefined;
  #sessionId: string | null;
  #init: InitializeResponse | undefined;
  #config: AcpConfig = {};
  #capabilities: AgentCapabilities | undefined;
  #settings: SessionSettings;
  /** Os pedidos, as quedas e o estado da sessão (as opções do agente ficam com cada pedido). */
  readonly #shell: SessionShell<PermissionOption[]>;
  /** Um servidor MCP ligado corre programas: sem Auto e sem "Permitir sempre" na sessão. */
  readonly #restricted: boolean;

  constructor(options: AcpAdapterOptions, sink: AdapterSink) {
    this.#restricted = (options.mcpServers ?? []).some((s) => s.executesCode);
    this.#options = options;
    this.#sink = sink;
    this.#shell = new SessionShell(sink);
    this.#sessionId = options.resume ?? null;
    this.#settings = {
      model: options.model ?? null,
      effort: options.effort ?? null,
      mode: options.mode,
    };
  }

  agentSessionId(): string | null {
    return this.#sessionId;
  }

  capabilities(): AgentCapabilities {
    if (!this.#capabilities) throw new Error('A sessão ainda não arrancou');
    return this.#capabilities;
  }

  async start(): Promise<AgentStartResult> {
    this.#shell.starting();
    const transport = (this.#options.transport ?? (() => this.#spawn()))();
    this.#transport = transport;
    transport.stderr?.on('data', (chunk: Buffer) => this.#stderr.push(chunk));
    const peer = new JsonRpcPeer({
      input: transport.input,
      output: transport.output,
      jsonrpc: true,
    });
    this.#peer = peer;
    peer.onNotification((method, params) => {
      if (method === 'session/update') this.#onUpdate(params as SessionNotification);
    });
    peer.onRequest('session/request_permission', (params) =>
      this.#permission(params as RequestPermissionRequest),
    );
    void peer.closed.then((reason) => {
      if (!this.#shell.closing) this.#crash(reason);
    });

    try {
      const init = await peer.request<InitializeResponse>(
        'initialize',
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: CLIENT_APP_ID, title: APP_NAME, version: ENGINE_VERSION },
        },
        START_TIMEOUT_MS,
      );
      if (init.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new Error(
          `O ${this.#options.label} fala ACP v${init.protocolVersion}; a Solline fala v${ACP_PROTOCOL_VERSION}`,
        );
      }
      this.#init = init;
      const session = await this.#openSession(peer, init);
      this.#config = acpConfig(session);
      this.#refreshCapabilities();
      Object.assign(this.#settings, acpSettings(this.#config));
      await this.#leaveFullAccess(peer);
      await this.#applyRequested(peer);
    } catch (error) {
      this.#shell.close();
      peer.close();
      await transport.kill();
      if (isAuthRequired(error)) {
        const hint = this.#options.loginHint ? ` Entra com: ${this.#options.loginHint}` : '';
        throw new Error(`O ${this.#options.label} pede para iniciares sessão.${hint}`, {
          cause: error,
        });
      }
      throw new Error(this.#withStderr(error), { cause: error });
    }
    this.#emit([
      ...(this.#sessionId ? [{ type: 'meta' as const, agentSessionId: this.#sessionId }] : []),
      { type: 'settings', settings: { ...this.#settings } },
    ]);
    this.#shell.ready();
    return { settings: { ...this.#settings }, capabilities: this.capabilities() };
  }

  async send(text: string, options: SendOptions = {}): Promise<string> {
    const peer = this.#peer;
    if (!peer || peer.isClosed || this.#shell.crashed || !this.#sessionId) {
      throw new Error('A sessão não está ligada');
    }
    const turnId = options.turnId ?? crypto.randomUUID();
    this.#emit(this.#normalizer.userTurn(turnId, text));
    this.#shell.turnStarted();
    // O session/prompt só responde no fim do turno (com o stopReason): não se espera aqui.
    peer
      .request<PromptResponse>('session/prompt', {
        sessionId: this.#sessionId,
        prompt: [{ type: 'text', text: withContext(text, options.context) }],
      })
      .then(
        (response) => this.#endTurn(response.stopReason),
        (error: unknown) => {
          if (!this.#shell.crashed && !this.#shell.closing) this.#endTurn('error', String(error));
        },
      );
    return turnId;
  }

  async interrupt(): Promise<void> {
    if (!this.#peer || !this.#shell.running || !this.#sessionId) return;
    this.#normalizer.markInterrupted();
    this.#shell.interrupted();
    this.#peer.notify('session/cancel', { sessionId: this.#sessionId });
  }

  async setMode(mode: string): Promise<void> {
    const peer = this.#require();
    if (this.#config.mode) await this.#setConfig(peer, this.#config.mode.id, mode);
    else
      await withTimeout(
        peer.request('session/set_mode', { sessionId: this.#sessionId, modeId: mode }),
        CONTROL_TIMEOUT_MS,
        'Mudar o modo',
      );
    this.#emit([{ type: 'settings', settings: { mode } }]);
  }

  async setModel(model: string): Promise<void> {
    const peer = this.#require();
    if (this.#config.model) await this.#setConfig(peer, this.#config.model.id, model);
    else
      await withTimeout(
        peer.request('session/set_model', { sessionId: this.#sessionId, modelId: model }),
        CONTROL_TIMEOUT_MS,
        'Mudar o modelo',
      );
    this.#emit([{ type: 'settings', settings: { model } }]);
  }

  async setEffort(effort: string): Promise<void> {
    const peer = this.#require();
    if (!this.#config.effort) throw new Error(`O ${this.#options.label} não tem níveis de effort`);
    await this.#setConfig(peer, this.#config.effort.id, effort);
    this.#emit([{ type: 'settings', settings: { effort } }]);
  }

  answerPermission(requestId: string, answer: PermissionAnswer): boolean {
    return this.#shell.answer(requestId, answer);
  }

  async close(): Promise<void> {
    this.#shell.close();
    const transport = this.#transport;
    const peer = this.#peer;
    if (
      peer &&
      !peer.isClosed &&
      this.#sessionId &&
      this.#init?.agentCapabilities?.sessionCapabilities?.close
    ) {
      await withTimeout(
        peer.request('session/close', { sessionId: this.#sessionId }),
        3_000,
        'Fechar a sessão',
      ).catch(() => undefined);
    }
    peer?.close();
    if (!transport) return;
    transport.output.end();
    await withTimeout(transport.exited, 5_000, `Fechar o ${this.#options.label}`).catch(
      () => undefined,
    );
    await transport.kill();
  }

  async #openSession(peer: JsonRpcPeer, init: InitializeResponse): Promise<NewSessionResponse> {
    const base = {
      cwd: this.#options.cwd,
      mcpServers: (this.#options.mcpServers ?? []).map((s) => ({
        name: s.name,
        command: s.command,
        args: [...s.args],
        env: Object.entries(s.env).map(([name, value]) => ({ name, value })),
      })),
    };
    if (!this.#sessionId) {
      const created = await peer.request<NewSessionResponse>('session/new', base, START_TIMEOUT_MS);
      this.#sessionId = created.sessionId;
      return created;
    }
    const caps = init.agentCapabilities;
    if (caps?.sessionCapabilities?.resume) {
      const resumed = await peer.request<Partial<NewSessionResponse>>(
        'session/resume',
        { sessionId: this.#sessionId, ...base },
        START_TIMEOUT_MS,
      );
      return { sessionId: this.#sessionId, ...resumed };
    }
    if (caps?.loadSession) {
      // O load repete o histórico em session/update: a Solline já o tem desenhado.
      this.#normalizer.replaying = true;
      try {
        const loaded = await peer.request<Partial<NewSessionResponse>>(
          'session/load',
          { sessionId: this.#sessionId, ...base },
          START_TIMEOUT_MS,
        );
        return { sessionId: this.#sessionId, ...loaded };
      } finally {
        this.#normalizer.replaying = false;
      }
    }
    throw new Error(`O ${this.#options.label} não sabe retomar sessões`);
  }

  #avoided(risk: ModeRisk): boolean {
    return risk === 'full' || (this.#restricted && risk === 'auto');
  }

  /** O risco do modo em uso, pelo id e pelo nome que o agente lhe dá. */
  #currentRisk(): ModeRisk | null {
    const current = this.#settings.mode;
    if (!current) return null;
    const name = this.#config.mode
      ? (modeChoices(this.#config.mode).find((o) => o.value === current)?.name ?? current)
      : (this.#config.legacyModes?.availableModes.find((m) => m.id === current)?.name ?? current);
    return classifyModeRisk(current, name);
  }

  /**
   * Um agente em acesso total (ou em Auto, com um servidor MCP que corre programas) passa
   * para o modo mais fechado que tiver. Corre no arranque e sempre que o agente muda os modos.
   */
  async #leaveFullAccess(peer: JsonRpcPeer): Promise<void> {
    const risk = this.#currentRisk();
    if (!risk || !this.#avoided(risk)) return;
    const safe = safestMode(this.capabilities().modes.filter((m) => !this.#avoided(m.risk)));
    if (!safe) throw new Error(`O ${this.#options.label} só oferece modos sem perguntas`);
    if (this.#config.mode) await this.#setConfig(peer, this.#config.mode.id, safe.id);
    else
      await peer.request(
        'session/set_mode',
        { sessionId: this.#sessionId, modeId: safe.id },
        CONTROL_TIMEOUT_MS,
      );
    this.#settings.mode = safe.id;
  }

  /** Modo, modelo e effort pedidos na criação (ou guardados na retoma). */
  async #applyRequested(peer: JsonRpcPeer): Promise<void> {
    const { mode, model, effort } = this.#options;
    const caps = this.capabilities();
    const allowed = caps.modes.find((m) => m.id === mode);
    if (mode && mode !== this.#settings.mode && allowed && !this.#avoided(allowed.risk)) {
      if (this.#config.mode) await this.#setConfig(peer, this.#config.mode.id, mode);
      else
        await peer.request(
          'session/set_mode',
          { sessionId: this.#sessionId, modeId: mode },
          CONTROL_TIMEOUT_MS,
        );
      this.#settings.mode = mode;
    }
    if (model && model !== this.#settings.model && caps.models.some((m) => m.id === model)) {
      if (this.#config.model) await this.#setConfig(peer, this.#config.model.id, model);
      else
        await peer.request(
          'session/set_model',
          { sessionId: this.#sessionId, modelId: model },
          CONTROL_TIMEOUT_MS,
        );
      this.#settings.model = model;
    }
    if (
      effort &&
      effort !== this.#settings.effort &&
      this.#config.effort &&
      caps.effortOrder.includes(effort)
    ) {
      await this.#setConfig(peer, this.#config.effort.id, effort);
      this.#settings.effort = effort;
    }
  }

  async #setConfig(peer: JsonRpcPeer, configId: string, value: string): Promise<void> {
    const response = await withTimeout(
      peer.request<{ configOptions?: SessionConfigOption[] }>('session/set_config_option', {
        sessionId: this.#sessionId,
        configId,
        value,
      }),
      CONTROL_TIMEOUT_MS,
      'Mudar a configuração',
    );
    if (response?.configOptions) this.#updateConfig(response.configOptions);
  }

  #updateConfig(options: SessionConfigOption[]): void {
    const next = acpConfig({ configOptions: options });
    this.#config = { ...this.#config, mode: next.mode, model: next.model, effort: next.effort };
    this.#refreshCapabilities();
    if (this.#capabilities)
      this.#emit([{ type: 'capabilities', capabilities: this.#capabilities }]);
  }

  #refreshCapabilities(cost = this.#capabilities?.features.cost ?? false): void {
    const caps = this.#init?.agentCapabilities;
    this.#capabilities = capabilitiesFromAcp(this.#config, {
      resume: Boolean(caps?.sessionCapabilities?.resume || caps?.loadSession),
      cost,
    });
  }

  #onUpdate(notification: SessionNotification): void {
    if (notification.sessionId !== this.#sessionId) return;
    const update = notification.update;
    if (update.sessionUpdate === 'config_option_update') {
      this.#updateConfig(update.configOptions);
      Object.assign(this.#settings, acpSettings(this.#config));
      this.#emit([{ type: 'settings', settings: { ...this.#settings } }]);
      // O agente pode ter voltado sozinho a um modo sem perguntas.
      const peer = this.#peer;
      if (peer && !peer.isClosed) {
        void this.#leaveFullAccess(peer)
          .then(() => this.#emit([{ type: 'settings', settings: { mode: this.#settings.mode } }]))
          .catch((error: unknown) => {
            this.#notice(String(error));
            void this.close();
          });
      }
      return;
    }
    if (update.sessionUpdate === 'current_mode_update') {
      this.#settings.mode = update.currentModeId;
      const peer = this.#peer;
      if (peer && !peer.isClosed) void this.#leaveFullAccess(peer).catch(() => undefined);
    }
    // O primeiro custo em dólares liga o custo na interface.
    if (
      update.sessionUpdate === 'usage_update' &&
      update.cost?.currency === 'USD' &&
      !this.#capabilities?.features.cost
    ) {
      this.#refreshCapabilities(true);
      if (this.#capabilities)
        this.#emit([{ type: 'capabilities', capabilities: this.#capabilities }]);
    }
    this.#emit(this.#normalizer.push(update));
  }

  async #permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const { turnId, deltas } = this.#normalizer.ensureAssistantTurn();
    this.#emit(deltas);
    const known = this.#normalizer.tool(request.toolCall.toolCallId);
    const allowAlways = request.options.find((o) => o.kind === 'allow_always');
    const rejectAlways = request.options.find((o) => o.kind === 'reject_always');
    const id = `acp-${crypto.randomUUID()}`;
    const content = known?.content;
    const block: PermissionBlock = {
      kind: 'permission',
      id,
      toolName: request.toolCall.name ?? known?.name ?? request.toolCall.kind ?? 'tool',
      toolUseId: request.toolCall.toolCallId,
      title: request.toolCall.title ?? known?.summary ?? 'Pedido de autorização',
      input: request.toolCall.rawInput ?? known?.input ?? {},
      canAlwaysAllow: Boolean(allowAlways) && !this.#restricted,
      canAlwaysDeny: Boolean(rejectAlways),
      ...(allowAlways && !this.#restricted ? { allowAlwaysLabel: allowAlways.name } : {}),
      ...(rejectAlways ? { denyAlwaysLabel: rejectAlways.name } : {}),
      defaultToNo: false,
      ...((request.toolCall.kind ?? known?.category)
        ? { category: request.toolCall.kind ?? known?.category }
        : {}),
      ...(content ? { content } : {}),
      status: 'pending',
    };
    const outcome = await this.#shell.ask(turnId, block, request.options);
    return acpOutcome(request.options, outcome);
  }

  #endTurn(stopReason: PromptResponse['stopReason'] | 'error', message?: string): void {
    this.#emit(this.#normalizer.end(stopReason, message));
    this.#shell.turnEnded({ cancelAsks: true });
  }

  #spawn(): AcpTransport {
    const command = this.#options.command;
    if (!command) throw new Error(`Não encontrei o ${this.#options.label}`);
    const child = spawnAgent({
      command,
      args: this.#options.args ?? [],
      env: this.#options.env ?? {},
      cwd: this.#options.cwd,
    });
    const exited = new Promise((resolve) => {
      child.on('exit', resolve);
      child.on('error', (error) => {
        this.#stderr.push(String(error));
        child.stdout.destroy();
        resolve(error);
      });
    });
    return {
      input: child.stdout,
      output: child.stdin,
      stderr: child.stderr,
      exited,
      kill: () => killTree(child.pid),
    };
  }

  #require(): JsonRpcPeer {
    if (!this.#peer || this.#peer.isClosed || this.#shell.crashed || !this.#sessionId) {
      throw new Error('A sessão não está ligada');
    }
    return this.#peer;
  }

  #notice(text: string): void {
    const { turnId, deltas } = this.#normalizer.ensureAssistantTurn();
    this.#emit([
      ...deltas,
      {
        type: 'block.upsert',
        turnId,
        block: { kind: 'notice', id: `${turnId}:${crypto.randomUUID()}`, tone: 'error', text },
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
    if (!this.#shell.crash(crashMessage(this.#options.label))) return;
    console.error(`[acp] ${this.#options.label} caiu: ${this.#withStderr(error)}`);
  }

  #withStderr(error: unknown): string {
    const reason = error instanceof Error ? error.message : String(error);
    const tail = this.#stderr.tail();
    return tail ? `${reason}\n${tail}` : reason;
  }
}

export type { RequestId };
