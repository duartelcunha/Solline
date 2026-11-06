import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import {
  Check,
  ChevronDown,
  CircleCheck,
  MessageSquare,
  PanelRightClose,
  Undo2,
  Wand2,
  X,
} from 'lucide-react';
import type {
  DiffScope,
  FileDiff,
  Finding,
  Hunk,
  ReviewAction,
  ReviewComment,
} from '@solline/protocol';
import { usePresence } from '@solline/ui/react';
import { scrollIntoViewSmooth, useDragScroll } from '@solline/ui/scroll';
import { MenuShell, triggerClass } from '../../components/menu.tsx';
import { actions, useApp, useSession } from '../../stores/app.ts';
import { FindingRow, FoldedFindings, QualityStrip } from '../quality/quality.tsx';
import { groupFindings, openFindings } from '../quality/findings-model.ts';
import { PassToButton } from '../handoff/pass-to.tsx';
import { commentKey, FileDiffView, type CommentKey } from './diff-view.tsx';

const NO_FINDINGS: readonly Finding[] = [];

/** O painel entra pela direita e sai por onde entrou. */
export function ReviewPanel({ sessionId }: { sessionId: string }) {
  const open = useApp((s) => s.reviewOpen);
  const { mounted, state } = usePresence(open);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus({ preventScroll: true });
    return () => {
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [open]);
  if (!mounted) return null;
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          actions.toggleReview();
        }
      }}
      data-state={state}
      aria-label="Rever alterações"
      className="sl-panel sl-motion flex w-[62%] max-w-[46rem] min-w-[22rem] shrink-0 flex-col border-l border-line bg-bg"
      data-testid="review-panel"
    >
      <ReviewBody sessionId={sessionId} />
    </aside>
  );
}

function scopeLabel(scope: DiffScope, index: (turnId: string) => number | undefined): string {
  if (scope.kind === 'review') return 'Por rever';
  if (scope.kind === 'session') return 'Toda a sessão';
  return `Turno ${index(scope.turnId) ?? '?'}`;
}

