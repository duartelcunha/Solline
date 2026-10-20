import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { AgentDescriptor, AgentId, ModeOption } from '@solline/protocol';
import { binaryName, platformPackageName } from '../adapters/claude/executable.ts';
import { CLAUDE_MODES, ClaudeSdkAdapter, type ClaudeProfile } from '../adapters/claude/sdk.ts';
import type { AgentAdapterFactory } from '../adapters/types.ts';
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

export function builtinRegistry(options: BuiltinOptions = {}): AgentRegistry {
  return registryOf([claudeDefinition(options), profileDefinition(DEEPSEEK, options)]);
}
