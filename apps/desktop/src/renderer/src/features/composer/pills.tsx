import * as Menu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Cpu, Gauge } from 'lucide-react';
import {
  findModel,
  type AgentCapabilities,
  type ModelOption,
  type SessionSettings,
} from '@solline/protocol';
import { ModeIcon } from '../../components/icons.tsx';
import { Item, MenuShell, triggerClass } from '../../components/menu.tsx';

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
  return (
    <div
      className="flex min-w-0 flex-nowrap items-center gap-1.5"
      role="group"
      aria-label="Modelo, effort e modo"
    >
      <MenuShell
        title="Modelo"
        trigger={
          <Menu.Trigger
            disabled={disabled}
            data-testid="pill-model"
            aria-label={`Modelo: ${modelName}. Mudar`}
            className={triggerClass}
          >
            <Cpu aria-hidden size={13} strokeWidth={1.9} />
            {modelName}
            <ChevronDown aria-hidden size={12} strokeWidth={2} className="opacity-60" />
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
            <Menu.Trigger
              disabled={disabled}
              data-testid="pill-effort"
              aria-label={`Esforço: ${settings.effort ?? 'padrão'}. Mudar`}
              title={`Esforço: ${settings.effort ?? 'padrão'}`}
              className={triggerClass}
            >
              <Gauge aria-hidden size={13} strokeWidth={1.9} />
              {/* Estreito (painel de rever aberto): só o ícone; o nome fica no tooltip. */}
              <span className="@max-[30rem]:hidden">{settings.effort ?? 'esforço padrão'}</span>
              <ChevronDown
                aria-hidden
                size={12}
                strokeWidth={2}
                className="opacity-60 @max-[30rem]:hidden"
              />
            </Menu.Trigger>
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
              className={triggerClass}
            >
              <ModeIcon risk={mode?.risk ?? 'ask'} size={14} />
              {/* O modo é o que diz o risco: o nome fica sempre. */}
              {mode?.label ?? settings.mode ?? 'Modo'}
              <ChevronDown
                aria-hidden
                size={12}
                strokeWidth={2}
                className="opacity-60 @max-[30rem]:hidden"
              />
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
