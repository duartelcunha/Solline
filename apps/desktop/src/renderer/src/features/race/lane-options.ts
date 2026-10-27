import type { AgentDescriptor, ModelOption, RaceLaneSpec } from '@solline/protocol';

/** Uma escolha de agente e modelo: o mesmo desenho para as corridas e para as partes. */
export interface LaneOption {
  key: string;
  lane: RaceLaneSpec;
  label: string;
}

export const laneKey = (lane: RaceLaneSpec): string => `${lane.agent}:${lane.model ?? ''}`;

/**
 * As escolhas possíveis a partir de uma sessão: os outros modelos do agente dela e os outros
 * agentes prontos (o modelo de cada um escolhe-se depois, na própria sessão).
 * `includeCurrent` põe à frente o que a sessão já tem, para quem escolhe de entre todos.
 */
export function laneOptions({
  agent,
  model,
  models,
  agents,
  modelLabel,
  includeCurrent = false,
}: {
  agent: string;
  model: string | null;
  models: readonly ModelOption[];
  agents: readonly Pick<AgentDescriptor, 'id' | 'label' | 'status'>[];
  modelLabel: (model: ModelOption) => string;
  includeCurrent?: boolean;
}): LaneOption[] {
  const current: LaneOption[] = includeCurrent
    ? [
        {
          key: laneKey({ agent, ...(model ? { model } : {}) }),
          lane: { agent, ...(model ? { model } : {}) },
          label: (() => {
            const found = models.find((m) => m.id === model);
            return found ? modelLabel(found) : (agents.find((a) => a.id === agent)?.label ?? agent);
          })(),
        },
      ]
    : [];
  return [
    ...current,
    ...models
      .filter((m) => m.id !== model && m.id !== 'default')
      .map((m) => ({
        key: `${agent}:${m.id}`,
        lane: { agent, model: m.id },
        label: modelLabel(m),
      })),
    ...agents
      .filter((a) => a.id !== agent && a.status === 'ready')
      .map((a) => ({ key: `${a.id}:`, lane: { agent: a.id }, label: a.label })),
  ];
}
