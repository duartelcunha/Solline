import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, Layers } from 'lucide-react';
import type { AgentCapabilities, RaceLaneSpec, SessionSettings } from '@solline/protocol';
import { MenuShell } from '../../components/menu.tsx';
import { useApp } from '../../stores/app.ts';
import { shortModelName } from '../composer/pills.tsx';
import { laneKey, laneOptions, type LaneOption } from './lane-options.ts';

/** Pastilha do compositor (o mesmo desenho das outras). */
const pillClass =
  'pill inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-line px-2.5 text-[12px] whitespace-nowrap text-muted outline-none sl-press hover:border-line-strong hover:bg-surface-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)] disabled:opacity-50 data-[state=open]:border-line-strong data-[state=open]:bg-surface-hover data-[state=open]:text-fg';

export const MAX_LANES = 4;

type Option = LaneOption;

/**
 * "N×": o mesmo pedido em várias pistas. A primeira é sempre a sessão como está (agente e
 * modelo); marcam-se até mais três, de qualquer agente pronto. 1× é uma mensagem normal.
 */
export function RacePill({
  agent,
  settings,
  capabilities,
  lanes,
  onLanes,
  disabled,
}: {
  agent: string;
  settings: SessionSettings;
  capabilities: AgentCapabilities;
  lanes: RaceLaneSpec[];
  onLanes: (lanes: RaceLaneSpec[]) => void;
  disabled: boolean;
}) {
  const agents = useApp((s) => s.agents);
  const current: RaceLaneSpec = { agent, ...(settings.model ? { model: settings.model } : {}) };
  // As outras pistas possíveis: os outros modelos deste agente e os outros agentes prontos.
  const options = laneOptions({
    agent,
    model: settings.model,
    models: capabilities.models,
    agents,
    modelLabel: (m) => shortModelName(m, m.id),
  });
  const extras = lanes.slice(1);
  const chosen = new Set(extras.map(laneKey));
  const count = Math.max(1, lanes.length);
  const toggle = (option: Option) => {
    const next = chosen.has(option.key)
      ? extras.filter((l) => laneKey(l) !== option.key)
      : [...extras, option.lane].slice(0, MAX_LANES - 1);
    onLanes(next.length ? [current, ...next] : []);
  };
  if (options.length === 0) return null;
  return (
    <MenuShell
      title="Corrida: o mesmo pedido em várias pistas"
      trigger={
        <Menu.Trigger
          disabled={disabled}
          data-testid="pill-race"
          aria-label={`${count} pistas. Mudar`}
          className={`${pillClass} ${count > 1 ? 'border-line-strong text-fg' : ''}`}
        >
          <Layers size={13} />
          <span className="tabular-nums">{count}×</span>
        </Menu.Trigger>
      }
    >
      {options.map((option) => {
        const on = chosen.has(option.key);
        const full = !on && extras.length >= MAX_LANES - 1;
        return (
          <Menu.CheckboxItem
            key={option.key}
            checked={on}
            disabled={full}
            onSelect={(e) => {
              e.preventDefault();
              toggle(option);
            }}
            className="group flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-hover"
            data-testid={`race-lane-${option.key.replace(':', '-')}`}
          >
            <span className="grid size-4 place-items-center">
              {on ? <Check size={13} /> : null}
            </span>
            {option.label}
          </Menu.CheckboxItem>
        );
      })}
    </MenuShell>
  );
}
