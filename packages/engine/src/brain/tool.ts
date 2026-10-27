import { z } from 'zod';
import type { AgentId } from '@solline/protocol';

/**
 * O nome do servidor MCP da Solline para os agentes: as ferramentas ficam mcp__solline__<nome>
 * no Claude e solline/<nome> no Codex.
 */
export const BRAIN_SERVER_NAME = 'solline';

/** Como a interface de autorização chama uma ferramenta da Solline. */
export function brainToolLabel(tool: string): string {
  return `Solline · ${tool}`;
}

/** O que uma ferramenta sabe de quem a chama. Vem sempre do motor, nunca dos argumentos. */
export interface BrainContext {
  readonly sessionId: string;
  readonly projectId: string;
  readonly agent: AgentId;
  /** O que da sessão pode mudar entre chamadas (o título nasce da primeira mensagem). */
  session(): { title: string; folder: string; cwd?: string | undefined };
  /**
   * O turno em curso, visto pelo motor: o id do pedido do utilizador e se o turno já foi a fontes
   * externas (web, servidores de terceiros). Sem esta informação, assume-se externo.
   */
  turn(): TurnInfo;
}

export interface TurnInfo {
  id: string | undefined;
  external: boolean;
}

/** O que uma ferramenta devolve ao agente. */
export interface BrainResult {
  text: string;
  isError: boolean;
}

/** Um erro que o agente pode ler tal como está (o resto vira "erro interno"). */
export class BrainToolError extends Error {}

/** Os argumentos de uma ferramenta, como um objeto zod "cru" (o que o SDK do Claude também aceita). */
export type BrainShape = Record<string, z.ZodType>;

export interface BrainToolSpec<S extends BrainShape> {
  name: string;
  /** Para o modelo ler: em inglês, uma ou duas frases. */
  description: string;
  input: S;
  /** Só lê: pode correr sem pedir autorização. Qualquer coisa que mude estado pede sempre. */
  readOnly: boolean;
  /**
   * Muda estado mas é inofensiva (só deixa uma proposta à espera do utilizador): corre sem pedir,
   * para não interromper a sessão. Nunca mude isto para ferramentas com efeitos reais.
   */
  autoApprove?: boolean;
  handler(ctx: BrainContext, args: z.infer<z.ZodObject<S>>): Promise<unknown> | unknown;
}

/** Uma ferramenta já pronta a correr com argumentos que ainda ninguém validou. */
export interface BrainTool {
  readonly name: string;
  readonly description: string;
  readonly input: BrainShape;
  readonly readOnly: boolean;
  readonly autoApprove: boolean;
  run(ctx: BrainContext, args: unknown): Promise<BrainResult>;
}

/** Mais do que isto não é para um agente ler de uma só vez. */
export const MAX_RESULT_CHARS = 64_000;

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

function textOf(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '');
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[cortado]` : text;
}

function failure(text: string): BrainResult {
  return { text, isError: true };
}

/** Valida os argumentos, corre a ferramenta e devolve os erros como resultado, nunca como exceção. */
export function defineBrainTool<S extends BrainShape>(spec: BrainToolSpec<S>): BrainTool {
  if (!TOOL_NAME.test(spec.name)) throw new Error(`Nome de ferramenta inválido: ${spec.name}`);
  const schema = z.object(spec.input).strict();
  return {
    name: spec.name,
    description: spec.description,
    input: spec.input,
    readOnly: spec.readOnly,
    autoApprove: spec.readOnly || spec.autoApprove === true,
    run: async (ctx, args) => {
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue?.path.join('.') || 'argumentos';
        return failure(`Argumentos inválidos (${where}): ${issue?.message ?? 'formato errado'}`);
      }
      try {
        return { text: textOf(await spec.handler(ctx, parsed.data)), isError: false };
      } catch (error) {
        if (error instanceof BrainToolError) return failure(error.message);
        console.error(`[brain] ${spec.name} falhou: ${String(error)}`);
        return failure('Erro interno da Solline.');
      }
    },
  };
}
