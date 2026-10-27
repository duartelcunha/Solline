/** Os nomes das ferramentas do cérebro para perguntar a outro agente e delegar uma tarefa. */
export const ASK_AGENT_TOOL = 'ask_agent';
export const DELEGATE_TOOL = 'delegate';

/** As duas, juntas: as sessões que nasceram de uma consulta ou delegação não as recebem. */
export const CONSULT_TOOL_NAMES: readonly string[] = [ASK_AGENT_TOOL, DELEGATE_TOOL];

/** Perguntar e delegar somados: no máximo isto por turno e por sessão (rejeitar não devolve a quota). */
export const MAX_CONSULT_CALLS_PER_TURN = 3;

/** Quanto a ferramenta espera pelo fim do primeiro turno de uma consulta. */
export const ASK_TIMEOUT_MS = 10 * 60_000;

/** A resposta de uma consulta, como a ferramenta a devolve ao agente (o resto fica na sessão). */
export const MAX_ANSWER_CHARS = 6_000;
