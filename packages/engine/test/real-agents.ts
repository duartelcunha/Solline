/**
 * Que agentes correm a sério nos testes de integração (sessões reais, com custo).
 * SOLLINE_AGENTS=claude,codex escolhe; por omissão só o Claude; SOLLINE_SKIP_SDK=1 salta todos.
 */
export function realAgents(env: NodeJS.ProcessEnv = process.env): Set<string> {
  if (env.SOLLINE_SKIP_SDK === '1') return new Set();
  const list = env.SOLLINE_AGENTS?.trim();
  return new Set(
    (list ? list.split(',') : ['claude']).map((a) => a.trim()).filter((a) => a.length > 0),
  );
}
