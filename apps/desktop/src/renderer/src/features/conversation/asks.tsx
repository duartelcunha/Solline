import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, CheckCheck, ClipboardList, HelpCircle, ShieldQuestion, X } from 'lucide-react';
import type {
  AskStatus,
  PermissionAnswer,
  PermissionBlock,
  PlanBlock,
  QuestionBlock,
} from '@solline/protocol';
import { Markdown } from '../../components/markdown.tsx';
import { ToolInput } from './tool-input.tsx';

type Answer = (answer: PermissionAnswer) => void;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** Atalhos do cartão ativo. O teclado é sempre um segundo caminho: os botões chegam. */
function useShortcuts(enabled: boolean, keys: Record<string, () => void>): void {
  const ref = useRef(keys);
  useLayoutEffect(() => {
    ref.current = keys;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      const run = ref.current[event.key];
      if (run) {
        event.preventDefault();
        run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

const STATUS_TEXT: Record<Exclude<AskStatus, 'pending'>, string> = {
  allowed: 'Permitido uma vez',
  'allowed-always': 'Permitido sempre',
  denied: 'Negado',
  cancelled: 'Cancelado',
};

function Resolved({
  status,
  label,
  icon,
}: {
  status: AskStatus;
  label: string;
  icon: React.ReactNode;
}) {
  const ok = status === 'allowed' || status === 'allowed-always';
  return (
    <div
      data-testid="ask-resolved"
      data-status={status}
      className="flex items-center gap-2 px-1 text-[12.5px] text-muted"
    >
      <span className={ok ? 'text-success' : 'text-subtle'}>{icon}</span>
      <span className="truncate">{label}</span>
      <span aria-hidden className="text-subtle">
        ·
      </span>
      <span className={ok ? 'text-success' : 'text-subtle'}>
        {status === 'pending' ? '' : STATUS_TEXT[status]}
      </span>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      aria-hidden
      className="ml-1.5 rounded-[4px] border border-current/25 px-1 font-mono text-[10px] leading-4 opacity-70"
    >
      {children}
    </kbd>
  );
}

const button =
  'inline-flex h-8 items-center rounded-md px-3 text-[13px] font-medium transition-[background-color,transform,box-shadow] duration-150 active:scale-[0.97] disabled:opacity-50';
const primary = `${button} bg-fg text-bg hover:opacity-90`;
const secondary = `${button} border border-line-strong bg-surface hover:bg-surface-hover`;
const quiet = `${button} text-muted hover:bg-surface-hover hover:text-fg`;

function Card({
  children,
  label,
  testId,
}: {
  children: React.ReactNode;
  label: string;
  testId: string;
}) {
  return (
    <section
      aria-label={label}
      data-testid={testId}
      className="appear rounded-lg border border-accent/40 bg-surface p-4 shadow-raised ring-1 ring-accent/10"
    >
      {children}
    </section>
  );
}

export function PermissionCard({
  block,
  active,
  onAnswer,
}: {
  block: PermissionBlock;
  active: boolean;
  onAnswer: Answer;
}) {
  const first = useRef<HTMLButtonElement>(null);
  const [sent, setSent] = useState(false);
  const answer = (a: PermissionAnswer) => {
    if (sent) return;
    setSent(true);
    onAnswer(a);
  };
  const pending = block.status === 'pending';
  useEffect(() => {
    if (pending && active) first.current?.focus({ preventScroll: true });
  }, [pending, active]);
  useShortcuts(pending && active && !sent, {
    ...(block.defaultToNo ? {} : { '1': () => answer({ decision: 'allow-once' }) }),
    ...(block.canAlwaysAllow && !block.defaultToNo
      ? { '2': () => answer({ decision: 'allow-always' }) }
      : {}),
    '3': () => answer({ decision: 'deny' }),
    Escape: () => answer({ decision: 'deny' }),
  });

  if (!pending)
    return (
      <Resolved status={block.status} label={block.title} icon={<ShieldQuestion size={14} />} />
    );

  const allowOnce = (
    <button
      ref={block.defaultToNo ? undefined : first}
      type="button"
      disabled={sent}
      className={block.defaultToNo ? secondary : primary}
      onClick={() => answer({ decision: 'allow-once' })}
    >
      Permitir uma vez
      {block.defaultToNo ? null : <Kbd>1</Kbd>}
    </button>
  );
  return (
    <Card label={`Pedido de permissão: ${block.title}`} testId="permission-card">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-text">
          <ShieldQuestion size={15} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold tracking-[-0.01em]">{block.title}</h3>
          <p className="text-[12.5px] text-muted">
            O Claude quer usar <span className="font-mono text-[12px]">{block.toolName}</span>.
            {block.description ? ` ${block.description}` : ''}
          </p>
        </div>
      </div>
      <div className="mt-3 max-h-64 overflow-auto rounded-md border border-line bg-surface-sunken p-3 select-text">
        <ToolInput name={block.toolName} input={block.input} compact />
      </div>
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        {allowOnce}
        {block.canAlwaysAllow ? (
          <button
            type="button"
            disabled={sent}
            className={secondary}
            onClick={() => answer({ decision: 'allow-always' })}
          >
            Permitir sempre
            {block.defaultToNo ? null : <Kbd>2</Kbd>}
          </button>
        ) : null}
        <button
          ref={block.defaultToNo ? first : undefined}
          type="button"
          disabled={sent}
          className={quiet}
          onClick={() => answer({ decision: 'deny' })}
        >
          Negar
          <Kbd>Esc</Kbd>
        </button>
      </div>
    </Card>
  );
}

export function PlanCard({ block, onAnswer }: { block: PlanBlock; onAnswer: Answer }) {
  const [feedback, setFeedback] = useState('');
  const [asking, setAsking] = useState(false);
  const [sent, setSent] = useState(false);
  const answer = (a: PermissionAnswer) => {
    if (sent) return;
    setSent(true);
    onAnswer(a);
  };
  const pending = block.status === 'pending';
  if (!pending) {
    return <Resolved status={block.status} label="Plano" icon={<ClipboardList size={14} />} />;
  }
  return (
    <Card label="Plano para aprovar" testId="plan-card">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
        <ClipboardList size={15} className="text-accent-text" /> Plano pronto
      </div>
      <div className="max-h-96 overflow-auto rounded-md border border-line bg-surface-sunken px-4 py-2 select-text">
        <Markdown text={block.plan || '_O plano veio vazio._'} />
      </div>
      {asking ? (
        <textarea
          autoFocus
          rows={3}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="O que deve mudar no plano?"
          aria-label="O que deve mudar no plano"
          className="mt-3 w-full resize-none rounded-md border border-line-strong bg-surface p-2.5 text-[13px] outline-none focus:border-accent"
        />
      ) : null}
      <div className="mt-3.5 flex flex-wrap gap-2">
        {asking ? (
          <>
            <button
              type="button"
              disabled={sent}
              className={primary}
              onClick={() =>
                answer({
                  decision: 'deny',
                  message: feedback.trim()
                    ? `The user wants changes to the plan: ${feedback.trim()}`
                    : 'The user wants changes to the plan. Ask what to change.',
                })
              }
            >
              Enviar pedido
            </button>
            <button type="button" className={quiet} onClick={() => setAsking(false)}>
              Voltar
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={sent}
              className={primary}
              onClick={() => answer({ decision: 'allow-once' })}
            >
              <Check size={14} className="mr-1.5" /> Aprovar plano
            </button>
            <button type="button" className={secondary} onClick={() => setAsking(true)}>
              Pedir mudanças
            </button>
          </>
        )}
      </div>
    </Card>
  );
}

export function QuestionCard({ block, onAnswer }: { block: QuestionBlock; onAnswer: Answer }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);
  const pending = block.status === 'pending';
  if (!pending) {
    const summary = block.answers
      ? Object.values(block.answers).join(' · ')
      : (block.questions[0]?.question ?? '');
    return <Resolved status={block.status} label={summary} icon={<HelpCircle size={14} />} />;
  }
  const answerFor = (question: string) => {
    const chosen = [...(picked[question] ?? [])];
    const extra = other[question]?.trim();
    if (extra) chosen.push(extra);
    return chosen.join(', ');
  };
  const ready = block.questions.every((q) => answerFor(q.question).length > 0);
  const toggle = (question: string, label: string, multi: boolean) =>
    setPicked((current) => {
      const now = current[question] ?? [];
      const next = multi
        ? now.includes(label)
          ? now.filter((l) => l !== label)
          : [...now, label]
        : [label];
      return { ...current, [question]: next };
    });
  const submit = () => {
    if (!ready || sent) return;
    setSent(true);
    onAnswer({
      decision: 'answer',
      answers: Object.fromEntries(block.questions.map((q) => [q.question, answerFor(q.question)])),
    });
  };
  return (
    <Card label="Pergunta do Claude" testId="question-card">
      <div className="space-y-4">
        {block.questions.map((q) => (
          <fieldset key={q.question}>
            <legend className="mb-2 text-[13.5px] font-semibold">
              {q.header ? (
                <span className="mr-2 rounded-sm bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent-text">
                  {q.header}
                </span>
              ) : null}
              {q.question}
            </legend>
            <div className="grid gap-1.5">
              {q.options.map((option) => {
                const on = (picked[q.question] ?? []).includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    role={q.multiSelect ? 'checkbox' : 'radio'}
                    aria-checked={on}
                    onClick={() => toggle(q.question, option.label, q.multiSelect)}
                    className={`rounded-md border px-3 py-2 text-left transition-[background-color,border-color] duration-150 ${on ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-hover'}`}
                  >
                    <div className="text-[13px] font-medium">{option.label}</div>
                    {option.description ? (
                      <div className="text-[12px] text-muted">{option.description}</div>
                    ) : null}
                  </button>
                );
              })}
              <input
                value={other[q.question] ?? ''}
                onChange={(e) => setOther((o) => ({ ...o, [q.question]: e.target.value }))}
                placeholder="Outra resposta…"
                aria-label={`Outra resposta para: ${q.question}`}
                className="rounded-md border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent"
              />
            </div>
          </fieldset>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <button type="button" disabled={!ready || sent} className={primary} onClick={submit}>
          <CheckCheck size={14} className="mr-1.5" /> Responder
        </button>
        <button
          type="button"
          disabled={sent}
          className={quiet}
          onClick={() => {
            setSent(true);
            onAnswer({ decision: 'deny' });
          }}
        >
          <X size={14} className="mr-1.5" /> Não responder
        </button>
      </div>
    </Card>
  );
}
