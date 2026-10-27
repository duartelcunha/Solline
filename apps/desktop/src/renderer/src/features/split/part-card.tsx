import { useState } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Cpu, X } from 'lucide-react';
import { Item, MenuShell } from '../../components/menu.tsx';
import { laneKey, type LaneOption } from '../race/lane-options.ts';
import { letter, type PartDraft } from './plan-model.ts';

const inputClass =
  'min-w-0 rounded-control border border-line bg-bg px-2 text-[12px] outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)]';

const pill =
  'pill sl-press inline-flex h-7 min-w-0 items-center gap-1.5 rounded-control border border-line px-2.5 text-[12px] whitespace-nowrap text-muted outline-none hover:border-line-strong hover:bg-surface-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)] data-[state=open]:border-line-strong data-[state=open]:bg-surface-hover data-[state=open]:text-fg';

function Field({
  label,
  value,
  placeholder,
  testId,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  testId: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-[11.5px] text-muted">
      {label}
      <textarea
        value={value}
        rows={2}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        className={`${inputClass} max-h-40 min-h-[2.75rem] resize-none py-1.5 leading-snug text-fg [field-sizing:content]`}
      />
    </label>
  );
}

/**
 * Uma parte do plano num cartão pequeno: quem a faz, a verificação que decide se ficou certa e,
 * escondido por baixo, o contrato (o que pode tocar, o que não, as interfaces combinadas).
 */
export function PartCard({
  index,
  draft,
  options,
  checks,
  dropped,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  draft: PartDraft;
  options: LaneOption[];
  checks: readonly { id: string; label: string }[];
  /** A razão por que a revisão não lança esta parte, se não a lança. */
  dropped: string | null;
  canRemove: boolean;
  onChange: (patch: Partial<Omit<PartDraft, 'id'>>) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(draft.goal.trim() === '');
  const key = laneKey({ agent: draft.agent, ...(draft.model ? { model: draft.model } : {}) });
  const chosen = options.find((o) => o.key === key);
  const label = chosen?.label ?? draft.agent;
  return (
    <section
      className={`flex min-w-0 flex-col gap-2.5 rounded-xl border border-line bg-surface p-3.5 transition-opacity duration-200 ${dropped ? 'opacity-60' : ''}`}
      data-testid="split-part"
      data-dropped={dropped !== null}
    >
      <header className="flex items-center gap-2">
        <span
          className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-sunken text-[11.5px] font-semibold text-muted"
          aria-hidden
        >
          {letter(index)}
        </span>
        <input
          value={draft.title}
          maxLength={200}
          placeholder={`Parte ${letter(index)}`}
          onChange={(e) => onChange({ title: e.target.value })}
          aria-label={`Título da parte ${letter(index)}`}
          data-testid="split-part-title"
          className={`${inputClass} h-7 flex-1 text-[13px] font-medium`}
        />
        {canRemove ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Tirar a parte ${letter(index)}`}
            data-testid="split-part-remove"
            className="sl-press grid size-7 shrink-0 place-items-center rounded-md text-subtle hover:bg-surface-hover hover:text-fg"
          >
            <X size={13} />
          </button>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <MenuShell
          title="Quem faz esta parte"
          side="bottom"
          trigger={
            <Menu.Trigger
              data-testid="split-part-agent"
              aria-label={`Agente da parte ${letter(index)}: ${label}. Mudar`}
              className={`${pill} max-w-full`}
            >
              <Cpu aria-hidden size={13} strokeWidth={1.9} className="shrink-0" />
              <span className="min-w-0 truncate">{label}</span>
              <ChevronDown aria-hidden size={12} strokeWidth={2} className="shrink-0 opacity-60" />
            </Menu.Trigger>
          }
        >
          <Menu.RadioGroup
            value={key}
            onValueChange={(value) => {
              const next = options.find((o) => o.key === value);
              if (next) onChange({ agent: next.lane.agent, model: next.lane.model ?? null });
            }}
          >
            {options.map((o) => (
              <Item
                key={o.key}
                value={o.key}
                title={o.label}
                testId={`split-agent-${o.key.replace(':', '-')}`}
              />
            ))}
          </Menu.RadioGroup>
        </MenuShell>
        <select
          value={draft.check ?? ''}
          onChange={(e) => onChange({ check: e.target.value || null })}
          aria-label={`Verificação da parte ${letter(index)}`}
          data-testid="split-part-check"
          className="h-7 min-w-0 max-w-full rounded-control border border-line bg-surface px-2 text-[12px] text-fg"
        >
          <option value="">Sem verificação</option>
          {checks.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      {index === 0 ? (
        <label className="flex items-start gap-2 text-[12px] text-muted">
          <input
            type="checkbox"
            checked={draft.zero}
            onChange={(e) => onChange({ zero: e.target.checked })}
            data-testid="split-zero"
            className="mt-0.5 size-3.5 shrink-0 accent-[var(--sl-text)]"
          />
          <span>
            Parte zero: fixa a interface primeiro
            <span className="block text-[11.5px] text-subtle">
              Corre sozinha; as outras partem do que ela deixar.
            </span>
          </span>
        </label>
      ) : null}

      {dropped ? (
        <p className="text-[12px] text-muted" data-testid="split-part-dropped">
          Não se lança: {dropped}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        data-testid="split-contract-toggle"
        className="sl-press inline-flex items-center gap-1 self-start rounded-md px-1.5 py-1 text-[12px] text-muted hover:bg-surface-hover hover:text-fg"
      >
        <ChevronDown
          size={12}
          aria-hidden
          className={`transition-transform duration-200 ${open ? '' : '-rotate-90'}`}
        />
        Editar contrato
      </button>
      {open ? (
        <div className="sl-enter flex flex-col gap-2">
          <Field
            label="Objetivo"
            value={draft.goal}
            placeholder="O que esta parte tem de entregar"
            testId="split-part-goal"
            onChange={(goal) => onChange({ goal })}
          />
          <Field
            label="Pode mexer em (um caminho por linha)"
            value={draft.allowed}
            placeholder="src/parte-a/**"
            testId="split-part-allowed"
            onChange={(allowed) => onChange({ allowed })}
          />
          <Field
            label="Não pode mexer em"
            value={draft.forbidden}
            testId="split-part-forbidden"
            onChange={(forbidden) => onChange({ forbidden })}
          />
          <Field
            label="Interfaces combinadas"
            value={draft.interfaces}
            testId="split-part-interfaces"
            onChange={(interfaces) => onChange({ interfaces })}
          />
          <Field
            label="O que se espera no fim"
            value={draft.expected}
            testId="split-part-expected"
            onChange={(expected) => onChange({ expected })}
          />
        </div>
      ) : null}
    </section>
  );
}
