import { randomUUID } from 'node:crypto';
import {
  RULES_HISTORY,
  RULES_PER_PROJECT,
  RulesState,
  emptyRules,
  type CommandPayload,
  type ProjectRule,
  type ProjectRulesView,
  type RulesPreview,
  type RulesState as RulesStateType,
  type RulesWarning,
} from '@solline/protocol';
import { CRAFT_RULES } from '../quality/craft.ts';
import { lengthWarning, renderStart } from './render.ts';

interface Options {
  /** Guarda o estado novo (no motor, vai para o diário). Se falhar, o estado não muda. */
  save(state: RulesStateType): void;
}

interface Snapshot {
  global: ProjectRule[];
  projects: Record<string, ProjectRule[]>;
}

function warningsOf(rules: readonly ProjectRule[]): RulesWarning[] {
  const warning = lengthWarning(rules);
  return warning ? [warning] : [];
}

/**
 * Regras gerais e de cada projeto. Escritas pelo utilizador; este gestor nunca inventa conteúdo.
 * O estado inteiro viaja num evento e fica no diário, fora da pasta do projeto.
 */
export class RulesManager {
  readonly #options: Options;
  #state: RulesStateType = emptyRules();

  constructor(options: Options) {
    this.#options = options;
  }

  snapshot(): RulesStateType {
    return structuredClone(this.#state);
  }

  restore(saved: unknown): void {
    this.#state = saved ? RulesState.parse(saved) : emptyRules();
    this.#recompute();
  }

  #recompute(): void {
    this.#state.global.warnings = warningsOf(this.#state.global.rules);
    for (const project of Object.values(this.#state.projects))
      project.warnings = warningsOf(project.rules);
  }

  #bucket(next: RulesStateType, projectId: string | null) {
    if (projectId === null) return next.global;
    return (next.projects[projectId] ??= { rules: [], warnings: [] });
  }

  #commit(next: RulesStateType): void {
    next.global.warnings = warningsOf(next.global.rules);
    for (const project of Object.values(next.projects)) project.warnings = warningsOf(project.rules);
    next.revision = this.#state.revision + 1;
    const parsed = RulesState.parse(next);
    this.#options.save(parsed);
    this.#state = parsed;
  }

  #remember(next: RulesStateType): void {
    const entry: Snapshot = {
      global: structuredClone(this.#state.global.rules),
      projects: Object.fromEntries(
        Object.entries(this.#state.projects).map(([id, bucket]) => [id, structuredClone(bucket.rules)]),
      ),
    };
    next.history = [...this.#state.history, entry].slice(-RULES_HISTORY);
  }

  view(projectId: string | null): ProjectRulesView {
    const bucket = projectId === null ? this.#state.global : this.#state.projects[projectId];
    return {
      projectId,
      rules: structuredClone(bucket?.rules ?? []),
      warnings: structuredClone(bucket?.warnings ?? []),
      canUndo: this.#state.history.length > 0,
    };
  }

  /** Regras ativas que um agente deste projeto recebe: gerais primeiro, depois as do projeto. */
  deliver(projectId: string | null): ProjectRule[] {
    const global = this.#state.global.rules.filter((rule) => rule.enabled);
    const own =
      projectId === null
        ? []
        : (this.#state.projects[projectId]?.rules ?? []).filter((rule) => rule.enabled);
    return structuredClone([...global, ...own]);
  }

  /** As ativas do projeto e as gerais (a ferramenta de listar). */
  enabled(projectId: string): ProjectRule[] {
    return this.deliver(projectId);
  }

  get(projectId: string, id: string): ProjectRule | undefined {
    const own = this.#state.projects[projectId]?.rules.find((rule) => rule.id === id);
    const global = this.#state.global.rules.find((rule) => rule.id === id);
    const rule = own ?? global;
    return rule ? structuredClone(rule) : undefined;
  }

  save(input: CommandPayload<'rules.save'>): ProjectRulesView {
    const next = this.snapshot();
    const bucket = this.#bucket(next, input.projectId);
    const existing = input.id ? bucket.rules.find((rule) => rule.id === input.id) : undefined;
    if (input.id && !existing) throw new Error('Esta regra já não existe.');
    if (!existing && bucket.rules.length >= RULES_PER_PROJECT)
      throw new Error(`Um projeto aceita até ${RULES_PER_PROJECT} regras.`);
    const now = Date.now();
    if (existing) {
      Object.assign(existing, {
        title: input.title,
        text: input.text,
        globs: input.globs,
        enabled: input.enabled,
        updatedAt: now,
      });
    } else {
      bucket.rules.push({
        id: this.#newId(next),
        projectId: input.projectId,
        title: input.title,
        text: input.text,
        globs: input.globs,
        enabled: input.enabled,
        createdAt: now,
        updatedAt: now,
      });
    }
    this.#remember(next);
    this.#commit(next);
    return this.view(input.projectId);
  }

  delete(projectId: string | null, id: string): ProjectRulesView {
    const next = this.snapshot();
    const bucket = this.#bucket(next, projectId);
    if (!bucket.rules.some((rule) => rule.id === id)) return this.view(projectId);
    bucket.rules = bucket.rules.filter((rule) => rule.id !== id);
    this.#remember(next);
    this.#commit(next);
    return this.view(projectId);
  }

  undo(projectId: string | null): ProjectRulesView {
    const entry = this.#state.history.at(-1);
    if (!entry) return this.view(projectId);
    const next = this.snapshot();
    next.history = this.#state.history.slice(0, -1);
    next.global = { rules: structuredClone(entry.global), warnings: [] };
    next.projects = Object.fromEntries(
      Object.entries(entry.projects).map(([id, rules]) => [id, { rules: structuredClone(rules), warnings: [] }]),
    );
    this.#commit(next);
    return this.view(projectId);
  }

  /** O texto que o arranque manda, o mesmo que a sessão usa. */
  preview(projectId: string | null): RulesPreview {
    const rules = this.deliver(projectId);
    const instructions = renderStart(rules, { target: 'instructions', readTool: true });
    const context = renderStart(rules, { target: 'context', readTool: false });
    const withCraft = instructions ? `${CRAFT_RULES}\n\n${instructions}` : CRAFT_RULES;
    return { claude: withCraft, codex: withCraft, acp: context ?? '' };
  }

  #newId(state: RulesStateType): string {
    const ids = new Set([
      ...state.global.rules.map((rule) => rule.id),
      ...Object.values(state.projects).flatMap((bucket) => bucket.rules.map((rule) => rule.id)),
    ]);
    for (;;) {
      const id = randomUUID().slice(0, 8);
      if (!ids.has(id)) return id;
    }
  }
}
