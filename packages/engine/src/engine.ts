import path from 'node:path';
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
import { LoginManager } from './agents/login.ts';
import { builtinRegistry, withFactories, type AgentRegistry } from './agents/registry.ts';
import { CheckpointStore, type CheckpointStoreOptions } from './checkpoints/store.ts';
import { fileAgentSettings, memoryAgentSettings, type AgentSettings } from './agents/settings.ts';
import { SECRET_NAME } from './env.ts';
import { mcpCatalog, type McpCatalog } from './mcp/catalog.ts';
import { claudeReviewer, type Reviewer } from './quality/reviewer.ts';
import { SessionManager, type ChecksOptions } from './session-manager.ts';
import { detectChecks } from './checks/detect.ts';
import { detectSetup } from './workspace/setup.ts';
import { WorktreeManager } from './worktrees/worktrees.ts';
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
  /** Checkpoints por turno (por omissão na pasta de dados); false desliga-os. */
  checkpoints?: CheckpointStoreOptions | false;
  /** A segunda opinião no fim de cada turno (por omissão um Claude só de leitura); false desliga. */
  reviewer?: Reviewer | false;
  /** As verificações do projeto no fim de cada turno (por omissão ligadas, menos isolado); false desliga. */
  checks?: ChecksOptions | false;
  /** Worktrees para as sessões a mais de um projeto (por omissão na pasta de dados); false desliga. */
  worktrees?: WorktreeManager | false;
  /** Para testes: troca onde ficam as variáveis escolhidas para cada agente. */
  settings?: AgentSettings;
  /** Para testes: o ambiente onde se procuram nomes de segredos. */
  env?: NodeJS.ProcessEnv;
}

type Handlers = {
  [C in EngineCommandName]: (payload: EngineCommandPayload<C>) => Promise<EngineCommandResult<C>>;
};

