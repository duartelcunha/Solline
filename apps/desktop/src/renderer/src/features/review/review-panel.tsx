import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, CircleCheck, MessageSquare, Undo2, Wand2, X } from 'lucide-react';
import type {
  DiffScope,
  FileDiff,
  Finding,
  Hunk,
  ReviewAction,
  ReviewComment,
} from '@solline/protocol';
import { usePresence } from '@solline/ui/react';
import { MenuShell, triggerClass } from '../../components/menu.tsx';
import { actions, useApp, useSession } from '../../stores/app.ts';
import { FindingRow } from '../quality/quality.tsx';
import { commentKey, FileDiffView, type CommentKey } from './diff-view.tsx';

const NO_FINDINGS: readonly Finding[] = [];

/** O painel entra pela direita e sai por onde entrou. */
export function ReviewPanel({ sessionId }: { sessionId: string }) {
  const open = useApp((s) => s.reviewOpen);
  const { mounted, state } = usePresence(open);
  if (!mounted) return null;
  return (
    <aside
      data-state={state}
      aria-label="Rever alterações"
      className="sl-panel sl-motion flex w-[32rem] max-w-[45vw] min-w-[22rem] shrink-0 flex-col border-l border-line bg-bg"
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
  const [scope, setScope] = useState<DiffScope>({ kind: 'review' });
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [comments, setComments] = useState<Map<CommentKey, ReviewComment>>(new Map());
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const findings = useSession(sessionId, (s) => s.quality?.review.findings ?? NO_FINDINGS);
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

  if (!timeline) return <Empty title="A preparar os checkpoints…" />;
  if (!timeline.available) {
    return (
      <Empty
        title="Sem checkpoints nesta sessão"
        detail={timeline.reason ? `Porque ${timeline.reason}.` : undefined}
      />
    );
  }

  const actionable = validScope.kind === 'review';

  async function act(action: ReviewAction, target: { path?: string; hunk?: Hunk } = {}) {
    const before = timeline?.pending.files ?? 0;
    rewardIfEmpty.current = before > 0;
    const ok = await actions.review(sessionId, action, {
      ...(target.path ? { path: target.path } : {}),
      ...(target.hunk ? { hunkId: target.hunk.id } : {}),
    });
    // O diff novo chega pela linha do tempo que a ação manda (um pedido, não dois).
    if (!ok) rewardIfEmpty.current = false;
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
  const elsewhere = files === null ? [] : findings.filter((f) => !shownPaths.has(f.path));
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
            <ScopeItem
              scope={{ kind: 'review' }}
              title="Por rever"
              detail="O que ainda não aceitaste"
            />
            <ScopeItem
              scope={{ kind: 'session' }}
              title="Toda a sessão"
              detail="Tudo desde o início"
            />
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
        {total ? (
          <span className="truncate font-mono text-[11px] text-muted tabular-nums">
            {files?.length ?? 0} {files?.length === 1 ? 'ficheiro' : 'ficheiros'} ·{' '}
            <span className="text-success">+{total.add}</span>{' '}
            <span className="text-danger">−{total.del}</span>
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {timeline.undo ? (
            <button
              type="button"
              onClick={() => void actions.undo(sessionId)}
              title={`Desfazer: ${timeline.undo}`}
              data-testid="review-undo"
              className="sl-press inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted hover:bg-surface-hover hover:text-fg"
            >
              <Undo2 size={13} /> Desfazer
            </button>
          ) : null}
          {actionable && files && files.length > 0 ? (
            <>
              <button
                type="button"
                onClick={() => void act('reject')}
                title="Rejeitar tudo: volta o que está por rever ao que estava"
                data-testid="reject-all"
                className="sl-press inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium whitespace-nowrap text-danger hover:bg-danger/10"
              >
                <X size={13} strokeWidth={2.25} /> Rejeitar
              </button>
              <button
                type="button"
                onClick={() => void act('accept')}
                title="Aceitar tudo o que está por rever"
                data-testid="accept-all"
                className="sl-press inline-flex h-7 items-center gap-1 rounded-md bg-fg px-2.5 text-[12px] font-medium whitespace-nowrap text-bg"
              >
                <Check size={13} strokeWidth={2.25} /> Aceitar
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => actions.toggleReview(false)}
            aria-label="Fechar o painel de rever"
            className="grid size-7 place-items-center rounded-md text-subtle hover:bg-surface-hover hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" data-testid="review-files">
        {elsewhere.length > 0 ? (
          <section className="overflow-hidden rounded-lg border border-line bg-surface">
            {elsewhere.map((f) => (
              <FindingRow
                key={f.id}
                finding={{ ...f, title: `${f.path}${f.line ? `:${f.line}` : ''} · ${f.title}` }}
                picked={picked.has(f.id)}
                onPick={(value) => pick(f.id, value)}
              />
            ))}
          </section>
        ) : null}
        {files === null ? null : files.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <CircleCheck
              size={28}
              strokeWidth={1.5}
              className={`text-success ${celebrate ? 'sl-reward' : ''}`}
              onAnimationEnd={() => setCelebrate(false)}
            />
            <p className="text-[13px] font-medium" data-testid="review-empty">
              {validScope.kind === 'review' ? 'Nada por rever' : 'Sem alterações'}
            </p>
            {validScope.kind === 'review' && checkpoints.length > 0 ? (
              <p className="max-w-[18rem] text-[12px] text-muted">
                O que os agentes mudarem aparece aqui, turno a turno.
              </p>
            ) : null}
          </div>
        ) : (
          files.map((file) => (
            <FileDiffView
              key={file.path}
              file={file}
              actionable={actionable}
              comments={comments}
              onComment={setComment}
              onAction={(action, hunk) =>
                act(action, { path: file.path, ...(hunk ? { hunk } : {}) })
              }
              findings={findings.filter((f) => f.path === file.path)}
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
            className="sl-press h-8 rounded-md px-3 text-[12.5px] text-muted hover:bg-surface-hover hover:text-fg"
          >
            Limpar
          </button>
          <button
            type="button"
            disabled={busy || fixing}
            onClick={() => void fix()}
            title={busy ? 'Espera que o agente acabe o turno' : undefined}
            data-testid="fix-findings"
            className="sl-press inline-flex h-8 items-center gap-1.5 rounded-md bg-fg px-3 text-[12.5px] font-medium text-bg disabled:opacity-50"
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
            placeholder="Uma nota para juntar (opcional)"
            aria-label="Nota para o agente"
            className="block max-h-32 w-full resize-none rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] outline-none [field-sizing:content] focus:border-line-strong"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setComments(new Map())}
              className="sl-press h-8 rounded-md px-3 text-[12.5px] text-muted hover:bg-surface-hover hover:text-fg"
            >
              Descartar
            </button>
            <button
              type="button"
              disabled={busy || sending}
              onClick={() => void sendComments()}
              title={busy ? 'Espera que o agente acabe o turno' : undefined}
              data-testid="send-comments"
              className="sl-press inline-flex h-8 items-center gap-1.5 rounded-md bg-fg px-3 text-[12.5px] font-medium text-bg disabled:opacity-50"
            >
              Enviar ao agente
            </button>
          </div>
        </footer>
      ) : null}
    </>
  );
}

function ScopeItem({ scope, title, detail }: { scope: DiffScope; title: string; detail: string }) {
  return (
    <Menu.RadioItem
      value={JSON.stringify(scope)}
      className="flex cursor-default items-start gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] outline-none select-none data-[highlighted]:bg-surface-hover"
    >
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        <span className="block truncate text-[11.5px] text-muted">{detail}</span>
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
        className="sl-press mt-3 h-8 rounded-md border border-line px-3 text-[12.5px] hover:bg-surface-hover"
      >
        Fechar
      </button>
    </div>
  );
}
