import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { AgentDescriptor, AgentId, ModeOption } from '@solline/protocol';
import { binaryName, platformPackageName } from '../adapters/claude/executable.ts';
import { CLAUDE_MODES, ClaudeSdkAdapter } from '../adapters/claude/sdk.ts';
import type { AgentAdapterFactory } from '../adapters/types.ts';
import type { BrainTransport } from '../brain/brain.ts';
import type { RuleTarget as RuleChannel } from '../rules/render.ts';
import { CodexAppServerAdapter } from '../adapters/codex/adapter.ts';
import { codexNeedsLogin, startCodexLogin } from '../adapters/codex/account.ts';
import { spawnCodex, type CodexTransport } from '../adapters/codex/transport.ts';
import { withTimeout } from '../adapters/shared/turns.ts';
import {
  REVIEWED_CODEX_VERSION,
  resolveCodexExecutable,
  type CodexExecutable,
} from '../adapters/codex/executable.ts';
import { CODEX_MODES, DEFAULT_CODEX_MODE } from '../adapters/codex/modes.ts';
import { CLAUDE_ENV_POLICY, CODEX_ENV_POLICY, agentEnv, type EnvPolicy } from '../env.ts';
import { StderrTail } from '../rpc/json-rpc.ts';
import { CATALOG, catalogDefinition } from './catalog.ts';
import type { LoginFlow } from './login.ts';

export type Detected = Pick<AgentDescriptor, 'status' | 'detail' | 'version'>;

/**
 * Tudo o que o motor sabe de um agente antes de abrir uma sessão: como se chama, como se
 * fala com ele, que ambiente recebe, que modos aceita e como se cria o adaptador.
 */
export interface AgentDefinition {
  id: AgentId;
  label: string;
  transport: AgentDescriptor['transport'];
  experimental?: boolean;
  envPolicy: EnvPolicy;
  /** Modo de arranque quando o pedido não traz nenhum; null nos agentes sem modos. */
  defaultMode: string | null;
  /** Modos conhecidos antes de arrancar ([] quando o agente só os diz no arranque). */
  staticModes: readonly ModeOption[];
  /** refused: o agente lê config do projeto que não se consegue desligar. */
  untrustedProjects: 'allowed' | 'refused';
  /** Aceita servidores MCP por sessão. */
  mcp?: boolean;
  /**
   * Como recebe as ferramentas da Solline: in-process (servidor dentro do motor, o Claude) ou
   * stdio (o shim, com o Node do sistema). Sem isto, a sessão não as tem. Exige mcp.
   */
  brain?: BrainTransport;
  /**
   * Como recebe as regras: `instructions` no arranque da sessão, `context` com a primeira
   * mensagem. Sem isto, não recebe regras. A pasta do projeto não é lida.
   */
  rules?: { via: RuleChannel };
  /**
   * Estado nesta máquina; nunca lê credenciais. Pode perguntar ao agente se tem sessão (o
   * Codex), e guarda a resposta um bocado; refresh volta a perguntar.
   */
  detect(options?: { refresh?: boolean }): Promise<Detected>;
  /** Entrar dentro da app: o agente dá um endereço para o browser e diz quando acabou. */
  login?: { label: string; start(): Promise<LoginFlow> };
  /**
   * Só recebe os segredos que escolhes no painel (nomes guardados em agent-settings.json),
   * juntos ao envPolicy.keys no arranque de cada sessão.
   */
  configurableKeys?: boolean;
  create: AgentAdapterFactory;
}

export interface AgentRegistry {
  get(id: AgentId): AgentDefinition | undefined;
  list(): readonly AgentDefinition[];
}

export function registryOf(definitions: readonly AgentDefinition[]): AgentRegistry {
  const byId = new Map(definitions.map((d) => [d.id, d]));
  return { get: (id) => byId.get(id), list: () => definitions };
}

/** Troca o create de alguns agentes (testes); o resto da definição fica igual. */
export function withFactories(
  registry: AgentRegistry,
  factories: Readonly<Partial<Record<AgentId, AgentAdapterFactory>>>,
): AgentRegistry {
  return registryOf(
    registry.list().map((d) => {
      const create = factories[d.id];
      return create ? { ...d, create } : d;
    }),
  );
}

export interface BuiltinOptions {
  claudeExecutable?: string | undefined;
  /** Sem definições do utilizador nem do projeto (testes e smoke). */
  isolated?: boolean | undefined;
  /** Pasta de dados da app (perfis de fornecedor). */
  dataDir?: string | undefined;
  /** A correr da app instalada (os agentes não vêm com o motor). */
  packaged?: boolean | undefined;
}

/** O binário do Claude Code vem no pacote de plataforma do SDK. */
async function detectClaude(executable: string | undefined): Promise<Detected> {
  try {
    const binary =
      executable ??
      path.join(
        path.dirname(
          createRequire(import.meta.url).resolve(`${platformPackageName()}/package.json`),
        ),
        binaryName(),
      );
    return existsSync(binary)
      ? { status: 'ready' }
      : { status: 'not-found', detail: 'Falta o claude.exe que vem com o Agent SDK' };
  } catch {
    return { status: 'not-found', detail: 'Falta o claude.exe que vem com o Agent SDK' };
  }
}

