import { create } from 'zustand';
import { emptyRules, type ProjectRulesView, type RulesState } from '@solline/protocol';

/** As regras do projeto como o motor as guarda; o estado inteiro chega num evento (rules.changed). */
export const useRules = create<{ data: RulesState }>(() => ({ data: emptyRules() }));

export function receiveRules(data: RulesState): void {
  useRules.setState((current) => (data.revision >= current.data.revision ? { data } : {}));
}

/** A vista de um nível (null = geral). */
export function rulesOf(data: RulesState, projectId: string | null): ProjectRulesView {
  const bucket = projectId === null ? data.global : data.projects[projectId];
  return {
    projectId,
    rules: bucket?.rules ?? [],
    warnings: bucket?.warnings ?? [],
    canUndo: data.history.length > 0,
  };
}
