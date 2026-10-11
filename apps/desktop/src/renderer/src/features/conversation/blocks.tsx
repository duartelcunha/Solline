import { useState } from 'react';
import { AlertCircle, Check, ChevronRight, Info, X } from 'lucide-react';
import type { NoticeBlock, ThinkingBlock, ToolBlock } from '@solline/protocol';
import { Markdown } from '../../components/markdown.tsx';

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

export function ToolRow({
  block,
  onOpen,
  childCount,
}: {
  block: ToolBlock;
  onOpen: () => void;
  childCount: number;
}) {
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
      <span className="grid size-4 shrink-0 place-items-center text-muted">
        <ToolStateIcon state={block.state} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{block.summary}</span>
      {childCount > 0 ? (
        <span className="shrink-0 text-[11px] text-subtle">{childCount} passos</span>
      ) : null}
      <span className="shrink-0 font-mono text-[11px] text-subtle">{block.name}</span>
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
