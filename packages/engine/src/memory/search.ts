import type { SpaceMemory } from '@solline/protocol';
import { describeCitation } from './keys.ts';
import { lastActivity } from './staleness.ts';

/** Minúsculas, sem acentos, só letras e números (o que um agente escreve e o que está guardado batem). */
export function terms(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 2);
}

const WEIGHT = { text: 3, reason: 2, path: 1 } as const;

/** O termo aparece (inteiro, ou como início de uma palavra com 3 letras ou mais). */
function hit(words: readonly string[], term: string): boolean {
  return words.some((word) => word === term || (term.length >= 3 && word.startsWith(term)));
}

/**
 * Pontuação simples por termos (sem embeddings): cada termo da pergunta conta uma vez por campo,
 * com mais peso no texto do que no motivo e nos caminhos citados. 0 = não serve.
 */
export function scoreMemory(memory: SpaceMemory, query: readonly string[]): number {
  const text = terms(memory.text);
  const reason = terms(memory.reason);
  const paths = memory.citations.flatMap((c) => terms(describeCitation(c)));
  let score = 0;
  for (const term of new Set(query)) {
    if (hit(text, term)) score += WEIGHT.text;
    if (hit(reason, term)) score += WEIGHT.reason;
    if (hit(paths, term)) score += WEIGHT.path;
  }
  return score;
}

/** As memórias que respondem à pergunta, da melhor para a pior (empates: a mais recente). */
export function searchMemories(
  memories: readonly SpaceMemory[],
  query: string,
  limit: number,
): SpaceMemory[] {
  const wanted = terms(query);
  if (wanted.length === 0) return [];
  return memories
    .map((memory) => ({ memory, score: scoreMemory(memory, wanted) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        lastActivity(b.memory) - lastActivity(a.memory) ||
        a.memory.id.localeCompare(b.memory.id),
    )
    .slice(0, limit)
    .map((entry) => entry.memory);
}
