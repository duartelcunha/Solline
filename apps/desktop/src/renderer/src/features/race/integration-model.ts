import type { IntegrationStep, Race, RaceLane } from '@solline/protocol';

/**
 * Como a integração de uma repartição se mostra: a lista de passos (os já feitos e os que
 * faltam), quem resolve um conflito e os tempos em palavras. Tudo puro.
 */

export interface StepRow {
  sessionId: string;
  title: string;
  /** done: juntada · conflict: parou aqui · current: a juntar agora · waiting: ainda não chegou. */
  status: 'done' | 'conflict' | 'current' | 'waiting';
  step: IntegrationStep | null;
}

const titleOf = (race: Race, sessionId: string): string =>
  race.lanes.find((l) => l.sessionId === sessionId)?.part?.title ?? 'Parte';

/** Os passos feitos, pela ordem em que aconteceram, e depois as partes que faltam juntar. */
export function stepRows(race: Race): StepRow[] {
  const integration = race.integration;
  if (!integration) return [];
  const done = new Set(integration.steps.map((s) => s.sessionId));
  const rows: StepRow[] = integration.steps.map((step) => ({
    sessionId: step.sessionId,
    title: step.title,
    status: step.merged ? 'done' : 'conflict',
    step,
  }));
  const order = new Map((race.split?.lanes ?? []).map((info) => [info.sessionId, info.index]));
  const remaining = race.lanes
    .filter((lane) => !done.has(lane.sessionId))
    .sort((a, b) => (order.get(a.sessionId) ?? 0) - (order.get(b.sessionId) ?? 0));
  remaining.forEach((lane, i) =>
    rows.push({
      sessionId: lane.sessionId,
      title: titleOf(race, lane.sessionId),
      status: i === 0 && integration.state === 'merging' ? 'current' : 'waiting',
      step: null,
    }),
  );
  return rows;
}

/**
 * Quem resolve um conflito: como o motor, a parte zero, senão a primeira já juntada, senão a que
 * chocou. Só serve para dizer o nome do agente no botão.
 */
export function resolverLane(race: Race): RaceLane | undefined {
  const conflict = race.integration?.conflict;
  if (!conflict) return undefined;
  const merged = new Set(race.integration?.steps.filter((s) => s.merged).map((s) => s.sessionId));
  return (
    race.lanes.find((l) => l.part?.zero) ??
    race.lanes.find((l) => merged.has(l.sessionId)) ??
    race.lanes.find((l) => l.sessionId === conflict.sessionId)
  );
}

/** "45 s", "2 min 5 s", "1 h 3 min": só os números, sem arredondar para parecer melhor. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min${total % 60 ? ` ${total % 60} s` : ''}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}

/** Os ficheiros de um conflito: os primeiros e quantos ficam por mostrar. */
export function visibleFiles(files: readonly string[], limit = 6) {
  return { shown: files.slice(0, limit), more: Math.max(0, files.length - limit) };
}
