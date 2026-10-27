import type { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { FileDiff, HandoffDraftedBy } from '@solline/protocol';
import { sanitizedEnv } from '../env.ts';
import { insideProject, readOnly } from '../quality/reviewer.ts';

/**
 * O rascunho da passagem de testemunho. Um rascunho curto e estruturado, que o utilizador edita,
 * vale mais do que levar a conversa inteira: o modelo só escreve as partes que exigem juízo
 * (objetivo, decisões, perguntas, passos, verificação). A lista de ficheiros tocados vem sempre
 * da Solline, porque um resumo esquece-a. Sem modelo (ou se falhar) sai um rascunho mecânico, para
 * a passagem funcionar sempre.
 */

/** Um ficheiro tocado, tal como a Solline o contou (não o modelo). */
export interface DraftFile {
  path: string;
  additions: number;
  deletions: number;
  binary?: boolean;
}

/** Os ficheiros do rascunho a partir de um diff (o da worktree contra a base, ou o da sessão). */
export function draftFilesOf(diffs: readonly FileDiff[]): DraftFile[] {
  return diffs.map((d) => ({
    path: d.path,
    additions: d.additions,
    deletions: d.deletions,
    ...(d.binary ? { binary: true } : {}),
  }));
}

/** As partes que o modelo escreve (listas já limpas). */
export interface DraftSections {
  objective: string;
  decisions: string[];
  openQuestions: string[];
  nextSteps: string[];
  verification: string[];
}

export interface DrafterInput {
  /** Pasta onde o modelo pode ler o código (só leitura). */
  cwd: string;
  /** O que o agente seguinte deve fazer, pelas palavras do utilizador. */
  goal: string;
  source: { label: string; title: string };
  target: { label: string; model?: string | undefined };
  /** As mensagens da conversa, resumidas mecanicamente (nunca registos de ferramentas). */
  transcript: string | undefined;
  files: readonly DraftFile[];
  signal?: AbortSignal;
}

export interface DrafterOutcome {
  sections: DraftSections;
  /** O custo do rascunho em dólares, quando o SDK o diz. */
  cost: number | null;
}

export type Drafter = (input: DrafterInput) => Promise<DrafterOutcome>;

/** Os cabeçalhos fixos, pela ordem em que aparecem. */
export const DRAFT_HEADERS = {
  objective: 'Objetivo',
  decisions: 'Decisões e o que se pôs de parte',
  files: 'Ficheiros tocados',
  openQuestions: 'Perguntas em aberto',
  nextSteps: 'Próximos passos',
  verification: 'Verificação',
} as const;

/** O que se lê numa secção sem nada. */
export const NOTHING = '(nada)';

const MAX_ITEMS = 12;
const MAX_ITEM_CHARS = 500;
const MAX_FILES = 100;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Uma lista a partir do que o modelo deu (uma lista, ou um texto com uma linha por item). */
function toList(value: string | readonly string[]): string[] {
  const lines = typeof value === 'string' ? value.split(/\r?\n/) : value;
  return lines
    .map((line) => line.trim().replace(/^[-*•]\s+/, ''))
    .filter((line) => line.length > 0)
    .slice(0, MAX_ITEMS)
    .map((line) => clip(line, MAX_ITEM_CHARS));
}

function fileLine(file: DraftFile): string {
  const stats = file.binary ? 'binário' : `+${file.additions} −${file.deletions}`;
  return `${file.path} (${stats})`;
}

/**
 * O texto final do rascunho, em pt-PT, com os cabeçalhos fixos e pela mesma ordem sempre. Uma
 * secção vazia diz "(nada)". Os ficheiros são os da Solline, nunca os que o modelo disse.
 */
export function assembleDraft(sections: DraftSections, files: readonly DraftFile[]): string {
  const list = (items: readonly string[]) =>
    items.length === 0 ? NOTHING : items.map((item) => `- ${item}`).join('\n');
  const shown = files.slice(0, MAX_FILES).map(fileLine);
  if (files.length > MAX_FILES) shown.push(`… e mais ${files.length - MAX_FILES} ficheiros`);
  const blocks: [string, string][] = [
    [DRAFT_HEADERS.objective, sections.objective.trim() || NOTHING],
    [DRAFT_HEADERS.decisions, list(toList(sections.decisions))],
    [DRAFT_HEADERS.files, list(shown)],
    [DRAFT_HEADERS.openQuestions, list(toList(sections.openQuestions))],
    [DRAFT_HEADERS.nextSteps, list(toList(sections.nextSteps))],
    [DRAFT_HEADERS.verification, list(toList(sections.verification))],
  ];
  return blocks.map(([header, body]) => `## ${header}\n${body}`).join('\n\n');
}

/** O objetivo (a primeira linha da secção) de um rascunho, para dar nome à sessão nova. */
export function objectiveOf(text: string): string | undefined {
  const match = new RegExp(
    `^##[ \\t]+${DRAFT_HEADERS.objective}[ \\t]*\\r?\\n+([^\\r\\n]+)`,
    'm',
  ).exec(text);
  const line = match?.[1]?.trim();
  return line && line !== NOTHING ? line : undefined;
}

/**
 * A primeira mensagem da sessão nova: um aviso visível de que o trabalho veio de outro agente e,
 * a seguir, o rascunho como o utilizador o deixou.
 */
export function handoffMessage(source: { label: string; title: string }, text: string): string {
  return (
    `Passagem de testemunho de ${source.label} (${source.title}). ` +
    'O trabalho já feito está na pasta; não repitas o que já foi feito.' +
    `\n\n${text.trim()}`
  );
}

export interface DraftRequest {
  cwd: string;
  goal: string;
  source: { label: string; title: string };
  target: { label: string; model?: string | undefined };
  /** O resumo mecânico da conversa (summaryOf). */
  transcript: string | undefined;
  /** O último pedido do utilizador na sessão de origem (para o rascunho mecânico). */
  lastRequest: string;
  files: readonly DraftFile[];
  signal?: AbortSignal | undefined;
}

export interface DraftResult {
  text: string;
  drafted: HandoffDraftedBy;
  warning?: string;
  cost: number | null;
}

/** O rascunho sem modelo: o objetivo, o último pedido e os ficheiros; o resto fica "(nada)". */
export function mechanicalSections(goal: string, lastRequest: string): DraftSections {
  const last = lastRequest.trim();
  return {
    objective: last
      ? `${goal.trim()}\n\nÚltimo pedido na sessão anterior: ${clip(last, 600)}`
      : goal.trim(),
    decisions: [],
    openQuestions: [],
    nextSteps: [],
    verification: [],
  };
}

/**
 * Escreve o rascunho: com o modelo quando há um, e mecânico quando não há ou quando ele falha (a
 * passagem nunca fica presa por causa do rascunho). Um pedido cancelado não vira rascunho.
 */
export async function draftHandoff(
  drafter: Drafter | undefined,
  request: DraftRequest,
): Promise<DraftResult> {
  const mechanical = (warning: string): DraftResult => ({
    text: assembleDraft(mechanicalSections(request.goal, request.lastRequest), request.files),
    drafted: 'mechanical',
    warning,
    cost: null,
  });
  if (!drafter)
    return mechanical('Não há um modelo disponível para escrever o rascunho; este é mecânico.');
  try {
    const { signal, lastRequest: _last, ...input } = request;
    const outcome = await drafter({ ...input, ...(signal ? { signal } : {}) });
    const sections: DraftSections = {
      ...outcome.sections,
      objective: outcome.sections.objective.trim() || request.goal.trim(),
    };
    return {
      text: assembleDraft(sections, request.files),
      drafted: 'model',
      cost: outcome.cost,
    };
  } catch (error) {
    if (request.signal?.aborted) throw new Error('O rascunho foi cancelado.', { cause: error });
    const reason = error instanceof Error ? error.message : String(error);
    return mechanical(`O modelo não conseguiu escrever o rascunho (${reason}); este é mecânico.`);
  }
}

const RULES = `# You write the handoff note

A coding agent worked on a codebase with the user. Now a different coding agent will continue the work in the same folder. Write the short note that agent needs, so it does not repeat what was done and does not undo what was decided. You may read the code with Read, Grep and Glob; you cannot change anything.

Fill these fields:
- objective: one or two sentences. The goal the user gave for the next agent, restated with what "done" looks like.
- decisions: choices already made and approaches ruled out, each with the reason. At most 8 items.
- openQuestions: what is still unknown or needs the user's input. At most 6 items.
- nextSteps: ordered, concrete steps towards the goal, pointing at real paths you checked. At most 8 items.
- verification: how to know it works: real commands or checks that exist in the repository (look at package.json scripts and CI files). At most 5 items.

Rules:
- Base every claim on the conversation or on code you read. Never invent. When you are not sure, leave the list empty.
- Do NOT list the files that were changed: they are listed separately.
- Describe actions neutrally ("editou a.ts"). Never copy tool-call records or mention the tools or internals of a specific vendor.
- Short sentences, one idea per item.
- Write in European Portuguese (pt-PT). Keep paths, commands and identifiers exactly as they are.`;

const List = z.union([z.string(), z.array(z.string())]).transform(toList);

const OUTPUT = z.object({
  objective: z.string(),
  decisions: List,
  openQuestions: List,
  nextSteps: List,
  verification: List,
});

const STRINGS = { type: 'array', items: { type: 'string' } };
const SCHEMA = {
  type: 'object',
  properties: {
    objective: { type: 'string' },
    decisions: STRINGS,
    openQuestions: STRINGS,
    nextSteps: STRINGS,
    verification: STRINGS,
  },
  required: ['objective', 'decisions', 'openQuestions', 'nextSteps', 'verification'],
  additionalProperties: false,
};

/** O texto que o modelo lê: o objetivo, quem passa a quem, os ficheiros e a conversa. */
export function drafterPrompt(input: Omit<DrafterInput, 'cwd' | 'signal'>): string {
  const target = input.target.model
    ? `${input.target.label} (model ${input.target.model})`
    : input.target.label;
  return [
    "The goal for the next agent, in the user's words:",
    input.goal.trim() || '(no text)',
    '',
    `Handing off from: ${input.source.label} (session "${input.source.title}")`,
    `Handing off to: ${target}`,
    '',
    'Files already changed in the folder (listed separately, do not repeat them):',
    input.files.length === 0 ? '(none)' : input.files.slice(0, MAX_FILES).map(fileLine).join('\n'),
    '',
    'The conversation so far (a mechanical excerpt, oldest first):',
    input.transcript ?? '(no messages)',
  ].join('\n');
}

/** O que o modelo respondeu, validado; um erro claro se não servir. */
export function parseDraft(output: unknown): DraftSections {
  const raw = OUTPUT.safeParse(output);
  if (!raw.success) throw new Error('o modelo respondeu num formato inesperado');
  return raw.data;
}

/** Um redator Claude só de leitura (o mesmo cerco do planeador, do juiz e do revisor). */
export function claudeDrafter(
  options: {
    claudeExecutable?: string | undefined;
    queryFn?: typeof sdkQuery;
    model?: string;
  } = {},
): Drafter {
  return async (input) => {
    const query = options.queryFn ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
    const abort = new AbortController();
    if (input.signal?.aborted) abort.abort();
    input.signal?.addEventListener('abort', () => abort.abort(), { once: true });
    const run = query({
      prompt: drafterPrompt(input),
      options: {
        cwd: input.cwd,
        model: options.model ?? 'sonnet',
        effort: 'medium',
        permissionMode: 'default',
        tools: ['Read', 'Grep', 'Glob'],
        allowedTools: ['Read', 'Grep', 'Glob'],
        canUseTool: readOnly,
        hooks: { PreToolUse: [{ hooks: [insideProject(input.cwd)] }] },
        strictMcpConfig: true,
        settingSources: [],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: RULES },
        outputFormat: { type: 'json_schema', schema: SCHEMA },
        maxTurns: 15,
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
      if (message.subtype !== 'success') throw new Error('o modelo não conseguiu acabar');
      const cost = typeof message.total_cost_usd === 'number' ? message.total_cost_usd : null;
      return { sections: parseDraft(message.structured_output), cost };
    }
    throw new Error('o modelo parou sem resposta');
  };
}
