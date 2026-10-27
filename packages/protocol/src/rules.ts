import { z } from 'zod';

/**
 * As regras do projeto: curtas, escritas pelo utilizador, guardadas na Solline (nunca na pasta do
 * projeto, a não ser que ele peça para exportar). A Solline não escreve o conteúdo de nenhuma.
 */

const Id = z.string().min(1).max(128);
const ProjectRef = z.string().min(1).max(128);

export const RULE_MAX_TITLE = 120;
export const RULE_MAX_TEXT = 10_000;
export const RULE_MAX_GLOBS = 20;
export const RULES_PER_PROJECT = 200;

/** Os ficheiros de instruções que os agentes leem sozinhos na raiz do projeto. */
export const NativeRuleFile = z.enum(['AGENTS.md', 'CLAUDE.md']);
export type NativeRuleFile = z.infer<typeof NativeRuleFile>;

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
    projectId: ProjectRef,
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

/** length: as regras sem padrões estão compridas demais. native: o agente pode ver duas vezes. */
export const RulesWarning = z
  .object({ kind: z.enum(['length', 'native']), text: z.string().max(1000) })
  .strict();
export type RulesWarning = z.infer<typeof RulesWarning>;

export const ProjectRules = z
  .object({
    rules: z.array(ProjectRule).max(RULES_PER_PROJECT),
    /** Ficheiros escritos à mão de onde se importaram regras (e ainda não se exportou por cima). */
    importedFrom: z.array(NativeRuleFile).max(2),
    warnings: z.array(RulesWarning).max(4),
  })
  .strict();
export type ProjectRules = z.infer<typeof ProjectRules>;

export const ProjectRulesView = ProjectRules.extend({ projectId: ProjectRef }).strict();
export type ProjectRulesView = z.infer<typeof ProjectRulesView>;

export const RulesState = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    projects: z.record(ProjectRef, ProjectRules),
  })
  .strict();
export type RulesState = z.infer<typeof RulesState>;

export function emptyRules(): RulesState {
  return { version: 1, revision: 0, projects: {} };
}

export const RuleInput = z
  .object({
    projectId: ProjectRef,
    /** Sem id cria uma regra nova; com id altera essa. */
    id: Id.optional(),
    title: z.string().trim().min(1).max(RULE_MAX_TITLE),
    text: z.string().trim().min(1).max(RULE_MAX_TEXT),
    globs: z.array(RuleGlob).max(RULE_MAX_GLOBS).default([]),
    enabled: z.boolean().default(true),
  })
  .strict();

export const RulesImportResult = z
  .object({
    imported: z.array(ProjectRule),
    skipped: z.array(
      z.object({
        title: z.string(),
        reason: z.enum(['duplicate', 'empty', 'too-long', 'limit']),
      }),
    ),
    /**
     * read: lido; missing: não existe; exported: é uma exportação da Solline por editar (nada a
     * importar); unsafe: não é um ficheiro normal (ligação simbólica, pasta).
     */
    files: z.array(
      z.object({
        name: NativeRuleFile,
        state: z.enum(['read', 'missing', 'exported', 'unsafe']),
      }),
    ),
  })
  .strict();
export type RulesImportResult = z.infer<typeof RulesImportResult>;

export const RulesConflict = z
  .object({
    path: z.string(),
    reason: z.enum(['unmarked', 'edited', 'unsafe']),
    /** Para mostrar ao utilizador. */
    message: z.string(),
  })
  .strict();
export type RulesConflict = z.infer<typeof RulesConflict>;

/** written: os ficheiros escritos (vazio se recusaste a confirmação); conflict: nada foi escrito. */
export const RulesExportResult = z.union([
  z.object({ written: z.array(z.string()) }).strict(),
  z.object({ conflict: RulesConflict }).strict(),
]);
export type RulesExportResult = z.infer<typeof RulesExportResult>;

const ProjectOnly = z.object({ projectId: ProjectRef }).strict();

export const rulesCommandSchemas = {
  /** As regras de um projeto, com os avisos (só lê). */
  'rules.list': { payload: ProjectOnly, result: ProjectRulesView },
  /** Cria ou altera uma regra; devolve a lista do projeto. */
  'rules.save': { payload: RuleInput, result: ProjectRulesView },
  'rules.delete': {
    payload: ProjectOnly.extend({ id: Id }).strict(),
    result: ProjectRulesView,
  },
  /**
   * Importa o CLAUDE.md e o AGENTS.md da raiz (main): uma regra por secção `##`, sem repetir as que
   * já existem. Com `path`, só esse ficheiro (é como se "adopta" um que a exportação recusou).
   */
  'rules.import': {
    payload: ProjectOnly.extend({ path: NativeRuleFile.optional() }).strict(),
    result: RulesImportResult,
  },
  /**
   * Escreve o AGENTS.md e o CLAUDE.md na raiz (main): pede confirmação nativa. Nunca escreve por
   * cima de um ficheiro que não é uma exportação da Solline por editar: devolve o conflito.
   */
  'rules.export': { payload: ProjectOnly, result: RulesExportResult },
} as const;

/** Só o main os manda ao motor, já com a pasta do projeto. */
export const rulesInternalSchemas = {
  'rules.importNow': {
    payload: ProjectOnly.extend({
      cwd: z.string().min(1),
      path: NativeRuleFile.optional(),
    }).strict(),
    result: RulesImportResult,
  },
  'rules.exportNow': {
    payload: ProjectOnly.extend({ cwd: z.string().min(1) }).strict(),
    result: RulesExportResult,
  },
} as const;