function ReviewBody({ sessionId }: { sessionId: string }) {
  const timeline = useSession(sessionId, (s) => s.timeline);
  const busy = useSession(sessionId, (s) => s.info.state !== 'idle');
  const draft = useSession(sessionId, (s) => s.reviewDraft);
  const scope = draft.scope;
  const setScope = (scope: DiffScope) => actions.editReview(sessionId, { scope });
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const filesBox = useRef<HTMLDivElement>(null);
  /** Depois de aceitar ou rejeitar, a vista desliza para o hunk que ficou nesse lugar. */
  const nextHunk = useRef<number | null>(null);
  useDragScroll(filesBox);
  useEffect(() => {
    const box = filesBox.current;
    const index = nextHunk.current;
    if (!box || index === null) return;
    nextHunk.current = null;
    const hunks = box.querySelectorAll('[data-testid="diff-hunk"]');
    const target = hunks[Math.min(index, hunks.length - 1)];
    if (target) scrollIntoViewSmooth(box, target, 'nearest', 16);
  }, [files]);
  const comments = useMemo(
    () => new Map(draft.comments.map((comment) => [commentKey(comment), comment])),
    [draft.comments],
  );
  const setComments = (
    value:
      | Map<CommentKey, ReviewComment>
      | ((current: Map<CommentKey, ReviewComment>) => Map<CommentKey, ReviewComment>),
  ) => {
    const next = typeof value === 'function' ? value(comments) : value;
    actions.editReview(sessionId, { comments: [...next.values()] });
  };
  const note = draft.note;
  const setNote = (note: string) => actions.editReview(sessionId, { note });
  const [sending, setSending] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const allFindings = useSession(sessionId, (s) => s.quality?.review.findings ?? NO_FINDINGS);
  // Os descartados deixam de aparecer (continuam no motor, para as contas).
  const findings = useMemo(() => openFindings(allFindings), [allFindings]);
  // À vista: até 5, os mais graves e seguros; o resto fica dobrado.
  const { shown, folded } = useMemo(() => groupFindings(findings), [findings]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [fixing, setFixing] = useState(false);
  // Achados novos (outro turno) recomeçam a escolha.
  const [seenFindings, setSeenFindings] = useState(findings);
  if (seenFindings !== findings) {
    setSeenFindings(findings);
    setPicked(new Set());
  }

  const checkpoints = useMemo(() => timeline?.checkpoints ?? [], [timeline]);
  // Vários pedidos de diff podem cruzar-se (fim de turno, aceitar, rejeitar): só vale o último.
  const latest = useRef(0);
  const rewardIfEmpty = useRef(false);
  const load = useCallback(
    async (target: DiffScope): Promise<FileDiff[] | null> => {
      const ticket = ++latest.current;
      const next = await actions.diff(sessionId, target);
      if (ticket !== latest.current || !next) return null;
      setFiles(next);
      // Uma pequena recompensa quando o último hunk sai da revisão.
      if (rewardIfEmpty.current && next.length === 0) setCelebrate(true);
      rewardIfEmpty.current = false;
      return next;
    },
    [sessionId],
  );
  const indexOf = (turnId: string) => checkpoints.find((c) => c.turnId === turnId)?.index;
  // Um turno que saiu da linha do tempo (rebobinado) deixa de ser um âmbito válido.
  const validScope =
    scope.kind === 'turn' && !checkpoints.some((c) => c.turnId === scope.turnId)
      ? ({ kind: 'review' } as const)
      : scope;

  // Volta a ler o diff quando o âmbito muda ou a linha do tempo mexe (turno acabado,
  // aceitar, rejeitar, desfazer, rebobinar).
  const scopeKey = JSON.stringify(validScope);
  useEffect(() => {
    if (!timeline?.available) return;
    void load(JSON.parse(scopeKey) as DiffScope);
    // Ao sair, um pedido a meio deixa de valer.
    return () => {
      latest.current += 1;
    };
  }, [load, scopeKey, timeline]);

  if (!timeline) return <Empty title="A preparar…" />;
  if (!timeline.available) {
    return <Empty title="Sem histórico nesta sessão" detail={timeline.reason ?? undefined} />;
  }

  const actionable = validScope.kind === 'review';

  async function act(action: ReviewAction, target: { path?: string; hunk?: Hunk } = {}) {
    const before = timeline?.pending.files ?? 0;
    rewardIfEmpty.current = before > 0;
    if (target.hunk && filesBox.current) {
      const hunks = Array.from(
        filesBox.current.querySelectorAll<HTMLElement>('[data-testid="diff-hunk"]'),
      );
      const index = hunks.findIndex((h) => h.dataset.hunk === target.hunk?.id);
      nextHunk.current = index >= 0 ? index : null;
    }
    const ok = await actions.review(sessionId, action, {
      ...(target.path ? { path: target.path } : {}),
      ...(target.hunk ? { hunkId: target.hunk.id } : {}),
    });
    // O diff novo chega pela linha do tempo que a ação manda (um pedido, não dois).
    if (!ok) rewardIfEmpty.current = false;
    return ok;
  }

  function setComment(at: { path: string; side: 'old' | 'new'; line: number }, text: string) {
    setComments((current) => {
      const next = new Map(current);
      if (text) next.set(commentKey(at), { ...at, text });
      else next.delete(commentKey(at));
      return next;
    });
  }

  function pick(id: string, value: boolean) {
    setPicked((current) => {
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function fix() {
    setFixing(true);
    const ok = await actions.fixFindings(sessionId, [...picked]);
    setFixing(false);
    if (ok) setPicked(new Set());
  }

  async function sendComments() {
    setSending(true);
    const ok = await actions.comment(sessionId, [...comments.values()], note.trim() || undefined);
    setSending(false);
    if (ok) {
      setComments(new Map());
      setNote('');
    }
  }

  const pending = timeline.pending;
  const shownPaths = new Set(files?.map((f) => f.path) ?? []);
  const elsewhere = files === null ? [] : shown.filter((f) => !shownPaths.has(f.path));
  const prefixed = (f: Finding): Finding => ({
    ...f,
    title: `${f.path}${f.line ? `:${f.line}` : ''} · ${f.title}`,
  });
  const total = files?.reduce(
    (acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }),
    { add: 0, del: 0 },
  );

  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <MenuShell
          title="O que ver"
          side="bottom"
          trigger={
            <Menu.Trigger className={triggerClass} data-testid="review-scope">
              {scopeLabel(validScope, indexOf)}
              {validScope.kind === 'review' && pending.files > 0 ? (
                <span className="text-subtle tabular-nums">{pending.files}</span>
              ) : null}
              <ChevronDown size={12} className="text-subtle" />
            </Menu.Trigger>
          }
        >
          <Menu.RadioGroup
            value={scopeKey}
            onValueChange={(value) => {
              setFiles(null);
              setScope(JSON.parse(value) as DiffScope);
            }}
          >
            <ScopeItem scope={{ kind: 'review' }} title="Por rever" />
            <ScopeItem scope={{ kind: 'session' }} title="Toda a sessão" />
            {checkpoints.map((c) => (
              <ScopeItem
                key={c.turnId}
                scope={{ kind: 'turn', turnId: c.turnId }}
                title={`Turno ${c.index}`}
                detail={c.title}
              />
            ))}
          </Menu.RadioGroup>
        </MenuShell>
        {total && files && files.length > 0 ? (
          <span className="truncate font-mono text-[11px] text-muted tabular-nums">
            {files?.length ?? 0} {files?.length === 1 ? 'ficheiro' : 'ficheiros'} ·{' '}
            <span className="diff-count">+{total.add}</span>{' '}
            <span className="diff-count">−{total.del}</span>
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {timeline.undo ? (
            <button
              type="button"
              onClick={() => void actions.undo(sessionId)}
              title={`Desfazer: ${timeline.undo}`}
              data-testid="review-undo"
              className="sl-press inline-flex h-7 items-center gap-1 rounded-control px-2 text-[12px] text-muted hover:bg-surface-hover hover:text-fg"
            >
              <Undo2 size={13} /> Desfazer
            </button>
          ) : null}
          {actionable && files && files.length > 0 ? (
            <>
              <button
                type="button"
                onClick={() => void act('reject')}
                title="Rejeitar tudo"
                data-testid="reject-all"
                className="sl-press inline-flex h-7 items-center gap-1 rounded-control px-2 text-[12px] font-medium whitespace-nowrap text-danger hover:bg-danger/10"
              >
                <X size={13} strokeWidth={2.25} /> Rejeitar
              </button>
              <button
                type="button"
                onClick={() => void act('accept')}
                title="Aceitar tudo"
                data-testid="accept-all"
                className="sl-press inline-flex h-7 items-center gap-1 rounded-control bg-fg px-2.5 text-[12px] font-medium whitespace-nowrap text-bg"
              >
                <Check size={13} strokeWidth={2.25} /> Aceitar
              </button>
            </>
          ) : null}
          <PassToButton sessionId={sessionId} />
          {/* Fechar fica à parte, para não se confundir com o "Rejeitar" ao lado. */}
          <span aria-hidden className="mx-2 h-4 w-px bg-line" />
          <button
            type="button"
            onClick={() => actions.toggleReview(false)}
            aria-label="Fechar o painel de rever"
            title="Fechar"
            className="sl-press grid size-7 place-items-center rounded-control text-subtle hover:bg-surface-hover hover:text-fg"
          >
            <PanelRightClose size={15} strokeWidth={1.75} />
          </button>
        </div>
      </header>

      <QualityStrip sessionId={sessionId} />

      <div
        ref={filesBox}
        className="scroll-fade-y min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
        data-testid="review-files"
      >
        {elsewhere.length > 0 ? (
          <section className="overflow-hidden rounded-lg border border-line bg-surface">
            {elsewhere.map((f) => (
              <FindingRow
                key={f.id}
                sessionId={sessionId}
                finding={prefixed(f)}
                picked={picked.has(f.id)}
                onPick={(value) => pick(f.id, value)}
              />
            ))}
          </section>
        ) : null}
        <FoldedFindings count={folded.length}>
          {folded.map((f) => (
            <FindingRow
              key={f.id}
              sessionId={sessionId}
              finding={prefixed(f)}
              picked={picked.has(f.id)}
              onPick={(value) => pick(f.id, value)}
            />
          ))}
        </FoldedFindings>
        {files === null ? null : files.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span
              className={celebrate ? 'sl-reward' : undefined}
              onAnimationEnd={() => setCelebrate(false)}
            >
              <CircleCheck size={20} strokeWidth={1.75} className="text-subtle" aria-hidden />
            </span>
            <p className="text-[13px] text-muted" data-testid="review-empty">
              {validScope.kind === 'review' ? 'Nada por rever' : 'Sem alterações'}
            </p>
          </div>
        ) : (
          files.map((file) => (
            <FileDiffView
              key={file.path}
              file={file}
              actionable={actionable}
              comments={comments}
              editingDraft={draft.editing?.path === file.path ? draft.editing : null}
              onEditDraft={(editing) => actions.editReview(sessionId, { editing })}
              onComment={setComment}
              onAction={(action, hunk) =>
                act(action, { path: file.path, ...(hunk ? { hunk } : {}) })
              }
              sessionId={sessionId}
              findings={shown.filter((f) => f.path === file.path)}
              picked={picked}
              onPick={pick}
            />
          ))
        )}
      </div>

      {picked.size > 0 ? (
        <footer className="sl-enter sl-motion flex shrink-0 items-center justify-end gap-2 border-t border-line p-3">
          <button
            type="button"
            onClick={() => setPicked(new Set())}
            className="sl-press h-8 rounded-control px-3 text-[12.5px] text-muted hover:bg-surface-hover hover:text-fg"
          >
            Limpar
          </button>
          <button
            type="button"
            disabled={busy || fixing}
            onClick={() => void fix()}
            title={busy ? 'O agente ainda está a trabalhar' : undefined}
            data-testid="fix-findings"
            className="sl-press inline-flex h-8 items-center gap-1.5 rounded-control bg-fg px-3 text-[12.5px] font-medium text-bg disabled:opacity-50"
          >
            <Wand2 size={13} strokeWidth={2} /> Corrigir {picked.size}
          </button>
        </footer>
      ) : null}

      {comments.size > 0 ? (
        <footer className="sl-enter sl-motion shrink-0 border-t border-line p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-muted">
            <MessageSquare size={13} />
            {comments.size === 1 ? '1 comentário' : `${comments.size} comentários`}
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={1}
            placeholder="Nota (opcional)"
            aria-label="Nota para o agente"
            className="block max-h-32 w-full resize-none rounded-control border border-line bg-surface px-2.5 py-1.5 text-[13px] outline-none [field-sizing:content] focus:border-line-strong"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setComments(new Map())}
              className="sl-press h-8 rounded-control px-3 text-[12.5px] text-muted hover:bg-surface-hover hover:text-fg"
            >
              Descartar
            </button>
            <button
              type="button"
              disabled={busy || sending}
              onClick={() => void sendComments()}
              title={busy ? 'O agente ainda está a trabalhar' : undefined}
              data-testid="send-comments"
              className="sl-press inline-flex h-8 items-center gap-1.5 rounded-control bg-fg px-3 text-[12.5px] font-medium text-bg disabled:opacity-50"
            >
              Enviar ao agente
            </button>
          </div>
        </footer>
      ) : null}
    </>
  );
}

function ScopeItem({ scope, title, detail }: { scope: DiffScope; title: string; detail?: string }) {
  return (
    <Menu.RadioItem
      value={JSON.stringify(scope)}
      className="flex cursor-default items-start gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] outline-none select-none data-[highlighted]:bg-surface-hover"
    >
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        {detail ? <span className="block truncate text-[11.5px] text-muted">{detail}</span> : null}
      </span>
      <Menu.ItemIndicator className="mt-0.5 text-accent-text">
        <Check size={14} strokeWidth={2.25} />
      </Menu.ItemIndicator>
    </Menu.RadioItem>
  );
}

function Empty({ title, detail }: { title: string; detail?: string | undefined }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
      <p className="text-[13px] font-medium">{title}</p>
      {detail ? <p className="text-[12px] text-muted">{detail}</p> : null}
      <button
        type="button"
        onClick={() => actions.toggleReview(false)}
        className="sl-press mt-3 h-8 rounded-control border border-line px-3 text-[12.5px] hover:bg-surface-hover"
      >
        Fechar
      </button>
    </div>
  );
}
