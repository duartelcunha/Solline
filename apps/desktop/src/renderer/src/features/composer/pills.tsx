import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Cpu, Gauge } from 'lucide-react';
import {
  findModel,
  type AgentCapabilities,
  type ModelOption,
  type SessionSettings,
} from '@solline/protocol';
import { ModeIcon } from '../../components/icons.tsx';

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

/** "Opus 5.5 · Best for..." -> "Opus 5.5"; se não houver versão, o nome do menu. */
export function shortModelName(model: ModelOption | undefined, current: string | null): string {
  if (!model) return current ?? 'Modelo';
  const head = model.description.split(' · ')[0]?.trim();
  return head && /\d/.test(head) && head.length <= 24 ? head : model.label;
}

function MenuShell({
  trigger,
  title,
  children,
}: {
  trigger: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Menu.Root>
      {trigger}
      <Menu.Portal>
        <Menu.Content
          side="top"
          align="start"
          sideOffset={8}
          className="menu-content z-50 min-w-[15rem] max-w-[22rem] rounded-lg border border-line bg-surface p-1 shadow-raised"
        >
          <Menu.Label className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-[0.04em] text-subtle uppercase">
            {title}
          </Menu.Label>
          {children}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

const triggerClass =
  'pill inline-flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 text-[12px] font-medium text-muted outline-none transition-[background-color,color,border-color,transform] duration-150 hover:border-line-strong hover:bg-surface-hover hover:text-fg active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)] data-[state=open]:border-line-strong data-[state=open]:bg-surface-hover data-[state=open]:text-fg disabled:opacity-50';

const itemClass =
  'group flex cursor-default items-start gap-2.5 rounded-md px-2.5 py-2 text-[13px] outline-none select-none data-[highlighted]:bg-surface-hover data-[disabled]:opacity-50';

function Item({
  value,
  title,
  description,
  icon,
  testId,
}: {
  value: string;
  title: string;
  description?: string;
  icon?: React.ReactNode;
  testId: string;
}) {
  return (
    <Menu.RadioItem value={value} className={itemClass} data-testid={testId}>
      <span className="mt-0.5 grid size-4 shrink-0 place-items-center text-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        {description ? (
          <span className="block text-[11.5px] leading-snug text-muted">{description}</span>
        ) : null}
      </span>
      <Menu.ItemIndicator className="mt-0.5 text-accent-text">
        <Check size={14} strokeWidth={2.25} />
      </Menu.ItemIndicator>
    </Menu.RadioItem>
  );
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
  const efforts = [...(model?.efforts ?? [])].sort(
    (a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b),
  );
  const mode = capabilities.modes.find((m) => m.id === settings.mode);
  const showEffort = capabilities.effort && efforts.length > 0;
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
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
          title="Effort"
          trigger={
            <Menu.Trigger
              disabled={disabled}
              data-testid="pill-effort"
              aria-label={`Effort: ${settings.effort ?? 'padrão'}. Mudar`}
              className={triggerClass}
            >
              <Gauge aria-hidden size={13} strokeWidth={1.9} />
              {settings.effort ?? 'effort padrão'}
              <ChevronDown aria-hidden size={12} strokeWidth={2} className="opacity-60" />
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

      <MenuShell
        title="Modo"
        trigger={
          <Menu.Trigger
            disabled={disabled}
            data-testid="pill-mode"
            aria-label={`Modo: ${mode?.label ?? settings.mode}. Mudar`}
            className={triggerClass}
          >
            <ModeIcon mode={settings.mode} size={14} />
            {mode?.label ?? settings.mode}
            <ChevronDown aria-hidden size={12} strokeWidth={2} className="opacity-60" />
          </Menu.Trigger>
        }
      >
        <Menu.RadioGroup value={settings.mode} onValueChange={onMode}>
          {capabilities.modes.map((m) => (
            <Item
              key={m.id}
              value={m.id}
              title={m.label}
              description={m.description}
              icon={<ModeIcon mode={m.id} size={14} />}
              testId={`mode-${m.id}`}
            />
          ))}
        </Menu.RadioGroup>
      </MenuShell>
    </div>
  );
}
