import { z } from 'zod';

/**
 * Regras escritas pelo utilizador e guardadas na Solline, nunca na pasta do projeto.
 * Dois níveis: `projectId` null é o geral; uma string é o projeto.
 */

const Id = z.string().min(1).max(128);
const ProjectRef = z.string().min(1).max(128);

export const RULE_MAX_TITLE = 120;
export const RULE_MAX_TEXT = 10_000;
export const RULE_MAX_GLOBS = 20;
export const RULES_PER_PROJECT = 200;
export const RULES_HISTORY = 30;

/** Um padrão relativo à raiz do projeto (`*.ts`, `src/db/**`): sem caminhos absolutos nem `..`. */
export const RuleGlob = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (glob) =>
      !/^([/\\]|[a-zA-Z]:)/.test(glob) && !glob.split(/[/\\]/).some((segment) => segment === '..'),
    { message: 'O padrão é relativo à pasta do projeto, sem .. nem caminhos absolutos' },
  );

export const ProjectRule = z
  .object({
    id: Id,
    /** null: vale em todos os projetos. */
    projectId: ProjectRef.nullable(),
    title: z.string().trim().min(1).max(RULE_MAX_TITLE),
    text: z.string().trim().min(1).max(RULE_MAX_TEXT),
    /** Vazio: vale sempre. Com padrões: só para os ficheiros que casam (entra ao tocar neles). */
    globs: z.array(RuleGlob).max(RULE_MAX_GLOBS),
    enabled: z.boolean(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type ProjectRule = z.infer<typeof ProjectRule>;

/** length: as regras sem padrões estão compridas demais. */
export const RulesWarning = z
  .object({ kind: z.literal('length'), text: z.string().max(1000) })
  .strict();
export type RulesWarning = z.infer<typeof RulesWarning>;

export const RuleBucket = z
  .object({
    rules: z.array(ProjectRule).max(RULES_PER_PROJECT),
    warnings: z.array(RulesWarning).max(4),
  })
  .strict();
export type RuleBucket = z.infer<typeof RuleBucket>;

const HistoryEntry = z
  .object({
    global: z.array(ProjectRule).max(RULES_PER_PROJECT),
    projects: z.record(ProjectRef, z.array(ProjectRule).max(RULES_PER_PROJECT)),
  })
  .strict();

export const RulesState = z.preprocess(migrateRulesInput, z
  .object({
    version: z.literal(2),
    revision: z.number().int().nonnegative(),
    global: RuleBucket,
    projects: z.record(ProjectRef, RuleBucket),
    history: z.array(HistoryEntry).max(RULES_HISTORY),
  })
  .strict());
export type RulesState = z.infer<typeof RulesState>;

export function emptyRules(): RulesState {
  return { version: 2, revision: 0, global: { rules: [], warnings: [] }, projects: {}, history: [] };
}

/**
 * v1 guardava `importedFrom` sem dizer qual regra veio do ficheiro. Se o projeto importou,
 * todas as regras ficam desligadas: o texto mantém-se e nenhuma entra num agente até ser ligada.
 */
export function migrateRulesInput(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const raw = input as {
    version?: unknown;
    revision?: unknown;
    global?: unknown;
    projects?: Record<string, { rules?: ProjectRule[]; importedFrom?: unknown; warnings?: unknown }>;
    history?: unknown;
  };
  if (raw.version === 2 && raw.global) return input;
  const projects: Record<string, { rules: ProjectRule[]; warnings: [] }> = {};
  for (const [id, project] of Object.entries(raw.projects ?? {})) {
    const imported = Array.isArray(project.importedFrom) && project.importedFrom.length > 0;
    projects[id] = {
      rules: (project.rules ?? []).map((rule) =>
        imported ? { ...rule, enabled: false } : rule,
      ),
      warnings: [],
    };
  }
  return {
    version: 2,
    revision: typeof raw.revision === 'number' ? raw.revision : 0,
    global: { rules: [], warnings: [] },
    projects,
    history: [],
  };
}

export const ProjectRulesView = z
  .object({
    projectId: ProjectRef.nullable(),
    rules: z.array(ProjectRule).max(RULES_PER_PROJECT),
    warnings: z.array(RulesWarning).max(4),
    canUndo: z.boolean(),
  })
  .strict();
export type ProjectRulesView = z.infer<typeof ProjectRulesView>;

const Scope = z.object({ projectId: ProjectRef.nullable() }).strict();

export const RuleInput = z
  .object({
    projectId: ProjectRef.nullable(),
    /** Sem id cria uma regra nova; com id altera essa. */
    id: Id.optional(),
    title: z.string().trim().min(1).max(RULE_MAX_TITLE),
    text: z.string().trim().min(1).max(RULE_MAX_TEXT),
    globs: z.array(RuleGlob).max(RULE_MAX_GLOBS).default([]),
    enabled: z.boolean().default(true),
  })
  .strict();

/** O texto de arranque, já com as regras de ofício onde o agente as recebe. */
export const RulesPreview = z
  .object({
    claude: z.string().max(2_500_000),
    codex: z.string().max(2_500_000),
    acp: z.string().max(2_500_000),
  })
  .strict();
export type RulesPreview = z.infer<typeof RulesPreview>;

export const rulesInternalSchemas = {} as const;

export const rulesCommandSchemas = {
  /** As regras de um nível (null = geral), com os avisos. */
  'rules.list': { payload: Scope, result: ProjectRulesView },
  /** Cria ou altera uma regra; devolve a lista desse nível. */
  'rules.save': { payload: RuleInput, result: ProjectRulesView },
  'rules.delete': {
    payload: Scope.extend({ id: Id }).strict(),
    result: ProjectRulesView,
  },
  /** Repõe o estado anterior das regras. Sem histórico, não muda nada. */
  'rules.undo': { payload: Scope, result: ProjectRulesView },
  /** O texto exato que cada agente recebe no arranque deste nível (geral + projeto). */
  'rules.preview': { payload: Scope, result: RulesPreview },
} as const;
