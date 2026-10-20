/**
 * Regras do main para os agentes: que endereços de login se abrem no browser e quando é que
 * mudar as variáveis de um agente precisa de confirmação. Testa-se sem Electron.
 */

/** Os únicos sítios onde cada agente pode mandar fazer login. */
export const LOGIN_HOSTS: Readonly<Record<string, readonly string[]>> = {
  codex: ['auth.openai.com'],
};

/**
 * Só https, no host exato da lista do agente, sem porta, utilizador nem password. Devolve o
 * URL já interpretado: é esse que se abre, não o texto que veio do motor.
 */
export function allowedLoginUrl(agent: string, raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return (LOGIN_HOSTS[agent] ?? []).includes(url.hostname) ? url : null;
}

/** As variáveis novas (que o agente ainda não recebia); tirar nunca pede confirmação. */
export function addedKeys(current: readonly string[], next: readonly string[]): string[] {
  const known = new Set(current.map((k) => k.toUpperCase()));
  return next.filter((k) => !known.has(k.toUpperCase()));
}
