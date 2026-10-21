import { useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  Info,
  ListChecks,
  X,
} from 'lucide-react';
import type { NoticeBlock, ThinkingBlock, TodoBlock, ToolBlock } from '@solline/protocol';
import { Markdown } from '../../components/markdown.tsx';
import { useChangedSinceMount } from '../../lib/morph.ts';

export function Spinner({ label }: { label: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className="spinner inline-block size-3.5 rounded-full border-[1.5px] border-current border-r-transparent"
    />
  );
}

export function ToolStateIcon({ state }: { state: ToolBlock['state'] }) {
  if (state === 'running') return <Spinner label="A correr" />;
  if (state === 'ok')
    return <Check aria-label="Concluída" size={14} strokeWidth={2.25} className="text-success" />;
  return <X aria-label="Falhou" size={14} strokeWidth={2.25} className="text-danger" />;
}

/** O ícone transforma-se quando a ferramenta acaba; ao abrir o histórico fica quieto. */
function MorphingIcon({ state }: { state: ToolBlock['state'] }) {
  const changed = useChangedSinceMount(state);
  return (
    <span className="grid size-4 shrink-0 place-items-center text-muted">
      <span
        key={state}
        className={changed ? 'icon-morph grid place-items-center' : 'grid place-items-center'}
      >
        <ToolStateIcon state={state} />
      </span>
    </span>
  );
}

export function ToolRow({ block, onOpen }: { block: ToolBlock; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="tool-block"
      data-tool={block.name}
      data-state={block.state}
      aria-label={`${block.summary}: ${block.state === 'running' ? 'a correr' : block.state === 'ok' ? 'concluída' : 'falhou'}. Abrir detalhe`}
      className="group flex w-full items-center gap-2.5 rounded-md border border-line bg-surface px-3 py-2 text-left transition-[background-color,border-color,transform] duration-150 hover:border-line-strong hover:bg-surface-hover active:scale-[0.995]"
    >
      <MorphingIcon state={block.state} />
      <span className="min-w-0 flex-1 truncate text-[13px]">{block.summary}</span>
      <ChevronRight
        size={14}
        strokeWidth={1.75}
        className="shrink-0 text-subtle transition-transform duration-150 group-hover:translate-x-0.5"
      />
    </button>
  );
}

export function ThinkingView({ block }: { block: ThinkingBlock }) {
  const [open, setOpen] = useState(false);
  const empty = block.text.trim().length === 0;
  return (
    <div data-testid="thinking-block">
      <button
        type="button"
        aria-expanded={open}
        disabled={empty}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-sm py-0.5 text-[12.5px] text-muted transition-colors duration-150 hover:text-fg disabled:cursor-default disabled:hover:text-muted"
      >
        <ChevronRight
          size={13}
          strokeWidth={2}
          className={`transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
        />
        {block.done ? 'Pensou' : 'A pensar…'}
      </button>
      {open && !empty ? (
        <div className="appear mt-1.5 border-l-2 border-line pl-3.5 text-[13px] text-muted">
          <Markdown text={block.text} />
        </div>
      ) : null}
    </div>
  );
}

export function NoticeView({ block }: { block: NoticeBlock }) {
  const error = block.tone === 'error';
  return (
    <div
      role={error ? 'alert' : 'status'}
      className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-[13px] ${error ? 'border-danger/30 bg-danger/5 text-danger' : 'border-line bg-surface text-muted'}`}
    >
      {error ? (
        <AlertCircle size={15} className="mt-0.5 shrink-0" />
      ) : (
        <Info size={15} className="mt-0.5 shrink-0" />
      )}
      <span className="min-w-0 break-words select-text">{block.text}</span>
    </div>
  );
}

const TODO_LABEL: Record<TodoBlock['entries'][number]['status'], string> = {
  pending: 'por fazer',
  in_progress: 'a decorrer',
  completed: 'feita',
};

/** A lista de tarefas do agente, com o estado de cada uma. */
export function TodoView({ block }: { block: TodoBlock }) {
  const done = block.entries.filter((e) => e.status === 'completed').length;
  return (
    <section
      aria-label={`Tarefas: ${done} de ${block.entries.length} feitas`}
      data-testid="todo-block"
      className="rounded-md border border-line bg-surface px-3 py-2.5"
    >
      <div className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-muted">
        <ListChecks size={14} strokeWidth={1.9} />
        Tarefas
        <span className="ml-auto tabular-nums text-subtle">
          {done}/{block.entries.length}
        </span>
      </div>
      <ul className="space-y-1">
        {block.entries.map((entry, i) => (
          <li
            key={entry.id ?? i}
            data-status={entry.status}
            className="flex items-start gap-2 text-[13px]"
          >
            <span className="mt-[3px] shrink-0" aria-label={TODO_LABEL[entry.status]}>
              {entry.status === 'completed' ? (
                <Check size={13} strokeWidth={2.25} className="text-success" />
              ) : entry.status === 'in_progress' ? (
                <CircleDot size={13} strokeWidth={2} className="text-accent-text" />
              ) : (
                <Circle size={13} strokeWidth={1.75} className="text-subtle" />
              )}
            </span>
            <span
              className={
                entry.status === 'completed'
                  ? 'text-muted line-through decoration-line-strong'
                  : entry.status === 'in_progress'
                    ? 'font-medium'
                    : undefined
              }
            >
              {entry.content}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
