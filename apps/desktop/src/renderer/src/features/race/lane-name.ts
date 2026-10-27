import type { RaceLane } from '@solline/protocol';

export const LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

/** "claude-haiku-5-5" -> "haiku 5.5": o modelo curto, como nas pílulas. */
export const shortModel = (model: string) =>
  model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2');

export const laneName = (lane: RaceLane) =>
  `${LABELS[lane.agent] ?? lane.agent}${lane.model ? ` · ${shortModel(lane.model)}` : ''}`;
