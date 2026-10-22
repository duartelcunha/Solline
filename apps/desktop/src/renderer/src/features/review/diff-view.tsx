import { useState } from 'react';
import { Check, ChevronRight, MessageSquarePlus, X } from 'lucide-react';
import type {
  DiffLine,
  FileDiff,
  Finding,
  Hunk,
  ReviewAction,
  ReviewComment,
} from '@solline/protocol';
import { shouldAnimate } from '@solline/ui/motion';
import { FindingRow } from '../quality/quality.tsx';

/**
 * Um ficheiro do diff, hunk a hunk. Cada linha aceita um comentário (clicar no número ou no
 * "+" que aparece ao passar); os comentários ficam guardados até seguirem para o agente.
 */

export type CommentKey = `${string}\u0000${'old' | 'new'}\u0000${number}`;

export function commentKey(c: Pick<ReviewComment, 'path' | 'side' | 'line'>): CommentKey {
  return `${c.path}\u0000${c.side}\u0000${c.line}`;
}

interface Props {
  file: FileDiff;
  /** Só no "Por rever" há aceitar e rejeitar. */
  actionable: boolean;
  comments: ReadonlyMap<CommentKey, ReviewComment>;
  editingDraft?: ReviewComment | null;
  onEditDraft?: (draft: ReviewComment | null) => void;
  /** Texto vazio tira o comentário dessa linha. */
  onComment: (at: { path: string; side: 'old' | 'new'; line: number }, text: string) => void;
  /** Devolve se correu bem. */
  onAction: (action: ReviewAction, hunk?: Hunk) => Promise<boolean>;
  /** O que o revisor achou neste ficheiro. */
  findings?: readonly Finding[];
  picked?: ReadonlySet<string>;
  onPick?: (id: string, picked: boolean) => void;
}

const STATUS: Record<FileDiff['status'], string | null> = {
  added: 'Novo',
  deleted: 'Apagado',
  modified: null,
};

