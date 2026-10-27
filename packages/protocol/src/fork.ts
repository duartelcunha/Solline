import { z } from 'zod';
import { AgentCapabilities, SessionInfo, Turn } from './conversation.ts';
import { ConversationRewind } from './review.ts';

/**
 * Bifurcar: uma sessão nova nasce do checkpoint de um turno, na sua própria worktree com os
 * ficheiros exatamente como ficaram depois desse turno, e com o mesmo agente e modelo. A sessão
 * de origem não muda; o rebobinar também não.
 */
export const forkCommandSchemas = {
  /**
   * Bifurca a sessão no fim de um turno. Só em projetos git (a nova sessão tem worktree própria).
   * A conversa continua pelo próprio agente quando ele sabe (`conversation: 'agent'`) e, nos
   * outros, com um resumo do que ficou até esse turno (`'summary'`). Recusa se a origem está a
   * trabalhar ou se o turno não tem checkpoint acabado.
   */
  'session.fork': {
    payload: z
      .object({
        sessionId: z.string().min(1).max(128),
        turnId: z.string().min(1).max(64),
      })
      .strict(),
    result: z.object({
      session: SessionInfo,
      capabilities: AgentCapabilities,
      /** A conversa até esse turno, que a sessão nova mostra como histórico. */
      turns: z.array(Turn),
      conversation: ConversationRewind,
    }),
  },
} as const;
