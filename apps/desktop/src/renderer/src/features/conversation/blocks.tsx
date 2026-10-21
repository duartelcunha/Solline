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
import { IconSwap } from '@solline/ui/icon-swap';

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

/** O ícone troca quando a ferramenta acaba; ao abrir o histórico fica quieto. */
function StateIcon({ state }: { state: ToolBlock['state'] }) {
  return (
    <IconSwap swapKey={state} className="size-4 shrink-0">
      <ToolStateIcon state={state} />
    </IconSwap>
  );
}

const STATE_SPOKEN: Record<ToolBlock['state'], string> = {
  running: 'a correr',
  ok: 'concluída',
  error: 'falhou',
};

const rowClass =
  'group -mx-2 flex h-7 w-[calc(100%+1rem)] items-center gap-2 rounded-control px-2 text-left text-[13px] text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)]';

/** Seta que só aparece ao passar o rato (ou com foco): em repouso a linha é só texto. */
function HoverChevron({ open }: { open?: boolean }) {
  return (
    <ChevronRight
      aria-hidden
      size={13}
      strokeWidth={1.75}
      className={`shrink-0 text-subtle transition-[opacity,transform] duration-150 motion-reduce:transition-none ${open ? 'rotate-90' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'}`}
    />
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
      aria-label={`${block.summary}: ${STATE_SPOKEN[block.state]}. Abrir detalhe`}
      className={rowClass}
    >
      <StateIcon state={block.state} />
      <span className="min-w-0 flex-1 truncate">{block.summary}</span>
      <HoverChevron />
    </button>
  );
}

/**
 * As ferramentas seguidas de um turno numa só linha, "N ações", com o estado da última.
 * Um clique mostra as linhas; uma ferramenta sozinha é só a linha dela. As linhas ficam no
 * DOM mesmo fechadas (hidden), para o estado de cada uma continuar a ler-se.
 */
export function ToolGroup({
  blocks,
  onOpen,
}: {
  blocks: ToolBlock[];
  onOpen: (block: ToolBlock) => void;
}) {
  const [open, setOpen] = useState(false);
  const latest = blocks.at(-1);
  if (!latest) return null;
  if (blocks.length === 1) return <ToolRow block={latest} onOpen={() => onOpen(latest)} />;
  return (
    <div data-testid="tool-group">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        aria-label={`${blocks.length} ações, a última ${STATE_SPOKEN[latest.state]}`}
        className={rowClass}
      >
        <StateIcon state={latest.state} />
        <span className="min-w-0 flex-1 truncate">{blocks.length} ações</span>
        <HoverChevron open={open} />
      </button>
      <div hidden={!open} className="ml-3 border-l border-line pl-3">
        {blocks.map((block) => (
          <div key={block.id} className="sl-enter">
            <ToolRow block={block} onOpen={() => onOpen(block)} />
          </div>
        ))}
      </div>
    </div>
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
        className="sl-press flex items-center gap-1.5 rounded-sm py-0.5 text-[12.5px] text-muted hover:text-fg disabled:cursor-default disabled:hover:text-muted"
      >
        <ChevronRight
          size={13}
          strokeWidth={2}
          className={`transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
        />
        {block.done ? 'Pensou' : 'A pensar…'}
      </button>
      {open && !empty ? (
        <div className="sl-enter sl-motion mt-1.5 border-l-2 border-line pl-3.5 text-[13px] text-muted">
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
      <div className="mb-1.5 flex items-center gap-2 text-[12px] text-muted">
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
