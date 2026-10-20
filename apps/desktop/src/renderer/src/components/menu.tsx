import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';

/** Menu com título, partilhado pelas pílulas do compositor e pela escolha do agente. */
export function MenuShell({
  trigger,
  title,
  side = 'top',
  align = 'start',
  children,
}: {
  trigger: React.ReactNode;
  title: string;
  side?: 'top' | 'bottom' | 'right' | 'left';
  align?: 'start' | 'center' | 'end';
  children: React.ReactNode;
}) {
  return (
    <Menu.Root>
      {trigger}
      <Menu.Portal>
        <Menu.Content
          side={side}
          align={align}
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

export const triggerClass =
  'pill inline-flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 text-[12px] font-medium text-muted outline-none transition-[background-color,color,border-color,transform] duration-150 hover:border-line-strong hover:bg-surface-hover hover:text-fg active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)] data-[state=open]:border-line-strong data-[state=open]:bg-surface-hover data-[state=open]:text-fg disabled:opacity-50';

const itemClass =
  'group flex cursor-default items-start gap-2.5 rounded-md px-2.5 py-2 text-[13px] outline-none select-none data-[highlighted]:bg-surface-hover data-[disabled]:opacity-50';

function ItemBody({
  title,
  description,
  icon,
}: {
  title: string;
  description?: string | undefined;
  icon?: React.ReactNode;
}) {
  return (
    <>
      <span className="mt-0.5 grid size-4 shrink-0 place-items-center text-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        {description ? (
          <span className="block text-[11.5px] leading-snug text-muted">{description}</span>
        ) : null}
      </span>
    </>
  );
}

/** Uma opção de um grupo (modelo, effort, modo): mostra o visto na escolhida. */
export function Item({
  value,
  title,
  description,
  icon,
  testId,
}: {
  value: string;
  title: string;
  description?: string | undefined;
  icon?: React.ReactNode;
  testId: string;
}) {
  return (
    <Menu.RadioItem value={value} className={itemClass} data-testid={testId}>
      <ItemBody title={title} description={description} icon={icon} />
      <Menu.ItemIndicator className="mt-0.5 text-accent-text">
        <Check size={14} strokeWidth={2.25} />
      </Menu.ItemIndicator>
    </Menu.RadioItem>
  );
}

/** Uma ação (por exemplo abrir uma sessão com um agente). */
export function ActionItem({
  title,
  description,
  icon,
  disabled,
  onSelect,
  testId,
}: {
  title: string;
  description?: string | undefined;
  icon?: React.ReactNode;
  disabled?: boolean;
  onSelect: () => void;
  testId: string;
}) {
  return (
    <Menu.Item disabled={disabled} onSelect={onSelect} className={itemClass} data-testid={testId}>
      <ItemBody title={title} description={description} icon={icon} />
    </Menu.Item>
  );
}
