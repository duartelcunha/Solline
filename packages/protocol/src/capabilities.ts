import type { ModelOption } from './conversation.ts';

/**
 * Procura um modelo pelo id ou pelo id canónico (o agente pode reportar
 * claude-haiku-5-5 quando se pediu haiku). Serve o motor e a interface.
 */
export function findModel(
  models: readonly ModelOption[],
  current: string | null,
): ModelOption | undefined {
  if (!current) return undefined;
  return models.find((m) => m.id === current) ?? models.find((m) => m.resolved === current);
}
