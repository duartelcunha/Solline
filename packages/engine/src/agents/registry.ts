import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { AgentDescriptor, AgentId, ModeOption } from '@solline/protocol';
import { binaryName, platformPackageName } from '../adapters/claude/executable.ts';
import { CLAUDE_MODES, ClaudeSdkAdapter, type ClaudeProfile } from '../adapters/claude/sdk.ts';
import type { AgentAdapterFactory } from '../adapters/types.ts';
import { CodexAppServerAdapter } from '../adapters/codex/adapter.ts';
import {
  REVIEWED_CODEX_VERSION,
  resolveCodexExecutable,
  type CodexExecutable,
} from '../adapters/codex/executable.ts';
import { CODEX_MODES, DEFAULT_CODEX_MODE } from '../adapters/codex/modes.ts';
import { CLAUDE_ENV_POLICY, type EnvPolicy } from '../env.ts';
import { DEEPSEEK, profileDefinition } from './profiles.ts';

type Detected = Pick<AgentDescriptor, 'status' | 'detail'>;

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
  /** Estado nesta máquina; não arranca o agente nem lê credenciais. */
  detect(): Promise<Detected>;
  /**
   * Segredos lidos só no arranque (por exemplo do Gestor de Credenciais) e juntos ao ambiente
   * do agente. Lança com uma mensagem calma se faltar algum.
   */
  secrets?(): Promise<Record<string, string>>;
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

export function claudeDefinition(
  options: BuiltinOptions & { profile?: ClaudeProfile } = {},
): AgentDefinition {
  return {
    id: 'claude',
    label: 'Claude',
    transport: 'claude-sdk',
    envPolicy: CLAUDE_ENV_POLICY,
    defaultMode: 'default',
    staticModes: CLAUDE_MODES,
    untrustedProjects: 'allowed',
    detect: () => detectClaude(options.claudeExecutable),
    create: (start, sink) =>
      new ClaudeSdkAdapter(
        {
          ...start,
          claudeExecutable: options.claudeExecutable,
          loadSettings: !options.isolated,
          ...(options.profile ? { profile: options.profile } : {}),
        },
        sink,
      ),
  };
}

/**
 * O Codex pelo codex app-server. Lê AGENTS.md e config do projeto, por isso só corre em
 * projetos de confiança. Recebe só as chaves da OpenAI, nenhum outro segredo do anfitrião.
 */
export function codexDefinition(
  options: { resolve?: () => CodexExecutable | null; packaged?: boolean | undefined } = {},
): AgentDefinition {
  const resolve =
    options.resolve ?? (() => resolveCodexExecutable({ packaged: options.packaged === true }));
  return {
    id: 'codex',
    label: 'Codex',
    transport: 'codex-app-server',
    envPolicy: { base: 'no-secrets', keys: ['OPENAI_API_KEY', 'CODEX_API_KEY'] },
    defaultMode: DEFAULT_CODEX_MODE,
    staticModes: CODEX_MODES,
    untrustedProjects: 'refused',
    detect: async () => {
      const found = resolve();
      if (!found) {
        return {
          status: 'not-found',
          detail: `Instala o Codex: npm install -g @openai/codex@${REVIEWED_CODEX_VERSION}`,
        };
      }
      if (found.version !== REVIEWED_CODEX_VERSION) {
        return {
          status: 'unreviewed',
          detail: `Versão não revista (instalada ${found.version ?? '?'}, revista ${REVIEWED_CODEX_VERSION})`,
        };
      }
      return { status: 'ready' };
    },
    create: (start, sink) => {
      const found = resolve();
      if (!found) throw new Error('Não encontrei o Codex nesta máquina');
      if (found.version !== REVIEWED_CODEX_VERSION) {
        throw new Error(`O Codex instalado (${found.version ?? '?'}) não é a versão revista`);
      }
      return new CodexAppServerAdapter({ ...start, executable: found.path }, sink);
    },
  };
}

export function builtinRegistry(options: BuiltinOptions = {}): AgentRegistry {
  return registryOf([
    claudeDefinition(options),
    codexDefinition({ packaged: options.packaged }),
    profileDefinition(DEEPSEEK, options),
  ]);
}
