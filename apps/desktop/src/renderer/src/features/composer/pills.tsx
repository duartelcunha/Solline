import * as Menu from '@radix-ui/react-dropdown-menu';
import { useId, useState } from 'react';
import { ChevronDown, Cpu, Gauge } from 'lucide-react';
import {
  findModel,
  type AgentCapabilities,
  type ModelOption,
  type SessionSettings,
} from '@solline/protocol';
import { ModeIcon } from '../../components/icons.tsx';
import { IconSwap } from '@solline/ui/icon-swap';
import { lastInputWasKeyboard } from '@solline/ui/motion';
import { Item, MenuShell } from '../../components/menu.tsx';

/** Um controlo só: modelo, esforço e modo, com o nome sempre à vista. */
const pillClass =
  'pill inline-flex h-auto min-h-7 shrink-0 items-center gap-1.5 px-2.5 py-1 text-[12px] text-muted outline-none sl-press hover:bg-surface-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)] disabled:opacity-50 data-[state=open]:bg-surface-hover data-[state=open]:text-fg';

/** "Opus 5.5 · Best for..." -> "Opus 5.5"; se não houver versão, o nome do menu. */
export function shortModelName(model: ModelOption | undefined, current: string | null): string {
  if (!model) return current ?? 'Modelo';
  const head = model.description.split(' · ')[0]?.trim();
  return head && /\d/.test(head) && head.length <= 24 ? head : model.label;
}

export function SettingsPills({
  settings,
  capabilities,
  disabled,
  onModel,
  onEffort,
  onMode,
}: {
  settings: SessionSettings;
  capabilities: AgentCapabilities;
  disabled: boolean;
  onModel: (model: string) => void;
  onEffort: (effort: string) => void;
  onMode: (mode: string) => void;
}) {
  const model = findModel(capabilities.models, settings.model);
  const modelName = shortModelName(model, settings.model);
  const order = capabilities.effortOrder;
  const efforts = [...(model?.efforts ?? [])].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const mode = capabilities.modes.find((m) => m.id === settings.mode);
  const showEffort = capabilities.effort && efforts.length > 0;
  const showMode = capabilities.modes.length > 0;
  const effortHelpId = useId();
  const [helpDismissed, setHelpDismissed] = useState(false);
  return (
    <div
      className="inline-flex min-w-0 flex-wrap items-stretch rounded-control border border-line"
      role="group"
      aria-label="Modelo, esforço e modo"
    >
      <MenuShell
        title="Modelo"
        trigger={
          <Menu.Trigger
            disabled={disabled}
            data-testid="pill-model"
            aria-label={`Modelo: ${modelName}. Mudar`}
            title={modelName}
            className={`${pillClass} max-w-[14rem] ${showEffort || showMode ? 'border-r border-line' : ''}`}
          >
            <Cpu aria-hidden size={13} strokeWidth={1.9} className="shrink-0" />
            <span className="line-clamp-2 min-w-0 text-left leading-4 whitespace-normal">
              {modelName}
            </span>
            <ChevronDown aria-hidden size={12} strokeWidth={2} className="shrink-0 opacity-60" />
          </Menu.Trigger>
        }
      >
        <Menu.RadioGroup value={model?.id ?? ''} onValueChange={onModel}>
          {capabilities.models.map((m) => (
            <Item
              key={m.id}
              value={m.id}
              title={m.label}
              description={m.description}
              testId={`model-${m.id}`}
            />
          ))}
        </Menu.RadioGroup>
      </MenuShell>

      {showEffort ? (
        <MenuShell
          title="Esforço"
          trigger={
            <span
              className={`effort-help-group ${showMode ? 'border-r border-line' : ''}`}
              data-help-dismissed={helpDismissed}
              onPointerEnter={() => setHelpDismissed(false)}
              onFocus={() => setHelpDismissed(false)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setHelpDismissed(true);
              }}
            >
              <Menu.Trigger
                disabled={disabled}
                data-testid="pill-effort"
                aria-label={`Esforço: ${settings.effort ?? 'padrão'}. Mudar`}
                aria-describedby={effortHelpId}
                className={pillClass}
              >
                <Gauge aria-hidden size={13} strokeWidth={1.9} />
                <span>{settings.effort ?? 'esforço padrão'}</span>
                <ChevronDown aria-hidden size={12} strokeWidth={2} className="opacity-60" />
              </Menu.Trigger>
              <span
                id={effortHelpId}
                role="tooltip"
                className="effort-help"
                data-testid="effort-help"
              >
                Esforço: {settings.effort ?? 'padrão'}
              </span>
            </span>
          }
        >
          <Menu.RadioGroup value={settings.effort ?? ''} onValueChange={onEffort}>
            {efforts.map((level) => (
              <Item key={level} value={level} title={level} testId={`effort-${level}`} />
            ))}
          </Menu.RadioGroup>
        </MenuShell>
      ) : null}

      {showMode ? (
        <MenuShell
          title="Modo"
          trigger={
            <Menu.Trigger
              disabled={disabled}
              data-testid="pill-mode"
              aria-label={`Modo: ${mode?.label ?? settings.mode ?? 'padrão'}. Mudar`}
              title={`Modo: ${mode?.label ?? settings.mode ?? 'padrão'}`}
              className={`${pillClass} max-w-48`}
            >
              <IconSwap
                swapKey={mode?.id ?? settings.mode ?? 'ask'}
                instant={lastInputWasKeyboard()}
              >
                <ModeIcon risk={mode?.risk ?? 'ask'} size={14} />
              </IconSwap>
              {/* O modo é o que diz o risco: o nome fica sempre. */}
              <span className="max-w-48 min-w-0 text-left leading-4 whitespace-normal break-words">
                {mode?.label ?? settings.mode ?? 'Modo'}
              </span>
              <ChevronDown aria-hidden size={12} strokeWidth={2} className="opacity-60" />
            </Menu.Trigger>
          }
        >
          <Menu.RadioGroup value={settings.mode ?? ''} onValueChange={onMode}>
            {capabilities.modes.map((m) => (
              <Item
                key={m.id}
                value={m.id}
                title={m.label}
                description={m.description}
                icon={<ModeIcon risk={m.risk} size={14} />}
                testId={`mode-${m.id}`}
              />
            ))}
          </Menu.RadioGroup>
        </MenuShell>
      ) : null}
    </div>
  );
}
