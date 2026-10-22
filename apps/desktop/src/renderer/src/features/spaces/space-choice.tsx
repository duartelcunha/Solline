import * as Menu from '@radix-ui/react-dropdown-menu';
import { ChevronDown } from 'lucide-react';
import { ActionItem, Item, MenuShell } from '../../components/menu.tsx';

export function SpaceChoice({
  id,
  label,
  value,
  placeholder,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  options: { value: string; label: string; disabled?: boolean; detail?: string }[];
  onChange(value: string): void;
}) {
  return (
    <MenuShell
      title={label}
      side="bottom"
      trigger={
        <Menu.Trigger id={id} className="space-control w-full justify-between">
          <span className="truncate">
            {options.find((o) => o.value === value)?.label ?? placeholder}
          </span>
          <ChevronDown size={14} className="shrink-0 text-subtle" />
        </Menu.Trigger>
      }
    >
      <Menu.RadioGroup value={value} onValueChange={onChange}>
        {options.map((o) =>
          o.disabled ? (
            <ActionItem
              key={o.value}
              title={o.label}
              description={o.detail}
              disabled
              onSelect={() => undefined}
              testId={`choice-${id}-${o.value}`}
            />
          ) : (
            <Item
              key={o.value}
              value={o.value}
              title={o.label}
              description={o.detail}
              testId={`choice-${id}-${o.value}`}
            />
          ),
        )}
        {!options.length ? (
          <Menu.Item disabled className="px-3 py-2 text-[12px] text-muted">
            Sem opções disponíveis
          </Menu.Item>
        ) : null}
      </Menu.RadioGroup>
    </MenuShell>
  );
}
