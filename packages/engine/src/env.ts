import { CLIENT_APP_ID } from '@solline/protocol';

/**
 * Variáveis que uma sessão do Claude Code (ou a app da Anthropic) deixa no ambiente e que,
 * herdadas, fazem o claude.exe filho achar que é uma sessão aninhada: muda o login, o
 * endereço da API, os plugins e o comportamento. Achado do M0.
 */
const INHERITED =
  /^(CLAUDECODE|CLAUDE_CODE_.+|CLAUDE_AGENT_SDK_.+|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_.+|ANTHROPIC_BASE_URL|USE_LOCAL_OAUTH|USE_STAGING_OAUTH|MCP_CONNECTION_NONBLOCKING|MCP_SERVER_CONNECTION_BATCH_SIZE|AI_AGENT)$/i;

/**
 * Ambiente para o claude.exe: parte do process.env, tira o que veio de uma sessão
 * anfitriã e identifica a Solline. O env do SDK substitui, não junta, por isso vai inteiro.
 */
export function sanitizedEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!INHERITED.test(key)) env[key] = value;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = CLIENT_APP_ID;
  return env;
}
