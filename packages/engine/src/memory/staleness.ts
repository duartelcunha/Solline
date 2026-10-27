import type { SpaceMemory } from '@solline/protocol';
import { evidenceKey } from './keys.ts';

/** Uma memória de um agente que ninguém lê há este tempo passa a "a confirmar". */
export const STALE_AFTER_MS = 28 * 24 * 60 * 60 * 1000;

/** O último sinal de vida: aprovação, uso por um agente ou, em memórias antigas, a criação. */
export function lastActivity(
  memory: Pick<SpaceMemory, 'approvedAt' | 'lastUsedAt' | 'createdAt'>,
): number {
  return Math.max(memory.approvedAt ?? 0, memory.lastUsedAt ?? 0, memory.createdAt);
}

/**
 * Porque é que uma memória aprovada deve passar a "a confirmar", ou null se continua válida.
 * Pura: `current` é o hash que cada intervalo citado tem agora (chave = evidenceKey; `undefined`
 * quando o ficheiro desapareceu ou o intervalo já não existe; chave em falta = não se conseguiu
 * ver, não conta como mudança). Só as memórias propostas por agentes caducam por idade: as que o
 * utilizador ou a análise escreveram não têm prova nem dono a quem pedir confirmação.
 */
export function staleReason(
  memory: SpaceMemory,
  current: ReadonlyMap<string, string | undefined>,
  now: number,
): 'evidence' | 'age' | null {
  if (memory.state !== 'active') return null;
  for (const proof of memory.evidence) {
    const key = evidenceKey(proof);
    if (current.has(key) && current.get(key) !== proof.hash) return 'evidence';
  }
  if (memory.origin !== null && now - lastActivity(memory) >= STALE_AFTER_MS) return 'age';
  return null;
}

/** O aviso que o agente lê junto de uma memória "a confirmar". */
export function staleNote(reason: 'evidence' | 'age' | null): string | undefined {
  if (reason === 'evidence')
    return 'A confirmar: a prova mudou (o código citado já não é o que o utilizador aprovou). Confirma no código antes de te apoiares nisto.';
  if (reason === 'age')
    return 'A confirmar: 28 dias sem uso. Pode estar desatualizada; confirma no código antes de te apoiares nisto.';
  return undefined;
}
