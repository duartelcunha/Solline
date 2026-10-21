import type { AgentDescriptor, AgentId, SessionState } from '@solline/protocol';
import type { Hood, Mood } from '@solline/ui/bot';

/** Da sessão para o bot, em funções puras (o desenho vive em @solline/ui/bot). */

/** Os olhos contentes depois de um turno acabado duram isto. */
export const DONE_MS = 1_400;
/** Parado há mais do que isto, o bot adormece. */
export const SLEEP_MS = 10 * 60_000;

/** Claude e Codex têm a sua cor; os agentes ACP partilham uma; os outros, outra. */
export function hoodOf(agent: AgentId, transport?: AgentDescriptor['transport']): Hood {
  if (agent === 'claude') return 'claude';
  if (agent === 'codex') return 'codex';
  return transport === 'acp' ? 'acp' : 'other';
}

export interface MoodInput {
  state: SessionState;
  stateSince: number;
  turnEndedAt: number | null;
}

/** O humor a partir do estado e do tempo (função pura, testável). */
export function moodOf({ state, stateSince, turnEndedAt }: MoodInput, now: number): Mood {
  if (state === 'running' || state === 'starting') return 'working';
  if (state === 'needs-you') return 'needs-you';
  if (state === 'error') return 'crashed';
  if (turnEndedAt !== null && now - turnEndedAt < DONE_MS) return 'done';
  return now - stateSince >= SLEEP_MS ? 'sleeping' : 'waiting';
}

/** Quando o humor pode mudar sozinho (fim dos olhos contentes, adormecer), ou null. */
export function nextMoodChange(
  { state, stateSince, turnEndedAt }: MoodInput,
  now: number,
): number | null {
  if (state !== 'idle') return null;
  if (turnEndedAt !== null && now - turnEndedAt < DONE_MS) return turnEndedAt + DONE_MS;
  const sleepAt = stateSince + SLEEP_MS;
  return sleepAt > now ? sleepAt : null;
}
