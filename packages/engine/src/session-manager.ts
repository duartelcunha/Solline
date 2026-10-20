import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  findModel,
  type AgentCapabilities,
  type EngineCommandResult,
  type EngineEvent,
  type PermissionAnswer,
  type SessionInfo,
  type SessionStartPayload,
} from '@solline/protocol';
import type { AgentAdapter, AdapterSink, McpServerLaunch } from './adapters/types.ts';
import type { AgentDefinition, AgentRegistry } from './agents/registry.ts';
import { SECRET_NAME, agentEnv } from './env.ts';
import { safestMode } from './adapters/acp/capabilities.ts';
import type { McpCatalog } from './mcp/catalog.ts';

/** Com um servidor MCP que corre programas ligado, nada de modos sem perguntas. */
const RESTRICTED_RISKS = new Set(['auto', 'full']);

function restrict(capabilities: AgentCapabilities, restricted: boolean): AgentCapabilities {
  if (!restricted) return capabilities;
  return {
    ...capabilities,
    modes: capabilities.modes.filter((m) => !RESTRICTED_RISKS.has(m.risk)),
  };
}

type SessionResult = EngineCommandResult<'session.start'>;

/** A pasta tem de ser absoluta e existir; o main já a tirou de um projeto conhecido. */
async function defaultCheckCwd(cwd: string): Promise<void> {
  if (!isAbsolute(cwd)) throw new Error('A pasta da sessão tem de ser um caminho absoluto');
  const isDir = await stat(cwd).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!isDir) throw new Error('A pasta do projeto já não existe');
}

interface Entry {
  info: SessionInfo;
  adapter: AgentAdapter;
  definition: AgentDefinition;
  trusted: boolean;
  mcp: readonly McpServerLaunch[];
}

/**
 * Todas as conversas vivas do motor. Cada uma tem o seu adaptador; o que o adaptador
 * conta passa a eventos da Ponte com o id da sessão.
 * shortcut: as sessões só vivem em memória e desaparecem ao fechar a app; o M3 traz o
 * histórico (listSessions/getSessionMessages).
 */
export class SessionManager {
  readonly #sessions = new Map<string, Entry>();
  readonly #emit: (event: EngineEvent) => void;
  readonly #registry: AgentRegistry;
  readonly #mcp: McpCatalog | undefined;
  readonly #checkCwd: (cwd: string) => Promise<void>;

  constructor(options: {
    emit: (event: EngineEvent) => void;
    /** Os agentes que se podem abrir: modos, ambiente e adaptador de cada um. */
    registry: AgentRegistry;
    /** Servidores MCP que uma sessão pode pedir. */
    mcp?: McpCatalog | undefined;
    /** Para testes: troca a verificação da pasta. */
    checkCwd?: (cwd: string) => Promise<void>;
  }) {
    this.#emit = options.emit;
    this.#registry = options.registry;
    this.#mcp = options.mcp;
    this.#checkCwd = options.checkCwd ?? defaultCheckCwd;
  }

