import { create } from 'zustand';
import { emptyRules, type ProjectRulesView, type RulesState } from '@solline/protocol';

/** As regras do projeto como o motor as guarda; o estado inteiro chega num evento (rules.changed). */
export const useRules = create<{ data: RulesState }>(() => ({ data: emptyRules() }));

export function receiveRules(data: RulesState): void {
  useRules.setState((current) => (data.revision >= current.data.revision ? { data } : {}));
}

/** A vista de um projeto (lista, avisos), vazia se ainda não tem regras. */
export function rulesOf(data: RulesState, projectId: string): ProjectRulesView {
  const project = data.projects[projectId];
  return {
    projectId,
    rules: project?.rules ?? [],
    importedFrom: project?.importedFrom ?? [],
    warnings: project?.warnings ?? [],
  };
}
