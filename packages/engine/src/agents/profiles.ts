import os from 'node:os';
import path from 'node:path';
import { CLIENT_APP_ID } from '@solline/protocol/app';
import type { ClaudeProfile } from '../adapters/claude/sdk.ts';
import { readWindowsCredential, type CredentialReader } from '../secrets/windows-credentials.ts';
import { claudeDefinition, type AgentDefinition, type BuiltinOptions } from './registry.ts';

/**
 * Outro fornecedor por trás do Claude Code: o mesmo adaptador, com o endereço, os modelos e
 * a chave do fornecedor. É o mesmo binário da Anthropic a falar com outra API.
 */
export interface ProviderProfile {
  id: string;
  label: string;
  baseUrl: `https://${string}`;
  /** Credencial genérica no Gestor de Credenciais do Windows. */
  credentialTarget: string;
  /** Alternativa: variável de ambiente com a chave. */
  tokenEnvVar: string;
  /** Modelo de cada alias do Claude Code (opus/sonnet/haiku/fable) e dos subagentes. */
  models: {
    main: string;
    opus: string;
    sonnet: string;
    haiku: string;
    subagent: string;
    fable?: string;
  };
  claude: ClaudeProfile;
  extraEnv: Readonly<Record<string, string>>;
}

/** Modelos DeepSeek pelo endpoint compatível com a Anthropic (api-docs.deepseek.com). */
export const DEEPSEEK: ProviderProfile = {
  id: 'deepseek',
  label: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/anthropic',
  credentialTarget: 'solline/deepseek',
  tokenEnvVar: 'DEEPSEEK_API_KEY',
  models: {
    main: 'deepseek-flash[1m]',
    opus: 'deepseek-flash[1m]',
    sonnet: 'deepseek-flash[1m]',
    haiku: 'deepseek-flash',
    subagent: 'deepseek-flash',
  },
  claude: {
    models: [
      {
        id: 'default',
        resolved: 'deepseek-flash[1m]',
        label: 'DeepSeek Flash',
        description: 'DeepSeek Flash · 1M de contexto',
      },
    ],
    hideModes: ['auto'],
  },
  // Sem telemetria nem atualizações da Anthropic numa sessão que fala com outra API.
  extraEnv: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
};

/** Modelos GLM da Z.ai pelo endpoint compatível com a Anthropic (docs.z.ai/devpack/tool/claude). */
export const GLM: ProviderProfile = {
  id: 'glm',
  label: 'GLM',
  baseUrl: 'https://api.z.ai/api/anthropic',
  credentialTarget: 'solline/glm',
  tokenEnvVar: 'ZAI_API_KEY',
  models: {
    main: 'glm-5.3[1m]',
    opus: 'glm-5.3[1m]',
    sonnet: 'glm-5.3[1m]',
    haiku: 'glm-5.3-flash[1m]',
    subagent: 'glm-5.3-flash[1m]',
    fable: 'glm-5.3[1m]',
  },
  claude: {
    models: [
      {
        id: 'default',
        resolved: 'glm-5.3[1m]',
        label: 'GLM-5.3',
        description: 'GLM-5.3 da Z.ai · 1M de contexto',
      },
    ],
    hideModes: ['auto'],
  },
  // O guia da Z.ai sobe o tempo de espera: as respostas longas passam dos 10 min por omissão.
  extraEnv: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', API_TIMEOUT_MS: '3000000' },
};

/**
 * Modelos Kimi da Moonshot pelo endpoint compatível com a Anthropic
 * (platform.kimi.ai/docs/guide/claude-code-kimi). O guia põe o haiku no kimi-k2.7-code, que
 * obriga a pensar e dá 400 aos pedidos curtos do Claude Code sem thinking: fica tudo no K3.
 */
export const KIMI: ProviderProfile = {
  id: 'kimi',
  label: 'Kimi',
  baseUrl: 'https://api.moonshot.ai/anthropic',
  credentialTarget: 'solline/kimi',
  tokenEnvVar: 'MOONSHOT_API_KEY',
  models: {
    main: 'kimi-k3[1m]',
    opus: 'kimi-k3[1m]',
    sonnet: 'kimi-k3[1m]',
    haiku: 'kimi-k3[1m]',
    subagent: 'kimi-k3[1m]',
    fable: 'kimi-k3[1m]',
  },
  claude: {
    models: [
      {
        id: 'default',
        resolved: 'kimi-k3[1m]',
        label: 'Kimi K3',
        description: 'Kimi K3 da Moonshot · 1M de contexto',
      },
    ],
    hideModes: ['auto'],
  },
  extraEnv: {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
  },
};

