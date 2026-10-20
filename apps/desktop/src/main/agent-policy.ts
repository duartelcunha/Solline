/**
 * Regras do main para os agentes: que endereços de login se abrem no browser e quando é que
 * mudar as variáveis de um agente precisa de confirmação. Testa-se sem Electron.
 */

/** Os únicos sítios onde cada agente pode mandar fazer login. */
export const LOGIN_HOSTS: Readonly<Record<string, readonly string[]>> = {
  codex: ['auth.openai.com'],
};

/** Só https, no host exato da lista do agente, sem porta, utilizador nem password. */
export function isAllowedLoginUrl(agent: string, raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  return (LOGIN_HOSTS[agent] ?? []).includes(url.hostname);
}

/** As variáveis novas (que o agente ainda não recebia); tirar nunca pede confirmação. */
export function addedKeys(current: readonly string[], next: readonly string[]): string[] {
  const known = new Set(current.map((k) => k.toUpperCase()));
  return next.filter((k) => !known.has(k.toUpperCase()));
}
