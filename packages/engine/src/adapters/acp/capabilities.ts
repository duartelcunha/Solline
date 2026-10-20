import type {
  NewSessionResponse,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionModeState,
} from '@agentclientprotocol/sdk';
import type { AgentCapabilities, ModeOption, ModeRisk, ModelOption } from '@solline/protocol';

/**
 * O risco de um modo de um agente ACP, só pelo id e pelo nome (cada agente inventa os seus).
 * Os de acesso total ficam escondidos.
 */
export function classifyModeRisk(id: string, name: string): ModeRisk {
  const text = `${id} ${name}`.toLowerCase();
  if (/yolo|bypass|full[ -_]?access|auto[ -_]?approve|never|dangerous|unsafe/.test(text))
    return 'full';
  if (/plan/.test(text)) return 'plan';
  if (/read[ -_]?only|readonly|\bread\b|view|chat|ask[ -_]?only/.test(text)) return 'read-only';
  if (/accept[ -_]?edits|edits?\b|write/.test(text)) return 'edits';
  if (/\bauto\b|agent|build/.test(text)) return 'auto';
  return 'ask';
}

/** As escolhas de uma opção de seleção (com ou sem grupos). */
export function modeChoices(option: SessionConfigOption): SessionConfigSelectOption[] {
  return selectOptions(option);
}

function selectOptions(option: SessionConfigOption): SessionConfigSelectOption[] {
  if (option.type !== 'select') return [];
  const options = option.options as unknown[];
  return options.flatMap((o) =>
    typeof o === 'object' && o !== null && 'group' in o
      ? ((o as unknown as { options: SessionConfigSelectOption[] }).options ?? [])
      : [o as SessionConfigSelectOption],
  );
}

/** Os modelos à moda antiga (Gemini e outros, antes das config options). */
interface LegacyModels {
  availableModels?: { modelId: string; name: string; description?: string | null }[];
  currentModelId?: string;
}

export interface AcpConfig {
  /** Opção de config por categoria, quando o agente as tem. */
  mode?: SessionConfigOption | undefined;
  model?: SessionConfigOption | undefined;
  effort?: SessionConfigOption | undefined;
  legacyModes?: SessionModeState | null | undefined;
  legacyModels?: LegacyModels | undefined;
}

export function acpConfig(
  session: Pick<NewSessionResponse, 'configOptions' | 'modes'> & { models?: unknown },
): AcpConfig {
  const options = session.configOptions ?? [];
  const byCategory = (category: string) => options.find((o) => o.category === category);
  return {
    mode: byCategory('mode'),
    model: byCategory('model'),
    effort: byCategory('thought_level'),
    legacyModes: session.modes ?? null,
    legacyModels: (session.models ?? undefined) as LegacyModels | undefined,
  };
}

export interface AcpSettings {
  mode: string | null;
  model: string | null;
  effort: string | null;
}

export function acpSettings(config: AcpConfig): AcpSettings {
  const current = (o: SessionConfigOption | undefined) =>
    o && o.type === 'select' ? String((o as { currentValue: string }).currentValue) : null;
  return {
    mode: current(config.mode) ?? config.legacyModes?.currentModeId ?? null,
    model: current(config.model) ?? config.legacyModels?.currentModelId ?? null,
    effort: current(config.effort),
  };
}

/** O que a Solline mostra de um agente ACP: modelos, modos (sem acesso total) e effort. */
export function capabilitiesFromAcp(
  config: AcpConfig,
  features: { resume: boolean; cost: boolean },
): AgentCapabilities {
  const efforts = config.effort ? selectOptions(config.effort).map((o) => o.value) : [];
  const models: ModelOption[] = config.model
    ? selectOptions(config.model).map((o) => ({
        id: o.value,
        resolved: null,
        label: o.name,
        description: o.description ?? '',
        efforts,
      }))
    : (config.legacyModels?.availableModels ?? []).map((m) => ({
        id: m.modelId,
        resolved: null,
        label: m.name,
        description: m.description ?? '',
        efforts,
      }));
  const rawModes: { id: string; name: string; description?: string | null }[] = config.mode
    ? selectOptions(config.mode).map((o) => ({
        id: o.value,
        name: o.name,
        description: o.description,
      }))
    : (config.legacyModes?.availableModes ?? []);
  const modes: ModeOption[] = rawModes
    .map((m) => ({
      id: m.id,
      label: m.name,
      description: m.description ?? '',
      risk: classifyModeRisk(m.id, m.name),
    }))
    .filter((m) => m.risk !== 'full');
  return {
    models,
    modes,
    effort: efforts.length > 0,
    effortOrder: efforts,
    features: { cost: features.cost, context: true, resume: features.resume },
  };
}

const SAFETY: ModeRisk[] = ['read-only', 'plan', 'ask', 'edits', 'auto'];

/** O modo mais fechado que o agente oferece (para sair de um modo de acesso total). */
export function safestMode(modes: readonly ModeOption[]): ModeOption | undefined {
  return [...modes].sort((a, b) => SAFETY.indexOf(a.risk) - SAFETY.indexOf(b.risk))[0];
}
