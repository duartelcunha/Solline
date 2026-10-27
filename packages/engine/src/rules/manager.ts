import { randomUUID } from 'node:crypto';
import {
  RULES_PER_PROJECT,
  RULE_MAX_TEXT,
  RulesState,
  emptyRules,
  type CommandPayload,
  type NativeRuleFile,
  type ProjectRule,
  type ProjectRules,
  type ProjectRulesView,
  type RulesImportResult,
  type RulesWarning,
} from '@solline/protocol';
import type { NativeFile } from './files.ts';
import { INDEX_TITLE, lengthWarning, nativeWarning } from './render.ts';
import { splitSections } from './sections.ts';

interface Options {
  /** Guarda o estado novo (no motor, vai para o diário). Se falhar, o estado não muda. */
  save(state: RulesState): void;
}

/** Duas regras iguais a menos de maiúsculas e espaços são a mesma. */
function fingerprint(title: string, text: string): string {
  const flat = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
  return `${flat(title)}\0${flat(text)}`;
}

/** Só `@ficheiro` (importações do Claude Code): não é uma regra. */
function onlyImports(text: string): boolean {
  return text.split('\n').every((line) => line.trim() === '' || /^@\S+$/.test(line.trim()));
}

function warningsOf(project: Pick<ProjectRules, 'rules' | 'importedFrom'>): RulesWarning[] {
  return [lengthWarning(project.rules), nativeWarning(project.importedFrom)].filter(
    (warning): warning is RulesWarning => warning !== undefined,
  );
}

/**
 * As regras de cada projeto. Escritas pelo utilizador; este gestor nunca inventa conteúdo. O estado
 * inteiro viaja como o dos Espaços (um evento com tudo) e fica no diário de recuperação.
 */
export class RulesManager {
  readonly #options: Options;
  #state: RulesState = emptyRules();

  constructor(options: Options) {
    this.#options = options;
  }

  snapshot(): RulesState {
    return structuredClone(this.#state);
  }

  restore(saved: RulesState | undefined): void {
    this.#state = saved ? RulesState.parse(structuredClone(saved)) : emptyRules();
  }

  #commit(next: RulesState, projectId: string): void {
    const project = next.projects[projectId];
    if (project) project.warnings = warningsOf(project);
    next.revision = this.#state.revision + 1;
    const parsed = RulesState.parse(next);
    this.#options.save(parsed);
    this.#state = parsed;
  }

  #project(next: RulesState, projectId: string): ProjectRules {
    return (next.projects[projectId] ??= { rules: [], importedFrom: [], warnings: [] });
  }

  view(projectId: string): ProjectRulesView {
    const project = this.#state.projects[projectId];
    return structuredClone({
      projectId,
      rules: project?.rules ?? [],
      importedFrom: project?.importedFrom ?? [],
      warnings: project?.warnings ?? [],
    });
  }

  /** As regras ativas do projeto (o que os agentes recebem). */
  enabled(projectId: string): ProjectRule[] {
    return structuredClone(
      (this.#state.projects[projectId]?.rules ?? []).filter((rule) => rule.enabled),
    );
  }

  get(projectId: string, id: string): ProjectRule | undefined {
    const rule = this.#state.projects[projectId]?.rules.find((item) => item.id === id);
    return rule ? structuredClone(rule) : undefined;
  }

  save(input: CommandPayload<'rules.save'>): ProjectRulesView {
    const next = this.snapshot();
    const project = this.#project(next, input.projectId);
    const existing = input.id ? project.rules.find((rule) => rule.id === input.id) : undefined;
    if (input.id && !existing) throw new Error('Esta regra já não existe.');
    if (!existing && project.rules.length >= RULES_PER_PROJECT)
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
      project.rules.push({
        id: this.#newId(project),
        projectId: input.projectId,
        title: input.title,
        text: input.text,
        globs: input.globs,
        enabled: input.enabled,
        createdAt: now,
        updatedAt: now,
      });
    }
    this.#commit(next, input.projectId);
    return this.view(input.projectId);
  }

  delete(projectId: string, id: string): ProjectRulesView {
    const next = this.snapshot();
    const project = this.#project(next, projectId);
    if (!project.rules.some((rule) => rule.id === id)) return this.view(projectId);
    project.rules = project.rules.filter((rule) => rule.id !== id);
    this.#commit(next, projectId);
    return this.view(projectId);
  }

  /** Importa as secções dos ficheiros lidos: uma regra por `##`, sem repetir as que já existem. */
  importFiles(projectId: string, files: readonly NativeFile[]): RulesImportResult {
    const next = this.snapshot();
    const project = this.#project(next, projectId);
    const known = new Set(project.rules.map((rule) => fingerprint(rule.title, rule.text)));
    const imported: ProjectRule[] = [];
    const skipped: RulesImportResult['skipped'] = [];
    const handWritten = new Set<NativeRuleFile>(project.importedFrom);
    const now = Date.now();
    for (const file of files) {
      if (file.state !== 'read' || file.text === undefined) continue;
      let contributed = false;
      for (const section of splitSections(file.text, file.name)) {
        if (section.title === INDEX_TITLE) continue;
        if (!section.text || onlyImports(section.text)) {
          skipped.push({ title: section.title, reason: 'empty' });
          continue;
        }
        if (section.text.length > RULE_MAX_TEXT) {
          skipped.push({ title: section.title, reason: 'too-long' });
          continue;
        }
        const key = fingerprint(section.title, section.text);
        if (known.has(key)) {
          skipped.push({ title: section.title, reason: 'duplicate' });
          contributed = true;
          continue;
        }
        if (project.rules.length >= RULES_PER_PROJECT) {
          skipped.push({ title: section.title, reason: 'limit' });
          continue;
        }
        known.add(key);
        contributed = true;
        const rule: ProjectRule = {
          id: this.#newId(project),
          projectId,
          title: section.title,
          text: section.text,
          globs: [],
          enabled: true,
          createdAt: now,
          updatedAt: now,
        };
        project.rules.push(rule);
        imported.push(rule);
      }
      if (contributed && file.handWritten) handWritten.add(file.name);
    }
    project.importedFrom = [...handWritten].sort();
    const changed =
      imported.length > 0 || project.importedFrom.length !== this.#importedCount(projectId);
    if (changed) this.#commit(next, projectId);
    return {
      imported: structuredClone(imported),
      skipped,
      files: files.map((file) => ({ name: file.name, state: file.state })),
    };
  }

  #importedCount(projectId: string): number {
    return this.#state.projects[projectId]?.importedFrom.length ?? 0;
  }

  /** Depois de exportar, os ficheiros da pasta são os da Solline: o aviso de duplicação acaba. */
  exported(projectId: string): void {
    if (this.#importedCount(projectId) === 0) return;
    const next = this.snapshot();
    this.#project(next, projectId).importedFrom = [];
    this.#commit(next, projectId);
  }

  #newId(project: ProjectRules): string {
    for (;;) {
      const id = randomUUID().slice(0, 8);
      if (!project.rules.some((rule) => rule.id === id)) return id;
    }
  }
}