  async create(payload: SessionStartPayload): Promise<SessionResult> {
    const definition = this.#registry.get(payload.agent);
    if (!definition) throw new Error(`Agente desconhecido: ${payload.agent}`);
    if (!payload.trusted && definition.untrustedProjects === 'refused') {
      throw new Error(`O ${definition.label} só corre em projetos de confiança`);
    }
    await this.#checkCwd(payload.cwd);
    const known = definition.staticModes;
    if (payload.mode && known.length > 0 && !known.some((m) => m.id === payload.mode)) {
      throw new Error(`Modo desconhecido para este agente: ${payload.mode}`);
    }
    const mcp = await this.#mcpFor(definition, payload.mcpServerIds ?? []);
    const restricted = mcp.some((s) => s.executesCode);
    const risk = known.find((m) => m.id === payload.mode)?.risk;
    if (restricted && risk && RESTRICTED_RISKS.has(risk)) {
      throw new Error(
        'Com um servidor MCP que corre programas, escolhe um modo que pergunte antes',
      );
    }
    const info: SessionInfo = {
      id: crypto.randomUUID(),
      projectId: payload.projectId,
      agent: payload.agent,
      cwd: payload.cwd,
      // O título vem da primeira mensagem, na interface.
      title: 'Nova sessão',
      state: 'starting',
      settings: {
        model: payload.model ?? null,
        effort: payload.effort ?? null,
        mode: payload.mode ?? definition.defaultMode,
      },
      agentSessionId: null,
      ...(mcp.length ? { mcpServers: payload.mcpServerIds ?? [] } : {}),
    };
    return this.#start(info, definition, payload.trusted, mcp, undefined, {
      model: payload.model,
      effort: payload.effort,
    });
  }

  /**
   * A confiança de um projeto mudou no main. As sessões abertas continuam como arrancaram;
   * a próxima retoma já usa a confiança nova, para os dois lados.
   */
  setProjectTrust(projectId: string, trusted: boolean): void {
    for (const entry of this.#sessions.values()) {
      if (entry.info.projectId === projectId) entry.trusted = trusted;
    }
  }

  /** Abre de novo uma sessão que caiu, com resume no agente e as mesmas definições. */
  async resume(sessionId: string): Promise<SessionResult> {
    const entry = this.#get(sessionId);
    const resumeId = entry.adapter.agentSessionId();
    if (!resumeId) throw new Error('Esta sessão ainda não tem histórico no agente para retomar');
    await entry.adapter.close();
    return this.#start(entry.info, entry.definition, entry.trusted, entry.mcp, resumeId);
  }

  send(sessionId: string, text: string): Promise<string> {
    return this.#get(sessionId).adapter.send(text);
  }

  interrupt(sessionId: string): Promise<void> {
    return this.#get(sessionId).adapter.interrupt();
  }

  /** Modo, modelo e effort só passam se o agente os anunciou nas capacidades. */
  async setMode(sessionId: string, mode: string): Promise<void> {
    const { adapter, mcp } = this.#get(sessionId);
    const modes = restrict(
      adapter.capabilities(),
      mcp.some((s) => s.executesCode),
    ).modes;
    if (!modes.some((m) => m.id === mode)) {
      throw new Error(`Modo desconhecido para este agente: ${mode}`);
    }
    await adapter.setMode(mode);
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const { adapter } = this.#get(sessionId);
    if (!findModel(adapter.capabilities().models, model)) {
      throw new Error(`Modelo desconhecido para este agente: ${model}`);
    }
    await adapter.setModel(model);
  }

  async setEffort(sessionId: string, effort: string): Promise<void> {
    const { adapter, info } = this.#get(sessionId);
    const capabilities = adapter.capabilities();
    if (!adapter.setEffort || !capabilities.effort) {
      throw new Error('Este agente não tem níveis de effort');
    }
    const model = findModel(capabilities.models, info.settings.model);
    const allowed = model ? model.efforts : capabilities.models.flatMap((m) => m.efforts);
    if (!allowed.includes(effort)) {
      throw new Error(`Este modelo não tem o effort ${effort}`);
    }
    await adapter.setEffort(effort);
  }

  answer(sessionId: string, requestId: string, answer: PermissionAnswer): void {
    const answered = this.#get(sessionId).adapter.answerPermission(requestId, answer);
    if (!answered) throw new Error('Este pedido já não está à espera de resposta');
  }

  async disposeAll(): Promise<void> {
    const entries = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(entries.map((entry) => entry.adapter.close()));
  }

  async #mcpFor(definition: AgentDefinition, ids: readonly string[]): Promise<McpServerLaunch[]> {
    if (ids.length === 0) return [];
    if (!definition.mcp)
      throw new Error(`O ${definition.label} ainda não aceita servidores MCP por sessão`);
    if (!this.#mcp) throw new Error('Não há servidores MCP configurados');
    const catalog = this.#mcp;
    return Promise.all(
      [...new Set(ids)].map(async (id) => {
        const s = await catalog.launch(id);
        return {
          name: s.name,
          command: s.command,
          args: s.args,
          env: s.env,
          executesCode: s.executesCode,
        };
      }),
    );
  }

  async #start(
    info: SessionInfo,
    definition: AgentDefinition,
    trusted: boolean,
    mcp: readonly McpServerLaunch[],
    resume?: string,
    /** Só numa sessão nova: o modelo e o effort pedidos têm de existir no agente. */
    requested?: { model?: string | undefined; effort?: string | undefined },
  ): Promise<SessionResult> {
    // Também na retoma: tirar a confiança a um projeto fecha-o a estes agentes.
    if (!trusted && definition.untrustedProjects === 'refused') {
      throw new Error(`O ${definition.label} só corre em projetos de confiança`);
    }
    const { model, effort, mode } = info.settings;
    const entry: Partial<Entry> = {};
    // Segredos só no arranque e só para este processo (por exemplo a chave de um fornecedor).
    const secrets = definition.secrets ? await definition.secrets() : {};
    const env = { ...agentEnv(definition.envPolicy), ...secrets };
    const adapter = definition.create(
      {
        cwd: info.cwd,
        model: model ?? undefined,
        effort: effort ?? undefined,
        mode,
        resume,
        projectTrusted: trusted,
        env,
        ...(mcp.length ? { mcpServers: mcp.map((s) => withoutSecrets(s, env)) } : {}),
      },
      this.#sinkFor(
        info,
        () => entry.adapter,
        mcp.some((s) => s.executesCode),
      ),
    );
    entry.adapter = adapter;
    const isNew = !this.#sessions.has(info.id);
    this.#sessions.set(info.id, { info, adapter, definition, trusted, mcp });
    const restricted = mcp.some((s) => s.executesCode);
    let started: Awaited<ReturnType<AgentAdapter['start']>> | undefined;
    try {
      started = await adapter.start();
      if (requested) checkRequested(started.capabilities, requested);
      info.settings = started.settings;
      info.state = 'idle';
      // Um modo que o agente aceitou no arranque mas não anuncia (por exemplo Auto num modelo
      // sem suporte) volta ao modo por omissão: a interface nunca mostra um modo que não há.
      const fallback = definition.defaultMode;
      const visible = restrict(started.capabilities, restricted);
      const modes = visible.modes;
      if (info.settings.mode && !modes.some((m) => m.id === info.settings.mode)) {
        // Sem modo por omissão (agentes ACP), vai para o mais fechado que restar.
        const target =
          fallback && modes.some((m) => m.id === fallback) ? fallback : safestMode(modes)?.id;
        if (target && target !== info.settings.mode) {
          await adapter.setMode(target);
          info.settings = { ...info.settings, mode: target };
        } else if (restricted && !target) {
          throw new Error('Este agente não tem um modo que pergunte antes; tira o servidor MCP');
        }
      }
      return { session: { ...info }, capabilities: visible };
    } catch (error) {
      // O agente arrancou mas algo depois falhou: fecha-o, senão o processo ficava sem dono.
      if (started) await adapter.close().catch(() => undefined);
      // Uma sessão que nunca arrancou não fica; uma retomada fica, em erro, para tentar outra vez.
      if (isNew) this.#sessions.delete(info.id);
      throw error;
    }
  }

  #sinkFor(
    info: SessionInfo,
    adapter: () => AgentAdapter | undefined,
    restricted: boolean,
  ): AdapterSink {
    const emit = this.#emit;
    return {
      delta: (raw) => {
        const cleaned = withoutUnreportedCost(raw, adapter());
        const delta =
          cleaned.type === 'capabilities'
            ? { ...cleaned, capabilities: restrict(cleaned.capabilities, restricted) }
            : cleaned;
        if (delta.type === 'settings') info.settings = { ...info.settings, ...delta.settings };
        if (delta.type === 'meta') info.agentSessionId = delta.agentSessionId;
        emit({ kind: 'event', type: 'session.event', sessionId: info.id, delta });
      },
      state: (state, error) => {
        info.state = state;
        emit({
          kind: 'event',
          type: 'session.state',
          sessionId: info.id,
          state,
          ...(error ? { error } : {}),
        });
      },
      ask: (turnId, request) => {
        emit({ kind: 'event', type: 'permission.request', sessionId: info.id, turnId, request });
      },
    };
  }

  #get(sessionId: string): Entry {
    const entry = this.#sessions.get(sessionId);
    if (!entry) throw new Error('Sessão desconhecida (o motor pode ter reiniciado)');
    return entry;
  }
}