/** Os perfis de outros fornecedores que o registo mostra, por esta ordem. */
export const PROVIDER_PROFILES: readonly ProviderProfile[] = [DEEPSEEK, GLM, KIMI];

const KEY_HINT = (p: ProviderProfile) =>
  `Guarda a chave no Gestor de Credenciais do Windows (credencial genérica "${p.credentialTarget}") ` +
  `ou na variável ${p.tokenEnvVar}.`;

/**
 * A chave vem da variável de ambiente ou do Gestor de Credenciais, só no arranque da sessão,
 * e vai só para o processo do agente. A Solline nunca a guarda.
 */
async function findKey(
  profile: ProviderProfile,
  read: CredentialReader,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const fromEnv = env[profile.tokenEnvVar]?.trim();
  if (fromEnv) return fromEnv;
  const stored = await read(profile.credentialTarget, 'read');
  return typeof stored === 'string' && stored.trim() ? stored.trim() : null;
}

export interface ProfileOptions {
  /** Pasta de dados da app: cada perfil tem a sua pasta de config do Claude Code. */
  dataDir?: string | undefined;
  /** Para testes: troca o Gestor de Credenciais. */
  readCredential?: CredentialReader;
  /** Para testes: troca o ambiente do processo. */
  env?: NodeJS.ProcessEnv;
}

/**
 * O agente "claude:<perfil>": o Claude Code com outro fornecedor. Corre com uma pasta de
 * config própria (o login do claude.ai nunca chega a um URL de terceiros), sem definições do
 * utilizador nem do projeto, sem segredos do anfitrião e sem custo (os preços seriam os do
 * Claude). Experimental: cada subida do Agent SDK pode partir isto.
 */
export function profileDefinition(
  profile: ProviderProfile,
  options: ProfileOptions & BuiltinOptions = {},
): AgentDefinition {
  const base = claudeDefinition({ ...options, profile: profile.claude });
  const read = options.readCredential ?? readWindowsCredential;
  const env = options.env ?? process.env;
  const configDir = path.join(options.dataDir ?? os.tmpdir(), 'profiles', profile.id);
  return {
    ...base,
    id: `${base.id}:${profile.id}`,
    label: profile.label,
    experimental: true,
    untrustedProjects: 'allowed',
    staticModes: base.staticModes.filter((m) => !profile.claude.hideModes.includes(m.id)),
    envPolicy: {
      base: 'no-secrets',
      drop: ['CLAUDE_CONFIG_DIR'],
      // Nada da Anthropic chega a outro fornecedor: chaves, tokens, cabeçalhos próprios…
      dropPattern: /^ANTHROPIC_/i,
      overlay: {
        CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP_ID,
        ANTHROPIC_BASE_URL: profile.baseUrl,
        ANTHROPIC_MODEL: profile.models.main,
        ANTHROPIC_DEFAULT_OPUS_MODEL: profile.models.opus,
        ANTHROPIC_DEFAULT_SONNET_MODEL: profile.models.sonnet,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.models.haiku,
        CLAUDE_CODE_SUBAGENT_MODEL: profile.models.subagent,
        ...(profile.models.fable ? { ANTHROPIC_DEFAULT_FABLE_MODEL: profile.models.fable } : {}),
        CLAUDE_CONFIG_DIR: configDir,
        ...profile.extraEnv,
      },
    },
    secrets: async () => {
      const key = await findKey(profile, read, env);
      if (!key) throw new Error(`Falta a chave da ${profile.label}. ${KEY_HINT(profile)}`);
      return { ANTHROPIC_AUTH_TOKEN: key };
    },
    detect: async () => {
      const binary = await base.detect();
      if (binary.status !== 'ready') return binary;
      if (env[profile.tokenEnvVar]?.trim()) return { status: 'ready' };
      const stored = await read(profile.credentialTarget, 'check');
      return stored ? { status: 'ready' } : { status: 'needs-key', detail: KEY_HINT(profile) };
    },
  };
}
