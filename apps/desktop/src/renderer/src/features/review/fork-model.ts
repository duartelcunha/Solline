import type { Checkpoint, Timeline, Workspace } from '@solline/protocol';

/** "Bifurcar daqui" em modelo puro: quando se pode, e porque não quando não se pode. */

export interface ForkGate {
  enabled: boolean;
  /** Porque está desligado (para o título e o menu); null quando se pode. */
  reason: string | null;
}

/**
 * Bifurcar precisa de git (a sessão nova ganha a sua worktree) e de a origem estar parada;
 * o turno tem de estar acabado (é do fim dele que partem os ficheiros e a conversa).
 */
export function forkGate(input: {
  timeline: Pick<Timeline, 'available'> | null;
  workspace: Workspace | undefined;
  busy: boolean;
  checkpoint?: Pick<Checkpoint, 'state'> | undefined;
}): ForkGate {
  if (!input.timeline?.available || input.workspace?.kind === 'shared')
    return { enabled: false, reason: 'Só em projetos git' };
  if (input.busy) return { enabled: false, reason: 'O agente ainda está a trabalhar' };
  if (input.checkpoint && input.checkpoint.state !== 'done')
    return { enabled: false, reason: 'O turno ainda não acabou' };
  return { enabled: true, reason: null };
}

/** Os turnos de onde se pode bifurcar, do mais recente para o mais antigo. */
export function forkTargets(
  checkpoints: readonly Checkpoint[],
): { turnId: string; index: number; title: string; state: Checkpoint['state'] }[] {
  return checkpoints
    .map((c) => ({ turnId: c.turnId, index: c.index, title: c.title, state: c.state }))
    .reverse();
}

/**
 * O ponto escolhido na linha do tempo ("antes do turno N") é o fim do turno anterior: é daí
 * que parte a bifurcação. No primeiro ponto não há turno anterior.
 */
export function forkTurnAtStop(
  checkpoints: readonly Checkpoint[],
  stop: number,
): Checkpoint | undefined {
  return stop >= 1 ? checkpoints[Math.min(stop, checkpoints.length) - 1] : undefined;
}
