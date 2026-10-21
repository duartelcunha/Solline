import path from 'node:path';
import type { CanUseTool, HookCallback, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { FindingSeverity, type FileDiff, type Finding } from '@solline/protocol';
import { sanitizedEnv } from '../env.ts';

export interface ReviewInput {
  cwd: string;
  /** O que o turno mudou. */
  diff: readonly FileDiff[];
  /** O pedido do utilizador nesse turno (para o revisor saber o que se queria). */
  request: string;
  signal?: AbortSignal;
}

export type ReviewedFinding = Omit<Finding, 'id'>;

/** Lê um diff e devolve achados. O revisor por omissão é um Claude só de leitura. */
export type Reviewer = (input: ReviewInput) => Promise<ReviewedFinding[]>;

const MAX_DIFF_CHARS = 80_000;
const READ_ONLY = new Set(['Read', 'Grep', 'Glob']);
/** A ferramenta com que o SDK devolve o JSON do esquema: é a resposta, não mexe em nada. */
const ANSWER = 'StructuredOutput';

const RULES = `# You are the reviewer

Another coding agent just made the change below. Review it with fresh eyes. You can read the surrounding code with Read, Grep and Glob; you cannot change anything.

Report only real problems, most severe first:
- bug: the change does the wrong thing, breaks something, or misses part of the request.
- risk: likely to break or unsafe (unchecked input at a boundary, swallowed errors, races, secrets).
- slop: works but is noise. Comments that restate code, dead or commented-out code, needless abstractions or options, code that ignores the style around it, weakened or skipped tests, generic AI-sounding text in the UI or docs.

Never report what a formatter fixes, personal taste, or praise. At most 8 findings; none is a fine answer.
Each title is one short sentence (at most 12 words). Each detail says why and what to do, in at most 3 short sentences.
Work out any example before writing it; never correct yourself mid-sentence.
line is the line number in the new version of the file, or null for the whole file.
Write titles and details in European Portuguese (pt-PT), whatever the language of the request.`;

const OUTPUT = z.object({
  findings: z
    .array(
      z.object({
        path: z.string().min(1),
        line: z.number().int().positive().nullable(),
        severity: FindingSeverity,
        title: z.string().min(1).max(300),
        detail: z.string().max(2_000),
      }),
    )
    .max(8),
});

const SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          line: { type: ['integer', 'null'] },
          severity: { type: 'string', enum: ['bug', 'risk', 'slop'] },
          title: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['path', 'line', 'severity', 'title', 'detail'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
};

/** O diff em formato unificado, como o git o mostraria, cortado para caber. */
export function unifiedDiff(files: readonly FileDiff[]): string {
  const out: string[] = [];
  for (const file of files) {
    out.push(`--- ${file.status === 'added' ? '/dev/null' : `a/${file.path}`}`);
    out.push(`+++ ${file.status === 'deleted' ? '/dev/null' : `b/${file.path}`}`);
    if (file.binary) out.push('(binary file)');
    for (const hunk of file.hunks) {
      out.push(hunk.header);
      for (const line of hunk.lines) {
        out.push(`${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`);
      }
    }
  }
  const text = out.join('\n');
  return text.length > MAX_DIFF_CHARS
    ? `${text.slice(0, MAX_DIFF_CHARS)}\n(diff cut here: too long to show in full)`
    : text;
}

export function promptFor(input: Pick<ReviewInput, 'diff' | 'request'>): string {
  return [
    "The user's request for this turn:",
    input.request.trim() || '(no text)',
    '',
    'The change (unified diff):',
    unifiedDiff(input.diff),
  ].join('\n');
}

/** Só leitura, sempre: qualquer outra ferramenta é recusada antes de correr. */
export const readOnly: CanUseTool = (toolName, input) =>
  Promise.resolve(
    READ_ONLY.has(toolName) || toolName === ANSWER
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'O revisor só lê' },
  );

/** O caminho que uma ferramenta de leitura vai abrir (relativo à pasta do projeto). */
function targetOf(toolName: string, input: Record<string, unknown>): string | undefined {
  const value = toolName === 'Read' ? input.file_path : input.path;
  return typeof value === 'string' ? value : undefined;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, path.resolve(root, target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Corre antes de cada ferramenta, mesmo das que o modo aprova sozinho: só leituras, e só
 * dentro da pasta do projeto. Um diff com instruções escondidas não leva o revisor a ler
 * ~/.ssh nem a correr comandos.
 */
export function insideProject(root: string): HookCallback {
  return (hookInput) => {
    const deny = (reason: string) =>
      Promise.resolve({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: reason,
        },
      });
    if (hookInput.hook_event_name !== 'PreToolUse' || hookInput.tool_name === ANSWER) {
      return Promise.resolve({});
    }
    if (!READ_ONLY.has(hookInput.tool_name)) return deny('O revisor só lê');
    const input = (hookInput.tool_input ?? {}) as Record<string, unknown>;
    const target = targetOf(hookInput.tool_name, input);
    if (target !== undefined && !inside(root, target)) return deny('Só dentro do projeto');
    const pattern = input.pattern;
    if (hookInput.tool_name === 'Glob' && typeof pattern === 'string' && path.isAbsolute(pattern)) {
      return deny('Só dentro do projeto');
    }
    return Promise.resolve({});
  };
}

export function claudeReviewer(
  options: { claudeExecutable?: string | undefined; queryFn?: typeof sdkQuery } = {},
): Reviewer {
  return async (input) => {
    const query = options.queryFn ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
    const abort = new AbortController();
    input.signal?.addEventListener('abort', () => abort.abort(), { once: true });
    const run = query({
      prompt: promptFor(input),
      options: {
        cwd: input.cwd,
        model: 'sonnet',
        effort: 'medium',
        permissionMode: 'default',
        // Só existem estas três; nem servidores MCP nem definições (e hooks) de lado nenhum.
        tools: [...READ_ONLY],
        allowedTools: [...READ_ONLY],
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
      if (message.subtype !== 'success') throw new Error('O revisor não conseguiu acabar');
      const parsed = OUTPUT.safeParse(message.structured_output);
      if (!parsed.success) throw new Error('O revisor respondeu num formato inesperado');
      return parsed.data.findings;
    }
    throw new Error('O revisor parou sem resposta');
  };
}