/**
 * Um agente que diz não reportar custo não mostra custo: se um valor aparecer na mesma, sai
 * antes de chegar à interface (por exemplo o preço do Claude num perfil com outro fornecedor).
 */
function withoutUnreportedCost(
  delta: Parameters<AdapterSink['delta']>[0],
  adapter: AgentAdapter | undefined,
): Parameters<AdapterSink['delta']>[0] {
  if (delta.type !== 'usage' || !adapter) return delta;
  let reportsCost: boolean;
  try {
    reportsCost = adapter.capabilities().features.cost;
  } catch {
    return delta;
  }
  if (reportsCost) return delta;
  const { costUsd: _cost, ...usage } = delta.usage;
  return {
    type: 'usage',
    usage: {
      ...usage,
      ...(usage.models ? { models: usage.models.map((m) => ({ ...m, costUsd: null })) } : {}),
    },
  };
}

/** O modelo e o effort de uma sessão nova têm de vir das capacidades, como no setModel/setEffort. */
function checkRequested(
  capabilities: AgentCapabilities,
  requested: { model?: string | undefined; effort?: string | undefined },
): void {
  const model = requested.model ? findModel(capabilities.models, requested.model) : undefined;
  if (requested.model && !model) {
    throw new Error(`Modelo desconhecido para este agente: ${requested.model}`);
  }
  if (!requested.effort) return;
  const allowed = model ? model.efforts : capabilities.models.flatMap((m) => m.efforts);
  if (!capabilities.effort || !allowed.includes(requested.effort)) {
    throw new Error(`Este modelo não tem o effort ${requested.effort}`);
  }
}

/**
 * O agente arranca os servidores MCP com o ambiente dele por baixo. Os segredos do agente
 * (chaves, tokens, o que vem da Anthropic) vão vazios para o servidor, que não precisa deles.
 */
function withoutSecrets(
  server: McpServerLaunch,
  agentEnvironment: Record<string, string | undefined>,
): McpServerLaunch {
  const blanks = Object.keys(agentEnvironment).filter(
    (key) => SECRET_NAME.test(key) || /^ANTHROPIC_/i.test(key),
  );
  return { ...server, env: { ...Object.fromEntries(blanks.map((k) => [k, ''])), ...server.env } };
}
