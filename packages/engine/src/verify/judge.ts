import type { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { FileDiff } from '@solline/protocol';
import { sanitizedEnv } from '../env.ts';
import { insideProject, readOnly, unifiedDiff } from '../quality/reviewer.ts';
import type { CheckVerdict } from './verify.ts';

/**
 * O juiz cego: só desempata o que a execução não separou. Vê o pedido, os diffs e o resultado
 * das verificações, com as tentativas a chamar-se A, B, C pela posição; nunca o nome do agente nem
 * o que ele disse de si. Corre nas duas ordens (o viés de posição cresce quando as tentativas
 * estão próximas) e, se as duas ordens discordarem, é empate: decide o Duarte.
 */

export interface JudgeCandidate {
  /** Um id opaco (o motor sabe a que pista corresponde; o juiz não). */
  id: string;
  diff: readonly FileDiff[];
  checks: readonly CheckVerdict[];
}

export interface JudgeInput {
  /** Pasta onde o juiz pode ler o código à volta (só leitura). */
  cwd: string;
  request: string;
  candidates: readonly JudgeCandidate[];
  signal?: AbortSignal;
}

export interface JudgeNote {
  best: string;
  worst: string;
}

/** Ordem da melhor para a pior (por id) e uma linha de bom e de mau por tentativa. */
export interface Ranking {
  order: string[];
  notes: Record<string, JudgeNote>;
}

export type Judge = (input: JudgeInput) => Promise<Ranking>;

export interface Verdict extends Ranking {
  /** As duas ordens não escolheram a mesma melhor: empate entre estas. */
  tie: string[] | null;
}

const LETTERS = ['A', 'B', 'C', 'D'];

const RULES = `# You are the judge

Several attempts solved the same request independently. Rank them from best to worst for the user's request.
Judge only the code and the check results. Prefer the attempt that fully and correctly does what was asked, with the smallest safe change, matching the surrounding style. A failed check (not marked as pre-existing) weighs heavily against an attempt.
You may read the surrounding code with Read, Grep and Glob; you cannot change anything.
For each attempt write one short line for its best point and one for its worst point (at most 12 words each), in European Portuguese (pt-PT).`;

const OUTPUT = z.object({
  order: z.array(z.string()).min(1),
  notes: z.array(z.object({ attempt: z.string(), best: z.string(), worst: z.string() })),
});

const SCHEMA = {
  type: 'object',
  properties: {
    order: { type: 'array', items: { type: 'string' } },
    notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          attempt: { type: 'string' },
          best: { type: 'string' },
          worst: { type: 'string' },
        },
        required: ['attempt', 'best', 'worst'],
        additionalProperties: false,
      },
    },
  },
  required: ['order', 'notes'],
  additionalProperties: false,
};

function checksLine(checks: readonly CheckVerdict[]): string {
  if (checks.length === 0) return 'no checks configured';
  return checks
    .map(
      (c) =>
        `${c.label}: ${c.state}${c.state !== 'passed' && c.preexisting ? ' (pre-existing)' : ''}`,
    )
    .join(', ');
}

/** O texto que o juiz lê: as tentativas por letra, sem nada que diga de onde vêm. */
export function judgePrompt(request: string, candidates: readonly JudgeCandidate[]): string {
  const parts = ["The user's request:", request.trim() || '(no text)', ''];
  candidates.forEach((c, i) => {
    parts.push(
      `## Attempt ${LETTERS[i]}`,
      `Checks: ${checksLine(c.checks)}`,
      unifiedDiff(c.diff),
      '',
    );
  });
  parts.push(
    `Answer with "order" as letters, best first (${LETTERS.slice(0, candidates.length).join(', ')}).`,
  );
  return parts.join('\n');
}

/** Um juiz Claude só de leitura (o mesmo cerco do revisor). */
export function claudeJudge(
  options: {
    claudeExecutable?: string | undefined;
    queryFn?: typeof sdkQuery;
    model?: string;
  } = {},
): Judge {
  return async (input) => {
    const query = options.queryFn ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
    const abort = new AbortController();
    input.signal?.addEventListener('abort', () => abort.abort(), { once: true });
    const run = query({
      prompt: judgePrompt(input.request, input.candidates),
      options: {
        cwd: input.cwd,
        model: options.model ?? 'sonnet',
        effort: 'high',
        permissionMode: 'default',
        tools: ['Read', 'Grep', 'Glob'],
        allowedTools: ['Read', 'Grep', 'Glob'],
        canUseTool: readOnly,
        hooks: { PreToolUse: [{ hooks: [insideProject(input.cwd)] }] },
        strictMcpConfig: true,
        settingSources: [],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: RULES },
        outputFormat: { type: 'json_schema', schema: SCHEMA },
        maxTurns: 20,
        persistSession: false,
        env: sanitizedEnv(),
        abortController: abort,
        ...(options.claudeExecutable
          ? { pathToClaudeCodeExecutable: options.claudeExecutable }
          : {}),
      },
    });
    for await (const message of run) {
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success') throw new Error('O juiz não conseguiu acabar');
      const parsed = OUTPUT.safeParse(message.structured_output);
      if (!parsed.success) throw new Error('O juiz respondeu num formato inesperado');
      const byLetter = new Map(input.candidates.map((c, i) => [LETTERS[i] ?? String(i), c.id]));
      const order = parsed.data.order.flatMap((l) => {
        const id = byLetter.get(l.trim().toUpperCase());
        return id ? [id] : [];
      });
      // O que o juiz esqueceu vai para o fim, pela ordem dada (nunca se perde uma tentativa).
      for (const c of input.candidates) if (!order.includes(c.id)) order.push(c.id);
      const notes: Record<string, JudgeNote> = {};
      for (const n of parsed.data.notes) {
        const id = byLetter.get(n.attempt.trim().toUpperCase());
        if (id) notes[id] = { best: n.best, worst: n.worst };
      }
      return { order: [...new Set(order)], notes };
    }
    throw new Error('O juiz parou sem resposta');
  };
}

/**
 * Julga nas duas ordens. A mesma melhor nas duas: essa ordem vale. Melhores diferentes: empate
 * entre as duas, com a ordem da primeira como sugestão.
 */
export async function judgeBothWays(judge: Judge, input: JudgeInput): Promise<Verdict> {
  const forward = await judge(input);
  if (input.candidates.length < 2) return { ...forward, tie: null };
  const backward = await judge({ ...input, candidates: [...input.candidates].reverse() });
  const a = forward.order[0];
  const b = backward.order[0];
  const notes = { ...backward.notes, ...forward.notes };
  if (a && b && a !== b) return { order: forward.order, notes, tie: [a, b] };
  return { order: forward.order, notes, tie: null };
}
