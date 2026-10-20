import { CLIENT_APP_ID } from '@solline/protocol/app';

/**
 * Variáveis que uma sessão do Claude Code (ou a app da Anthropic) deixa no ambiente e que,
 * herdadas, fazem o claude.exe filho achar que é uma sessão aninhada: muda o login, o
 * endereço da API, os plugins e o comportamento. Achado do M0.
 */
const INHERITED =
  /^(CLAUDECODE|CLAUDE_CODE_.+|CLAUDE_AGENT_SDK_.+|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_.+|ANTHROPIC_BASE_URL|USE_LOCAL_OAUTH|USE_STAGING_OAUTH|MCP_CONNECTION_NONBLOCKING|MCP_SERVER_CONNECTION_BATCH_SIZE|AI_AGENT)$/i;

/**
 * Nomes que parecem segredos. É uma lista de recusa: um segredo com um nome estranho passa.
 * Serve para um agente não receber as chaves dos outros fornecedores.
 */
export const SECRET_NAME =
  /(^|_)(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$|^(AWS|AZURE)_|^(GH|GITHUB|HF|NPM)_TOKEN$/i;

/**
 * O ambiente de cada agente, por passos: parte do processo, tira sempre as variáveis de
 * uma sessão anfitriã, depois (em no-secrets) os segredos que o agente não declarou, o
 * que for para largar, copia variáveis de origem e aplica o overlay no fim.
 */
export interface EnvPolicy {
  /** host: o ambiente todo, como hoje no Claude. no-secrets: sem segredos não declarados. */
  base: 'host' | 'no-secrets';
  /** Segredos que passam mesmo em no-secrets (por exemplo OPENAI_API_KEY no Codex). */
  keys?: readonly string[];
  drop?: readonly string[];
  /** Larga tudo o que o nome apanhar (por exemplo /^ANTHROPIC_/ num perfil de outro fornecedor). */
  dropPattern?: RegExp;
  /** destino <- variável de origem, lida do ambiente original. */
  fromEnv?: Readonly<Record<string, string>>;
  /** Aplicado no fim: ganha a tudo o que veio do processo. */
  overlay?: Readonly<Record<string, string>>;
}

export function agentEnv(
  policy: EnvPolicy,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const keys = new Set((policy.keys ?? []).map((k) => k.toUpperCase()));
  const drop = new Set((policy.drop ?? []).map((k) => k.toUpperCase()));
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (INHERITED.test(key) || drop.has(upper) || policy.dropPattern?.test(key)) continue;
    if (policy.base === 'no-secrets' && SECRET_NAME.test(key) && !keys.has(upper)) continue;
    env[key] = value;
  }
  for (const [target, from] of Object.entries(policy.fromEnv ?? {})) {
    const value = source[from];
    if (value !== undefined) env[target] = value;
  }
  return { ...env, ...policy.overlay };
}

/** O Claude recebe o ambiente todo (Bash, hooks e MCP pessoais precisam dele), sem o herdado. */
export const CLAUDE_ENV_POLICY: EnvPolicy = {
  base: 'host',
  overlay: { CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP_ID },
};

/**
 * Ambiente para o claude.exe: parte do process.env, tira o que veio de uma sessão
 * anfitriã e identifica a Solline. O env do SDK substitui, não junta, por isso vai inteiro.
 */
export function sanitizedEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  return agentEnv(CLAUDE_ENV_POLICY, source);
}
