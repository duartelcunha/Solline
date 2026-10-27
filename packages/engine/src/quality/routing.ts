import type { Reviewer } from './reviewer.ts';

/** Escolhe o revisor para a sessão de um agente (agent é o id do agente que escreveu o código). */
export type ReviewerPicker = (agent: string, trusted: boolean) => Promise<Reviewer>;

/**
 * O revisor é sempre de outro fabricante: uma sessão do Claude é revista pelo Codex, e as do
 * Codex e dos agentes ACP pelo Claude. Se o outro não estiver disponível (Codex por instalar,
 * sem login ou com o sandbox por preparar), cai no mesmo fabricante; o resultado diz "mesmo
 * fabricante" (sameVendor) em vez de fingir independência.
 *
 * Em projetos sem confiança o Codex nunca revê: ele lê a config e o AGENTS.md do projeto
 * (hooks, servidores MCP), e a Solline só os deixa correr onde o utilizador confia.
 */
export function routeReviewer(options: {
  claude: Reviewer;
  /** O revisor Codex, se estiver pronto agora (null: não está). */
  codex?: (() => Promise<Reviewer | null>) | undefined;
}): ReviewerPicker {
  return async (agent, trusted) => {
    if (agent !== 'claude' || !trusted || !options.codex) return options.claude;
    return (await options.codex().catch(() => null)) ?? options.claude;
  };
}
