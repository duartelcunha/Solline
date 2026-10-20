import {
  RequestEnvelope,
  engineCommandSchemas,
  type AgentId,
  type EngineCommandName,
  type EngineCommandPayload,
  type EngineCommandResult,
  type EngineEvent,
  type ResponseEnvelope,
} from '@solline/protocol';
import type { AgentAdapterFactory } from './adapters/types.ts';
import { builtinRegistry, withFactories, type AgentRegistry } from './agents/registry.ts';
import { mcpCatalog, type McpCatalog } from './mcp/catalog.ts';
import { SessionManager } from './session-manager.ts';
import { ENGINE_VERSION } from './version.ts';

export interface EngineOptions {
  claudeExecutable?: string | undefined;
  /** Pasta de dados da app (perfis de fornecedor guardam lá a config do Claude Code). */
  dataDir?: string | undefined;
  /** A correr da app instalada. */
  packaged?: boolean | undefined;
  /** Para onde vão os eventos (no utilityProcess, a MessagePort). */
  emit?: (event: EngineEvent) => void;
  /** Sem definições do utilizador nem do projeto (testes e smoke). */
  isolated?: boolean;
  /** Para testes: troca o adaptador de alguns agentes (o resto da definição fica). */
  adapters?: Partial<Record<AgentId, AgentAdapterFactory>>;
  /** Para testes: troca o registo inteiro. */
  registry?: AgentRegistry;
  /** Para testes: troca o catálogo de servidores MCP. */
  mcp?: McpCatalog;
}

type Handlers = {
  [C in EngineCommandName]: (payload: EngineCommandPayload<C>) => Promise<EngineCommandResult<C>>;
};

/** O motor recebe envelopes de pedido e devolve envelopes de resposta. Não sabe do Electron. */
export class Engine {
  readonly sessions: SessionManager;
  readonly #handlers: Handlers;

  constructor(options: EngineOptions = {}) {
    const base =
      options.registry ??
      builtinRegistry({
        claudeExecutable: options.claudeExecutable,
        isolated: options.isolated,
        dataDir: options.dataDir,
        packaged: options.packaged,
      });
    const registry = options.adapters ? withFactories(base, options.adapters) : base;
    const mcp = options.mcp ?? mcpCatalog({ dataDir: options.dataDir });
    this.sessions = new SessionManager({ emit: options.emit ?? (() => undefined), registry, mcp });
    const s = this.sessions;
    const ok = {} as Record<string, never>;
    this.#handlers = {
      'engine.ping': async () => ({
        pong: true,
        engineVersion: ENGINE_VERSION,
        pid: process.pid,
        receivedAt: Date.now(),
      }),
      'mcp.list': async () => ({ servers: await mcp.list() }),
      'agents.list': async () => ({
        agents: await Promise.all(
          registry.list().map(async (d) => ({
            id: d.id,
            label: d.label,
            transport: d.transport,
            experimental: d.experimental === true,
            untrustedProjects: d.untrustedProjects,
            ...(await d.detect().catch((error: unknown): { status: 'error'; detail: string } => ({
              status: 'error',
              detail: error instanceof Error ? error.message : String(error),
            }))),
          })),
        ),
      }),
      'session.start': (p) => s.create(p),
      'projects.trustChanged': async (p) => (s.setProjectTrust(p.projectId, p.trusted), ok),
      'session.resume': (p) => s.resume(p.sessionId),
      'session.send': async (p) => ({ turnId: await s.send(p.sessionId, p.text) }),
      'session.interrupt': async (p) => (await s.interrupt(p.sessionId), ok),
      'session.setMode': async (p) => (await s.setMode(p.sessionId, p.mode), ok),
      'session.setModel': async (p) => (await s.setModel(p.sessionId, p.model), ok),
      'session.setEffort': async (p) => (await s.setEffort(p.sessionId, p.effort), ok),
      'permission.answer': async (p) => (s.answer(p.sessionId, p.requestId, p.answer), ok),
    };
  }

  async handle(raw: unknown): Promise<ResponseEnvelope> {
    // Só passam comandos do motor: os do main e os desconhecidos ficam aqui.
    const parsed = RequestEnvelope.safeParse(raw);
    if (!parsed.success) {
      const id =
        typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string'
          ? raw.id
          : '';
      return { kind: 'response', id, ok: false, error: { message: 'Pedido inválido' } };
    }
    const { id, payload, command } = parsed.data;
    try {
      const schema = engineCommandSchemas[command];
      const input = schema.payload.parse(payload ?? {});
      const handler = this.#handlers[command] as (payload: unknown) => Promise<unknown>;
      const result = schema.result.parse(await handler(input));
      return { kind: 'response', id, ok: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { kind: 'response', id, ok: false, error: { message } };
    }
  }

  async dispose(): Promise<void> {
    await this.sessions.disposeAll();
  }
}
