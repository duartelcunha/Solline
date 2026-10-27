import type { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { SplitPlan, type SplitCheckRef } from '@solline/protocol';
import { sanitizedEnv } from '../env.ts';
import { insideProject, readOnly } from '../quality/reviewer.ts';

/**
 * O planeador da repartição: lê o pedido e o código (só leitura) e diz se vale a pena partir o
 * trabalho em 2 a 4 partes que não se tocam, cada uma com o seu contrato; ou diz "não partir",
 * com a razão. Só propõe: quem lança é outro passo, depois de o Duarte ver e editar o plano.
 */

export interface PlannerInput {
  /** Pasta onde o planeador pode ler o código (só leitura). */
  cwd: string;
  request: string;
  /** As verificações do projeto: cada parte escolhe uma pelo id (ou nenhuma). */
  checks: readonly SplitCheckRef[];
  signal?: AbortSignal;
}

export interface PlannerOutcome {
  plan: SplitPlan;
  /** O custo do planeamento em dólares, quando o SDK o diz. */
  cost: number | null;
}

export type Planner = (input: PlannerInput) => Promise<PlannerOutcome>;

const RULES = `# You are the planner

The user made one big request for a codebase. Decide whether it is worth splitting it between several coding agents that each work in their own copy of the repository at the same time, and if so, write the plan. You may read the code with Read, Grep and Glob; you cannot change anything.

Split ONLY when all of this is true:
- the parts touch disjoint files (no shared file, no shared symbol, no shared hub such as an index/barrel file, routes, schema, i18n, package.json or a lockfile);
- each part can be verified on its own by one of the project's checks listed in the request.
Otherwise answer decision "keep" with parts = [] and ONE short sentence as the reason. Always answer "keep" when the work is small, tightly coupled, edits the same file or symbol in more than one place, or when no part would have a verification command. Splitting costs roughly N times the tokens of one agent: when in doubt, keep.

When you split:
- Prefer 2 or 3 parts; never more than 4. Each part must be different work, not the same work repeated.
- If several parts need an interface (a type, an API, a schema) that does not exist yet, add ONE leading part with zero = true that only fixes that interface, so the others can build on it. It must be first. Otherwise every part has zero = false.
- Every part has: title (short), goal (what to do, self-contained: the agent will not see the other parts), allowed (paths or globs it may touch), forbidden (the other parts' areas, and shared files), interfaces (what it must respect from the others and what it exposes, or an empty string), expected (the result that proves the part is done) and check (exactly one id from the project's checks, or null if none fits).
- Allowed lists of different parts must not overlap. Use real paths from the repository (look them up), not guesses.

Write reason, title, goal, interfaces and expected in European Portuguese (pt-PT), with short sentences. Keep the paths and the check ids exactly as they are.`;

const PART_FIELDS = z.object({
  title: z.string(),
  goal: z.string(),
  allowed: z.array(z.string()),
  forbidden: z.array(z.string()),
  interfaces: z.string(),
  expected: z.string(),
  check: z.string().nullable(),
  zero: z.boolean(),
});

const OUTPUT = z.object({
  decision: z.enum(['split', 'keep']),
  reason: z.string(),
  parts: z.array(PART_FIELDS),
});

const SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['split', 'keep'] },
    reason: { type: 'string' },
    parts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          goal: { type: 'string' },
          allowed: { type: 'array', items: { type: 'string' } },
          forbidden: { type: 'array', items: { type: 'string' } },
          interfaces: { type: 'string' },
          expected: { type: 'string' },
          check: { type: ['string', 'null'] },
          zero: { type: 'boolean' },
        },
        required: [
          'title',
          'goal',
          'allowed',
          'forbidden',
          'interfaces',
          'expected',
          'check',
          'zero',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['decision', 'reason', 'parts'],
  additionalProperties: false,
};

/** O texto que o planeador lê: o pedido e as verificações que pode escolher. */
export function plannerPrompt(request: string, checks: readonly SplitCheckRef[]): string {
  return [
    "The user's request:",
    request.trim() || '(no text)',
    '',
    'The project checks you can choose from (use the id):',
    checks.length === 0
      ? '(none: no part can be verified, so answer "keep")'
      : checks.map((c) => `- ${c.id}: ${c.label}`).join('\n'),
  ].join('\n');
}

/** O que o planeador respondeu, validado contra o contrato; um erro claro se não servir. */
export function parsePlan(output: unknown): SplitPlan {
  const raw = OUTPUT.safeParse(output);
  if (!raw.success) throw new Error('O planeador respondeu num formato inesperado');
  const { decision, reason, parts } = raw.data;
  if (decision === 'keep') return { decision, reason: reason.trim() || 'Sem razão dada.' };
  const plan = SplitPlan.safeParse({ decision, reason, parts });
  if (!plan.success) {
    const issue = plan.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` (${issue.path.join('.')})` : '';
    throw new Error(`O plano do planeador não é válido${where}: ${issue?.message ?? 'erro'}`);
  }
  return plan.data;
}

/** Um planeador Claude só de leitura (o mesmo cerco do juiz e do revisor). */
export function claudePlanner(
  options: {
    claudeExecutable?: string | undefined;
    queryFn?: typeof sdkQuery;
    model?: string;
  } = {},
): Planner {
  return async (input) => {
    const query = options.queryFn ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
    const abort = new AbortController();
    input.signal?.addEventListener('abort', () => abort.abort(), { once: true });
    const run = query({
      prompt: plannerPrompt(input.request, input.checks),
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
      if (message.subtype !== 'success') throw new Error('O planeador não conseguiu acabar');
      const cost = typeof message.total_cost_usd === 'number' ? message.total_cost_usd : null;
      return { plan: parsePlan(message.structured_output), cost };
    }
    throw new Error('O planeador parou sem resposta');
  };
}
