import type { ModeOption, ModeRisk } from '@solline/protocol';
import type { AgentDefinition } from '../agents/registry.ts';

/** Do mais fechado ao mais aberto. */
const ORDER: readonly ModeRisk[] = ['read-only', 'plan', 'ask', 'edits', 'auto', 'full'];

const rank = (risk: ModeRisk): number => ORDER.indexOf(risk);

/** Um modo que não escreve nada por si: só ler (Codex) ou planear (Claude). */
export function isReadOnlyRisk(risk: ModeRisk): boolean {
  return risk === 'read-only' || risk === 'plan';
}

/**
 * O modo só de leitura de um agente, pelos modos que ele já declara (o Claude em planeamento, o
 * Codex com sandbox só de leitura). Sem modos declarados (agentes ACP), é o motor que o escolhe
 * quando o agente os anuncia, e recusa a consulta se não houver nenhum.
 */
export function readOnlyModeFor(
  definition: Pick<AgentDefinition, 'staticModes'>,
): string | undefined {
  const modes = definition.staticModes;
  return (
    modes.find((mode) => mode.risk === 'read-only') ?? modes.find((mode) => mode.risk === 'plan')
  )?.id;
}

/** O modo (já anunciado) que serve a uma consulta: o atual se for de leitura, senão o mais fechado. */
export function readOnlyModeOf(
  modes: readonly ModeOption[],
  current: string | null,
): ModeOption | undefined {
  const own = modes.find((mode) => mode.id === current && isReadOnlyRisk(mode.risk));
  return (
    own ??
    modes.find((mode) => mode.risk === 'read-only') ??
    modes.find((mode) => mode.risk === 'plan')
  );
}

export interface DelegateMode {
  id: string | null;
  label: string | null;
  /** O modo de quem delegou era de acesso total e desceu para edições sem perguntar. */
  lowered: boolean;
}

/**
 * O modo da sessão delegada: o de quem delegou, com o acesso total (`bypassPermissions`, ou um
 * modo de risco `full`) rebaixado para as edições sem perguntar (`acceptEdits`). Noutro agente,
 * o modo do mesmo risco; sem esse, o mais aberto que não passe do risco de quem delegou; sem
 * nenhum (agentes ACP, sem modos conhecidos), o que o agente tiver por omissão.
 */
export function delegateMode(
  callerMode: string | null,
  caller: Pick<AgentDefinition, 'id' | 'staticModes' | 'defaultMode'>,
  target: Pick<AgentDefinition, 'id' | 'staticModes' | 'defaultMode'>,
): DelegateMode {
  const callerOption = caller.staticModes.find((mode) => mode.id === callerMode);
  const full = callerMode === 'bypassPermissions' || callerOption?.risk === 'full';
  // Um modo que o agente não declara fica no mais cauteloso que se conhece: perguntar.
  const wanted: ModeRisk = full ? 'edits' : (callerOption?.risk ?? 'ask');
  if (caller.id === target.id && !full && callerMode) {
    const same = target.staticModes.find((mode) => mode.id === callerMode);
    if (same) return { id: same.id, label: same.label, lowered: false };
  }
  const options = target.staticModes.filter((mode) => mode.risk !== 'full');
  const exact = options.find((mode) => mode.risk === wanted);
  const closest = [...options]
    .filter((mode) => rank(mode.risk) <= rank(wanted))
    .sort((a, b) => rank(b.risk) - rank(a.risk))[0];
  const fallback = target.staticModes.find((mode) => mode.id === target.defaultMode);
  const chosen = exact ?? closest ?? fallback;
  return chosen
    ? { id: chosen.id, label: chosen.label, lowered: full }
    : { id: null, label: null, lowered: full };
}
