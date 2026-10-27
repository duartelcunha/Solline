import { z } from 'zod';
import { AgentId } from './conversation.ts';
import { SplitPart, SplitPartInput } from './race.ts';

/**
 * A repartição: um pedido grande cortado em 2 a 4 partes diferentes, cada uma numa pista
 * própria. O planeador propõe o corte (ou diz que não vale a pena); a revisão confere-o antes
 * de lançar, sem gastar nada.
 */

/** Uma parte zero, se houver, fecha primeiro a interface comum e vem à frente das outras. */
const zeroFirst = (parts: readonly SplitPart[]) =>
  parts.every((part, index) => !part.zero || index === 0);

/** split: parte em várias · keep: "não partir", com a razão. */
export const SplitPlan = z.discriminatedUnion('decision', [
  z
    .object({
      decision: z.literal('split'),
      parts: z.array(SplitPart).min(2).max(4).refine(zeroFirst, {
        message: 'A parte zero tem de ser a primeira (e só pode haver uma)',
      }),
      reason: z.string().min(1).max(2_000),
    })
    .strict(),
  z.object({ decision: z.literal('keep'), reason: z.string().min(1).max(2_000) }).strict(),
]);
export type SplitPlan = z.infer<typeof SplitPlan>;

/**
 * O que a revisão apurou:
 * `sequential` são os grupos de partes (por índice) que correm uma a seguir à outra, porque as
 * zonas permitidas se tocam; as que não se tocam ficam sozinhas num grupo.
 * `dropped` são as partes que não se lançam (sem verificação válida).
 * `hubs` são ficheiros-ponto-de-encontro que duas ou mais partes podem tocar.
 * `costMultiplier` são as partes que vão correr, ou seja, quantas vezes os tokens de um agente.
 */
export const SplitReview = z
  .object({
    sequential: z.array(z.array(z.number().int().min(0))),
    dropped: z.array(z.object({ index: z.number().int().min(0), reason: z.string() }).strict()),
    hubs: z.array(
      z.object({ path: z.string(), parts: z.array(z.number().int().min(0)).min(2) }).strict(),
    ),
    costMultiplier: z.number().int().min(0),
    warnings: z.array(z.string()),
  })
  .strict();
export type SplitReview = z.infer<typeof SplitReview>;

/** As verificações que o planeador pode escolher: só o id e o nome. */
export const SplitCheckRef = z
  .object({ id: z.string().min(1).max(64), label: z.string().min(1).max(64) })
  .strict();
export type SplitCheckRef = z.infer<typeof SplitCheckRef>;

const Text = z.string().min(1).max(200_000);

/** O que o main pede ao motor (com a pasta e as verificações do projeto já resolvidas). */
export const SplitPlanNowPayload = z
  .object({
    text: Text,
    cwd: z.string().min(1),
    checks: z.array(SplitCheckRef).max(6),
  })
  .strict();

export const SplitPlanPayload = z
  .object({ projectId: z.string().min(1).max(64), text: Text })
  .strict();

export const SplitPlanResult = z
  .object({
    plan: SplitPlan,
    review: SplitReview,
    /** O custo do planeamento (USD), quando o SDK o diz. */
    cost: z.number().nullable(),
  })
  .strict();

/** Uma parte a lançar: o contrato e quem a faz. */
export const SplitPartSpec = z
  .object({
    part: SplitPartInput,
    agent: AgentId,
    model: z.string().min(1).max(200).optional(),
  })
  .strict();
export type SplitPartSpec = z.infer<typeof SplitPartSpec>;

/** Lança a repartição: o pedido original e as 2 a 4 partes (a interface só manda ids de projeto). */
export const SplitStartPayload = z
  .object({
    projectId: z.string().min(1).max(64),
    text: Text,
    parts: z
      .array(SplitPartSpec)
      .min(2)
      .max(4)
      .refine((specs) => zeroFirst(specs.map((s) => s.part)), {
        message: 'A parte zero tem de ser a primeira (e só pode haver uma)',
      }),
  })
  .strict();

export const SplitReviewPayload = z
  .object({
    parts: z.array(SplitPartInput).min(1).max(4).refine(zeroFirst),
    checkIds: z.array(z.string().min(1).max(64)).max(6),
  })
  .strict();