/** O motor recebe envelopes de pedido e devolve envelopes de resposta. Não sabe do Electron. */
export class Engine {
  readonly sessions: SessionManager;
  readonly logins: LoginManager;
  readonly #handlers: Handlers;
  readonly #checkpoints: CheckpointStore | undefined;

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
    this.#checkpoints =
      options.checkpoints === false
        ? undefined
        : new CheckpointStore({
            root: options.dataDir ? path.join(options.dataDir, 'checkpoints') : undefined,
            ...options.checkpoints,
          });
    const emit = options.emit ?? (() => undefined);
    const settings =
      options.settings ??
      (options.dataDir ? fileAgentSettings(options.dataDir) : memoryAgentSettings());
    const env = options.env ?? process.env;
    this.sessions = new SessionManager({
      emit,
      registry,
      mcp,
      checkpoints: this.#checkpoints,
      keysFor: (agent) => settings.keys(agent),
      // Nos testes isolados não se gasta a subscrição a rever turnos falsos.
      reviewer:
        options.reviewer === false
          ? undefined
          : (options.reviewer ??
            (options.isolated
              ? undefined
              : claudeReviewer({ claudeExecutable: options.claudeExecutable }))),
      // Nos testes isolados não se correm comandos do repositório da própria Solline.
      worktrees:
        options.worktrees === false
          ? undefined
          : (options.worktrees ??
            (options.dataDir
              ? new WorktreeManager({ root: path.join(options.dataDir, 'worktrees') })
              : undefined)),
      checks:
        options.checks === false
          ? undefined
          : (options.checks ?? (options.isolated ? undefined : {})),
    });
    this.logins = new LoginManager({
      onChange: (agent, error) =>
        emit({ kind: 'event', type: 'agents.changed', agent, ...(error ? { error } : {}) }),
    });
    const logins = this.logins;
    const definitionOf = (id: string) => {
      const found = registry.get(id);
      if (!found) throw new Error(`Agente desconhecido: ${id}`);
      return found;
    };
    const configurable = (id: string) => {
      const definition = definitionOf(id);
      if (!definition.configurableKeys) throw new Error('Este agente não deixa escolher variáveis');
      return definition;
    };
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
      'agents.list': async (p) => ({
        agents: await Promise.all(
          registry.list().map(async (d) => ({
            id: d.id,
            label: d.label,
            transport: d.transport,
            experimental: d.experimental === true,
            untrustedProjects: d.untrustedProjects,
            mcp: d.mcp === true,
            ...(d.login ? { login: { label: d.login.label, pending: logins.pending(d.id) } } : {}),
            ...(d.configurableKeys ? { keys: await settings.keys(d.id) } : {}),
            ...(await d
              .detect({ refresh: p.refresh === true })
              .catch((error: unknown): { status: 'error'; detail: string } => ({
                status: 'error',
                detail: error instanceof Error ? error.message : String(error),
              }))),
          })),
        ),
      }),
      'agents.loginStart': async (p) => {
        const login = definitionOf(p.agent).login;
        if (!login) throw new Error('Este agente não tem login dentro da app');
        return { url: (await logins.start(p.agent, () => login.start())).url };
      },
      'agents.loginCancel': async (p) => (await logins.cancel(p.agent), ok),
      'agents.keys': async (p) => {
        const definition = configurable(p.agent);
        return { label: definition.label, keys: await settings.keys(p.agent) };
      },
      'agents.saveKeys': async (p) => {
        configurable(p.agent);
        await settings.setKeys(p.agent, p.keys);
        emit({ kind: 'event', type: 'agents.changed', agent: p.agent });
        return ok;
      },
      // Só nomes, nunca valores: para o painel sugerir o que escolher.
      'agents.keyCandidates': async () => ({
        names: Object.keys(env)
          .filter((name) => SECRET_NAME.test(name) && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))
          .sort(),
      }),
      'session.start': (p) => s.create(p),
      'projects.trustChanged': async (p) => (s.setProjectTrust(p.projectId, p.trusted), ok),
      'projects.detectChecks': async (p) => ({ checks: await detectChecks(p.cwd) }),
      'projects.detectSetup': async (p) => ({ setup: await detectSetup(p.cwd) }),
      'projects.setupChanged': async (p) => (s.setProjectSetup(p.projectId, p.setup), ok),
      'setup.retry': async (p) => (await s.retrySetup(p.sessionId), ok),
      'projects.checksChanged': async (p) => (await s.setProjectChecks(p.projectId, p.checks), ok),
      'session.resume': (p) => s.resume(p.sessionId),
      'session.send': (p) => s.send(p.sessionId, p.text, p.how),
      'session.unqueue': async (p) => (s.unqueue(p.sessionId, p.id), ok),
      'session.reorder': async (p) => (s.reorder(p.sessionId, p.ids), ok),
      'session.resumeQueue': async (p) => (s.resumeQueue(p.sessionId), ok),
      'session.bring': (p) => s.bring(p.sessionId),
      'worktrees.list': async () => ({ orphans: await s.orphans() }),
      'worktrees.bring': (p) => s.bringOrphan(p.id),
      'worktrees.discard': async (p) => (await s.discardOrphan(p.id), ok),
      'session.close': (p) => s.close(p.sessionId, p.worktree, p.dropQueue),
      'session.interrupt': async (p) => (await s.interrupt(p.sessionId), ok),
      'session.setMode': async (p) => (await s.setMode(p.sessionId, p.mode), ok),
      'session.setModel': async (p) => (await s.setModel(p.sessionId, p.model), ok),
      'session.setEffort': async (p) => (await s.setEffort(p.sessionId, p.effort), ok),
      'permission.answer': async (p) => (s.answer(p.sessionId, p.requestId, p.answer), ok),
      'review.timeline': (p) => s.timeline(p.sessionId),
      'review.diff': async (p) => ({ files: await s.diff(p.sessionId, p.scope) }),
      'review.apply': (p) => s.review(p.sessionId, p.action, p.path, p.hunkId),
      'review.undo': (p) => s.undo(p.sessionId),
      'review.comment': async (p) => ({
        turnId: await s.comment(p.sessionId, p.comments, p.note),
      }),
      'session.rewind': (p) =>
        s.rewind(p.sessionId, p.turnId, { files: p.files, conversation: p.conversation }),
      'quality.get': async (p) => s.quality(p.sessionId),
      'quality.setEnabled': async (p) => s.setQualityEnabled(p.sessionId, p.enabled),
      'quality.review': (p) => s.reviewNow(p.sessionId),
      'quality.fix': async (p) => ({ turnId: await s.fix(p.sessionId, p.ids) }),
      'checks.get': async (p) => s.checks(p.sessionId),
      'checks.run': (p) => s.runChecks(p.sessionId),
      'checks.fix': async (p) => ({ turnId: await s.fixCheck(p.sessionId, p.id) }),
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
    await this.logins.cancelAll();
    await this.sessions.disposeAll();
    await this.#checkpoints?.dispose();
  }
}
