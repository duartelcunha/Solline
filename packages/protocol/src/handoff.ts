import { z } from 'zod';
import { AgentCapabilities, AgentId, SessionInfo } from './conversation.ts';

/**
 * Passagem de testemunho: o trabalho de uma sessão continua noutro agente, na mesma pasta.
 * Quem passa fica legível mas sem enviar; "Retomar aqui" devolve-lhe a pasta e pausa o outro.
 * Nada arranca sozinho: o rascunho é só leitura e o arranque é sempre um gesto do utilizador.
 */

const SessionRef = z.object({ sessionId: z.string().min(1).max(128) }).strict();

/** Como o rascunho foi escrito: por um modelo (só leitura) ou, sem ele, mecanicamente. */
export const HandoffDraftedBy = z.enum(['model', 'mechanical']);
export type HandoffDraftedBy = z.infer<typeof HandoffDraftedBy>;

/** O que o utilizador escolhe: o agente seguinte (e o modelo) e o que ele deve fazer. */
const HandoffTarget = {
  agent: AgentId,
  model: z.string().min(1).max(200).optional(),
};

export const handoffCommandSchemas = {
  /**
   * Escreve o rascunho da passagem (só leitura, não muda nada). `drafted` diz se foi um modelo ou
   * o rascunho mecânico (o objetivo, o último pedido e os ficheiros); `warning` explica porquê.
   */
  'handoff.draft': {
    payload: SessionRef.extend({ ...HandoffTarget, goal: z.string().min(1).max(4_000) }).strict(),
    result: z.object({
      text: z.string(),
      drafted: HandoffDraftedBy,
      warning: z.string().optional(),
      /** O custo do rascunho em dólares, quando o modelo o diz. */
      cost: z.number().nullable(),
    }),
  },
  /** Desiste de um rascunho a meio (fechar o diálogo): o `handoff.draft` pendente falha. */
  'handoff.cancelDraft': {
    payload: SessionRef,
    result: z.object({ cancelled: z.boolean() }),
  },
  /**
   * Passa o testemunho: abre uma sessão nova do agente escolhido na mesma pasta (e worktree, que
   * muda de dono) e manda-lhe o aviso e o rascunho editado. A sessão de origem fica sem enviar.
   * Recusa se a origem está a trabalhar ou já passou o testemunho.
   */
  'handoff.start': {
    payload: SessionRef.extend({
      ...HandoffTarget,
      effort: z.string().min(1).max(32).optional(),
      text: z.string().min(1).max(200_000),
    }).strict(),
    result: z.object({
      session: SessionInfo,
      capabilities: AgentCapabilities,
      /** O turno da primeira mensagem (o aviso e o rascunho). */
      turnId: z.string(),
    }),
  },
  /**
   * "Retomar aqui", pedido na sessão que passou o testemunho: a pasta volta a esta sessão e a que
   * a tinha fica em pausa (sem enviar). Recusa se essa sessão está a trabalhar.
   */
  'handoff.resume': {
    payload: SessionRef,
    result: z.object({
      session: SessionInfo,
      /** A sessão que ficou em pausa (já não existe se foi fechada entretanto). */
      paused: SessionInfo.optional(),
    }),
  },
} as const;
