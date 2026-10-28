import type { MemoryCitation, SpaceMemory } from '@solline/protocol';

/** Onde uma memória vai viver depois de aprovada. O nível geral é sempre uma decisão tua. */
export type MemoryScope = 'project' | 'global';

/** As propostas por aprovar, as mais recentes primeiro. Em Geral (null) veem-se as de todos os projetos. */
export function pendingFor(
  memories: readonly SpaceMemory[],
  projectId: string | null,
): SpaceMemory[] {
  return memories
    .filter((m) => m.state === 'pending' && (projectId === null || m.projectId === projectId))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** As memórias aprovadas cuja prova mudou (ou que ficaram muito tempo sem uso). */
export function toConfirmFor(
  memories: readonly SpaceMemory[],
  projectId: string | null,
): SpaceMemory[] {
  return memories
    .filter((m) => m.state === 'toConfirm' && (projectId === null || m.projectId === projectId))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Quantas propostas esperam por ti, no total e por projeto (para o contador da barra lateral). */
export function pendingCounts(memories: readonly SpaceMemory[]): {
  total: number;
  byProject: Map<string, number>;
} {
  const byProject = new Map<string, number>();
  let total = 0;
  for (const m of memories) {
    if (m.state !== 'pending') continue;
    total += 1;
    if (m.projectId !== null) byProject.set(m.projectId, (byProject.get(m.projectId) ?? 0) + 1);
  }
  return { total, byProject };
}

/** A prova como se lê: `src/db.ts:12-20`, `README.md` ou `commit a1b2c3d`. */
export function citationLabel(citation: MemoryCitation): string {
  if ('commit' in citation) return `commit ${citation.commit.slice(0, 10)}`;
  if (citation.line === undefined) return citation.path;
  return citation.endLine !== undefined && citation.endLine !== citation.line
    ? `${citation.path}:${citation.line}-${citation.endLine}`
    : `${citation.path}:${citation.line}`;
}

/** O que se copia ao clicar na prova: o mesmo texto, para colar numa pesquisa ou num terminal. */
export function citationCopy(citation: MemoryCitation): string {
  return 'commit' in citation ? citation.commit : citationLabel(citation);
}

/** Porque uma memória está «a confirmar», numa frase. */
export function staleLabel(memory: SpaceMemory): string {
  return memory.stale === 'age'
    ? 'Ficou 28 dias sem ser usada nem aprovada de novo.'
    : 'O que a prova citava mudou desde que a aprovaste.';
}

/**
 * Uma proposta que um agente fez depois de ler a web ou servidores de terceiros não se aprova em
 * lote: lê-se e aprova-se uma a uma.
 */
export function batchSelectable(memory: SpaceMemory): boolean {
  return !memory.external;
}

export interface ApprovalChoice {
  id: string;
  scope: MemoryScope;
  /** O texto editado, se mudou. */
  text?: string;
}

export interface ApprovalCall {
  scope: MemoryScope;
  ids: string[];
  edits: Record<string, { text: string }>;
}

/** Aprovar muitas de uma vez: uma chamada por âmbito, cada uma com as suas edições. */
export function planApproval(choices: readonly ApprovalChoice[]): ApprovalCall[] {
  const calls = new Map<MemoryScope, ApprovalCall>();
  for (const choice of choices) {
    const call = calls.get(choice.scope) ?? { scope: choice.scope, ids: [], edits: {} };
    call.ids.push(choice.id);
    if (choice.text !== undefined) call.edits[choice.id] = { text: choice.text };
    calls.set(choice.scope, call);
  }
  return [...calls.values()];
}

/** O projeto onde a prova mora: serve para passar a memória a regra. */
export function ruleProjectOf(memory: SpaceMemory): string | null {
  return memory.projectId ?? memory.origin?.projectId ?? null;
}