export function FileDiffView({
  file,
  actionable,
  comments,
  editingDraft,
  onEditDraft,
  onComment,
  onAction,
  findings = [],
  picked,
  onPick,
}: Props) {
  const [open, setOpen] = useState(true);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [localEditing, setLocalEditing] = useState<{ side: 'old' | 'new'; line: number } | null>(
    null,
  );
  const editing = onEditDraft ? editingDraft : localEditing;
  const setEditing = (at: { side: 'old' | 'new'; line: number } | null) => {
    if (onEditDraft)
      onEditDraft(
        at
          ? {
              ...at,
              path: file.path,
              text: comments.get(commentKey({ ...at, path: file.path }))?.text ?? '',
            }
          : null,
      );
    else setLocalEditing(at);
  };
  const slash = file.path.lastIndexOf('/');
  const dir = slash === -1 ? '' : file.path.slice(0, slash + 1);
  const name = file.path.slice(slash + 1);
  // Cada achado fica na sua linha da versão nova; os que não têm linha à vista vão para o topo.
  const shownLines = new Set(
    file.hunks.flatMap((h) => h.lines.flatMap((l) => (l.newNo === null ? [] : [l.newNo]))),
  );
  const loose = findings.filter((f) => f.line === null || !shownLines.has(f.line));
  const finding = (f: Finding) => (
    <FindingRow
      key={f.id}
      finding={f}
      picked={picked?.has(f.id) ?? false}
      onPick={(value) => onPick?.(f.id, value)}
    />
  );

  async function act(action: ReviewAction, hunk: Hunk | undefined, event: React.MouseEvent) {
    // A saída só anima quando veio do rato; no teclado o hunk sai logo.
    const key = hunk?.id ?? '*';
    if (shouldAnimate(event.nativeEvent)) setLeaving(key);
    // Se correu bem, o diff novo já não traz o hunk; tirar o "a sair" antes fazia-o piscar.
    const ok = await onAction(action, hunk).catch(() => false);
    if (!ok) setLeaving(null);
  }

  return (
    <section
      className={`overflow-hidden rounded-lg border border-line bg-surface ${leaving === '*' ? 'sl-leave' : ''}`}
      data-testid="diff-file"
      data-path={file.path}
    >
      <header className="flex items-center gap-2 border-b border-line px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? `Fechar ${file.path}` : `Abrir ${file.path}`}
          className="sl-press grid size-6 shrink-0 place-items-center rounded-sm text-subtle hover:bg-surface-hover hover:text-fg"
        >
          <ChevronRight
            size={14}
            className={`transition-transform duration-[160ms] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
          />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={file.path}>
          <span className="text-subtle">{dir}</span>
          <span className="font-medium text-fg">{name}</span>
        </span>
        {STATUS[file.status] ? (
          <span className="shrink-0 rounded-full bg-surface-sunken px-1.5 text-[10.5px] leading-[18px] font-medium text-muted">
            {STATUS[file.status]}
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          <span className="diff-count">+{file.additions}</span>{' '}
          <span className="diff-count">−{file.deletions}</span>
        </span>
        {actionable ? (
          <span className="flex shrink-0 items-center gap-0.5">
            <IconAction
              label={`Aceitar ${file.path}`}
              onClick={(e) => void act('accept', undefined, e)}
              testId="accept-file"
            >
              <Check size={14} strokeWidth={2.25} />
            </IconAction>
            <IconAction
              label={`Rejeitar ${name}`}
              onClick={(e) => void act('reject', undefined, e)}
              testId="reject-file"
            >
              <X size={14} />
            </IconAction>
          </span>
        ) : null}
      </header>
      {open && loose.length > 0 ? <div>{loose.map(finding)}</div> : null}
      {open ? (
        file.binary || file.truncated ? (
          <p className="px-3 py-2.5 text-[12px] text-muted">
            {file.binary ? 'Ficheiro binário' : 'Grande demais para mostrar'}
          </p>
        ) : file.hunks.length === 0 ? (
          <p className="px-3 py-2.5 text-[12px] text-muted">Só mudou o modo</p>
        ) : (
          <div className="divide-y divide-line">
            {file.hunks.map((hunk) => (
              <div
                key={hunk.id}
                className={`group/hunk ${leaving === hunk.id ? 'sl-leave' : ''}`}
                data-testid="diff-hunk"
                data-hunk={hunk.id}
              >
                <div className="flex items-center gap-2 bg-surface-sunken/60 py-1 pr-1.5 pl-3">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-subtle">
                    {hunk.header}
                  </span>
                  {/* Aceitar e rejeitar só aparecem ao passar ou com o foco no hunk; ficam no
                      DOM e no Tab. */}
                  {actionable ? (
                    <span className="flex items-center opacity-0 transition-opacity duration-150 group-focus-within/hunk:opacity-100 group-hover/hunk:opacity-100 motion-reduce:transition-none">
                      <SmallAction
                        onClick={(e) => void act('accept', hunk, e)}
                        testId="accept-hunk"
                        tone="accept"
                      >
                        <Check size={12} strokeWidth={2.5} /> Aceitar
                      </SmallAction>
                      <SmallAction
                        onClick={(e) => void act('reject', hunk, e)}
                        testId="reject-hunk"
                        tone="reject"
                      >
                        <X size={12} strokeWidth={2.5} /> Rejeitar
                      </SmallAction>
                    </span>
                  ) : null}
                </div>
                <div className="font-mono text-[12px] leading-[1.6] select-text">
                  {hunk.lines.map((line, i) => {
                    const side: 'old' | 'new' = line.kind === 'del' ? 'old' : 'new';
                    const no = side === 'old' ? line.oldNo : line.newNo;
                    const comment =
                      no === null
                        ? undefined
                        : comments.get(commentKey({ path: file.path, side, line: no }));
                    const isEditing =
                      editing && no !== null && editing.side === side && editing.line === no;
                    return (
                      <div key={i}>
                        <Line
                          line={line}
                          onComment={no === null ? undefined : () => setEditing({ side, line: no })}
                        />
                        {line.kind !== 'del' && line.newNo !== null
                          ? findings.filter((f) => f.line === line.newNo).map(finding)
                          : null}
                        {isEditing ? (
                          <CommentEditor
                            initial={editingDraft?.text ?? comment?.text ?? ''}
                            onChange={
                              onEditDraft && editingDraft
                                ? (text) => onEditDraft({ ...editingDraft, text })
                                : undefined
                            }
                            onCancel={() => setEditing(null)}
                            onSave={(text) => {
                              onComment({ path: file.path, side, line: no }, text);
                              setEditing(null);
                            }}
                          />
                        ) : comment ? (
                          <CommentChip
                            comment={comment}
                            onEdit={() => setEditing({ side, line: no ?? 0 })}
                            onRemove={() => onComment({ path: file.path, side, line: no ?? 0 }, '')}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )
      ) : null}
    </section>
  );
}

function Line({ line, onComment }: { line: DiffLine; onComment: (() => void) | undefined }) {
  const tone = line.kind === 'add' ? 'diff-add' : line.kind === 'del' ? 'diff-del' : '';
  const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
  return (
    <div
      className={`group grid grid-cols-[2.75rem_2.75rem_1rem_1.5rem_1fr] ${tone}`}
      data-kind={line.kind}
    >
      <span className="pr-1.5 text-right text-subtle tabular-nums select-none">
        {line.oldNo ?? ''}
      </span>
      <span className="pr-1.5 text-right text-subtle tabular-nums select-none">
        {line.newNo ?? ''}
      </span>
      <span
        className={`text-center text-fg select-none ${line.kind === 'context' ? '' : 'diff-direction'}`}
        title={
          line.kind === 'add'
            ? 'Linha adicionada'
            : line.kind === 'del'
              ? 'Linha removida'
              : undefined
        }
      >
        {marker}
      </span>
      <span className="relative text-center text-subtle select-none">
        {onComment ? (
          <button
            type="button"
            onClick={onComment}
            aria-label={`Comentar a linha ${line.newNo ?? line.oldNo}`}
            data-testid="comment-line"
            className="diff-comment absolute inset-0 grid place-items-center rounded-sm text-accent-text opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          >
            <MessageSquarePlus size={12} />
          </button>
        ) : null}
      </span>
      <span className="pr-3 break-all whitespace-pre-wrap">{line.text || ' '}</span>
    </div>
  );
}

function CommentEditor({
  initial,
  onSave,
  onCancel,
  onChange,
}: {
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
  onChange?: (text: string) => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <div className="sl-enter sl-motion border-y border-line bg-surface px-3 py-2 font-sans">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange?.(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) onSave(text.trim());
        }}
        rows={2}
        placeholder="O que deve mudar aqui?"
        aria-label="Comentário"
        data-testid="comment-input"
        className="block w-full resize-none rounded-control border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none [field-sizing:content] focus:border-line-strong"
      />
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="sl-press h-7 rounded-control px-2.5 text-[12px] text-muted hover:bg-surface-hover hover:text-fg"
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={!text.trim()}
          onClick={() => onSave(text.trim())}
          title="Guardar (Ctrl+Enter)"
          data-testid="comment-save"
          className="sl-press h-7 rounded-control bg-fg px-2.5 text-[12px] font-medium text-bg disabled:opacity-50"
        >
          Guardar
        </button>
      </div>
    </div>
  );
}

function CommentChip({
  comment,
  onEdit,
  onRemove,
}: {
  comment: ReviewComment;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="sl-enter sl-motion flex items-start gap-2 border-y border-accent/20 bg-accent-soft/50 px-3 py-1.5 font-sans">
      <MessageSquarePlus size={13} className="mt-0.5 shrink-0 text-accent-text" aria-hidden />
      <button
        type="button"
        onClick={onEdit}
        className="min-w-0 flex-1 text-left text-[12.5px] whitespace-pre-wrap"
        data-testid="comment-chip"
      >
        {comment.text}
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Tirar o comentário"
        className="sl-press grid size-5 shrink-0 place-items-center rounded-sm text-subtle hover:bg-surface-hover hover:text-fg"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function IconAction({
  label,
  onClick,
  testId,
  children,
}: {
  label: string;
  onClick: (e: React.MouseEvent) => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
      className="sl-press grid size-7 place-items-center rounded-control text-muted hover:bg-surface-hover hover:text-fg"
    >
      {children}
    </button>
  );
}

function SmallAction({
  onClick,
  testId,
  tone,
  children,
}: {
  onClick: (e: React.MouseEvent) => void;
  testId: string;
  tone: 'accept' | 'reject';
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`sl-press inline-flex h-6 items-center gap-1 rounded-control px-2 text-[11.5px] font-medium ${
        tone === 'accept' ? 'text-success hover:bg-success/10' : 'text-danger hover:bg-danger/10'
      }`}
    >
      {children}
    </button>
  );
}
