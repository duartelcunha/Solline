import { z } from 'zod';
import { AgentId } from './conversation.ts';

/**
 * "Perguntar a…" (`ask_agent`) e "Delegar" (`delegate`): um agente pede ao utilizador para
 * consultar outro agente ou lhe entregar uma tarefa. Cada chamada fica pendente até o utilizador
 * responder, como um pedido de permissão, mas num cartão próprio. O texto da pergunta e da
 * tarefa vem de um agente: é dado não confiável, nunca uma ordem para a Solline.
 */

/** Limites do que um agente pode escrever (a pergunta, a tarefa, o contexto, o título). */
export const CONSULT_MAX_QUESTION = 4_000;
export const CONSULT_MAX_TASK = 8_000;
export const CONSULT_MAX_CONTEXT = 8_000;
export const CONSULT_MAX_TITLE = 80;

export const ConsultKind = z.enum(['ask', 'delegate']);
export type ConsultKind = z.infer<typeof ConsultKind>;

/** O que o utilizador decide: permitir uma vez, permitir o resto da sessão (por tipo) ou recusar. */
export const ConsultDecision = z.enum(['allow', 'allowSession', 'deny']);
export type ConsultDecision = z.infer<typeof ConsultDecision>;

/** Como acabou um pedido: uma decisão, ou cancelado (a sessão fechou ou o turno foi interrompido). */
export const ConsultOutcome = z.enum(['allow', 'allowSession', 'deny', 'cancelled']);
export type ConsultOutcome = z.infer<typeof ConsultOutcome>;

/** Um pedido à espera do utilizador. */
export const ConsultRequest = z
  .object({
    id: z.string(),
    kind: ConsultKind,
    /** A sessão que chamou a ferramenta. */
    sessionId: z.string(),
    /** O agente dessa sessão e o que vai responder ou trabalhar. */
    from: AgentId,
    to: AgentId,
    /** A frase do cartão: «O Claude quer perguntar ao Codex». */
    summary: z.string().max(300),
    /** A pergunta (ask) ou a tarefa (delegate), como o agente a escreveu (já limpa e limitada). */
    text: z.string().max(CONSULT_MAX_TASK),
    /** ask: o contexto que o agente juntou. */
    context: z.string().max(CONSULT_MAX_CONTEXT).optional(),
    /** delegate: o título que a sessão nova vai ter. */
    title: z.string().max(CONSULT_MAX_TITLE).optional(),
    /** ask: o outro fabricante não estava disponível e a consulta vai ao mesmo. */
    sameVendor: z.boolean().optional(),
    /** delegate: o modo de permissão da sessão nova (já com o acesso total rebaixado). */
    mode: z.object({ id: z.string(), label: z.string() }).nullable().optional(),
    createdAt: z.number(),
  })
  .strict();
export type ConsultRequest = z.infer<typeof ConsultRequest>;

export const consultCommandSchemas = {
  /**
   * Responde a um pedido de consulta ou delegação que um agente fez. `allowSession` vale para o
   * resto da sessão, em separado para perguntar e para delegar. Recusa se o pedido já não está à
   * espera (respondido, cancelado ou o motor reiniciou).
   */
  'consult.answer': {
    payload: z
      .object({
        sessionId: z.string().min(1).max(128),
        requestId: z.string().min(1).max(128),
        decision: ConsultDecision,
      })
      .strict(),
    result: z.object({}).strict(),
  },
} as const;