export function claudeDefinition(options: BuiltinOptions = {}): AgentDefinition {
  return {
    id: 'claude',
    label: 'Claude',
    transport: 'claude-sdk',
    envPolicy: CLAUDE_ENV_POLICY,
    defaultMode: 'default',
    staticModes: CLAUDE_MODES,
    untrustedProjects: 'allowed',
    mcp: true,
    // O servidor da Solline corre dentro do motor, sem processo nem canal.
    brain: 'in-process',
    // As regras da Solline vão nas instruções. O CLAUDE.md da pasta é excluído no adaptador.
    rules: { via: 'instructions' },
    detect: () => detectClaude(options.claudeExecutable),
    create: (start, sink) =>
      new ClaudeSdkAdapter(
        {
          ...start,
          claudeExecutable: options.claudeExecutable,
          loadSettings: !options.isolated,
        },
        sink,
      ),
  };
}

/** Quanto tempo vale a resposta do Codex sobre ter sessão iniciada. */
const ACCOUNT_TTL_MS = 60_000;
/** A lista de agentes não espera mais do que isto pela resposta do Codex. */
const ACCOUNT_BUDGET_MS = 10_000;

/**
 * O Codex pelo codex app-server. Lê AGENTS.md e config do projeto, por isso só corre em
 * projetos de confiança. Recebe só as chaves da OpenAI, nenhum outro segredo do anfitrião.
 */
export function codexDefinition(
  options: {
    resolve?: () => CodexExecutable | null;
    packaged?: boolean | undefined;
    /** Para testes: o app-server auxiliar (conta e login) em vez do codex.exe. */
    accountTransport?: () => CodexTransport;
  } = {},
): AgentDefinition {
  const resolve =
    options.resolve ?? (() => resolveCodexExecutable({ packaged: options.packaged === true }));
  const envPolicy: EnvPolicy = CODEX_ENV_POLICY;
  const reviewed = (): CodexExecutable => {
    const found = resolve();
    if (!found) throw new Error('Não encontrei o Codex nesta máquina');
    if (found.version !== REVIEWED_CODEX_VERSION) {
      throw new Error(`O Codex instalado (${found.version ?? '?'}) não é a versão revista`);
    }
    return found;
  };
  // Um app-server sem sessão, na pasta pessoal: não lê config de nenhum projeto.
  const aux = (found: CodexExecutable): CodexTransport =>
    options.accountTransport?.() ??
    spawnCodex({
      executable: found.path,
      env: agentEnv(envPolicy),
      cwd: os.homedir(),
      stderr: new StderrTail(),
    });
  let account: { at: number; needsLogin: Promise<boolean> } | null = null;
  const needsLogin = (found: CodexExecutable, refresh: boolean): Promise<boolean> => {
    if (refresh || !account || Date.now() - account.at > ACCOUNT_TTL_MS) {
      // Sem resposta não se bloqueia nada: a sessão diz porquê se faltar o login.
      account = {
        at: Date.now(),
        needsLogin: withTimeout(
          codexNeedsLogin(aux(found)),
          ACCOUNT_BUDGET_MS,
          'Conta do Codex',
        ).catch(() => false),
      };
    }
    return account.needsLogin;
  };
  return {
    id: 'codex',
    label: 'Codex',
    transport: 'codex-app-server',
    envPolicy,
    defaultMode: DEFAULT_CODEX_MODE,
    staticModes: CODEX_MODES,
    untrustedProjects: 'refused',
    // Pela config do thread (mcp_servers.<nome>), só nesta sessão.
    mcp: true,
    brain: 'stdio',
    rules: { via: 'instructions' },
    detect: async ({ refresh = false } = {}) => {
      const found = resolve();
      if (!found) {
        return {
          status: 'not-found',
          detail: `Instala o Codex: npm install -g @openai/codex@${REVIEWED_CODEX_VERSION}`,
        };
      }
      const version = { installed: found.version, reviewed: REVIEWED_CODEX_VERSION };
      if (found.version !== REVIEWED_CODEX_VERSION) {
        return {
          status: 'unreviewed',
          detail: `Versão não revista (instalada ${found.version ?? '?'}, revista ${REVIEWED_CODEX_VERSION})`,
          version,
        };
      }
      if (await needsLogin(found, refresh)) {
        return { status: 'needs-login', detail: 'Entra com o ChatGPT para usar o Codex', version };
      }
      return { status: 'ready', version };
    },
    login: {
      label: 'Entrar com ChatGPT',
      start: async () => {
        const flow = await startCodexLogin(aux(reviewed()));
        // Acabado (bem ou mal), a próxima lista volta a perguntar ao Codex.
        const forget = () => {
          account = null;
        };
        flow.done.then(forget, forget);
        return flow;
      },
    },
    create: (start, sink) =>
      new CodexAppServerAdapter({ ...start, executable: reviewed().path }, sink),
  };
}

export function builtinRegistry(options: BuiltinOptions = {}): AgentRegistry {
  return registryOf([
    claudeDefinition(options),
    codexDefinition({ packaged: options.packaged }),
    ...CATALOG.map((entry) => catalogDefinition(entry, { dataDir: options.dataDir })),
  ]);
}
