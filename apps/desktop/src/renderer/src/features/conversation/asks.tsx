import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Check,
  CheckCheck,
  ClipboardList,
  HelpCircle,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  X,
} from 'lucide-react';
import type {
  AskStatus,
  PermissionAnswer,
  PermissionBlock,
  PlanBlock,
  QuestionBlock,
} from '@solline/protocol';
import { Markdown } from '../../components/markdown.tsx';
import { useMorphName } from '../../lib/morph.ts';
import { useAgentLabel } from '../agents/agent-label.tsx';
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
  allowed: 'permitido',
  'allowed-always': 'permitido sempre',
  denied: 'negado',
  'denied-always': 'negado sempre',
  cancelled: 'cancelado',
};

/** Um pedido respondido encolhe para uma linha: ícone de 12 px com a cor da resposta. */
function Resolved({
  id,
  status,
  label,
  icon,
}: {
  id: string;
  status: AskStatus;
  label: string;
  icon: React.ReactNode;
}) {
  const ok = status === 'allowed' || status === 'allowed-always';
  const denied = status === 'denied' || status === 'denied-always';
  const morph = useMorphName(id);
  return (
    <div
      data-testid="ask-resolved"
      data-status={status}
      style={morph}
      className="flex h-6 items-center gap-1.5 text-[12px] text-muted"
    >
      <span
        className={`grid shrink-0 place-items-center ${ok ? 'text-success' : denied ? 'text-danger' : 'text-subtle'}`}
      >
        {icon}
      </span>
      <span className="min-w-0 truncate">{label}</span>
      {status === 'pending' ? null : (
        <span className="shrink-0 text-subtle">· {STATUS_TEXT[status]}</span>
      )}
    </div>
  );
}

function permissionIcon(status: AskStatus): React.ReactNode {
  if (status === 'allowed' || status === 'allowed-always') return <ShieldCheck size={12} />;
  if (status === 'denied' || status === 'denied-always') return <ShieldX size={12} />;
  return <ShieldQuestion size={12} />;
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
  'inline-flex h-8 items-center rounded-md px-3 text-[13px] font-medium sl-press disabled:opacity-50';
const primary = `${button} bg-fg text-bg hover:opacity-90`;
const secondary = `${button} border border-line-strong bg-surface hover:bg-surface-hover`;
const quiet = `${button} text-muted hover:bg-surface-hover hover:text-fg`;

function Card({
  id,
  children,
  label,
  testId,
}: {
  id: string;
  children: React.ReactNode;
  label: string;
  testId: string;
}) {
  const morph = useMorphName(id);
  return (
    <section
      aria-label={label}
      data-testid={testId}
      data-ask={id}
      style={morph}
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
  const agentLabel = useAgentLabel();
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
      <Resolved
        id={block.id}
        status={block.status}
        label={block.title}
        icon={permissionIcon(block.status)}
      />
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
    <Card id={block.id} label={`Pedido de permissão: ${block.title}`} testId="permission-card">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-text">
          <ShieldQuestion size={15} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold tracking-[-0.01em]">{block.title}</h3>
          <p className="text-[12.5px] text-muted">
            O {agentLabel} quer usar <span className="font-mono text-[12px]">{block.toolName}</span>
            .{block.description ? ` ${block.description}` : ''}
          </p>
        </div>
      </div>
      <div className="mt-3 max-h-64 overflow-auto rounded-md border border-line bg-surface-sunken p-3 select-text">
        <ToolInput content={block.content} input={block.input} compact />
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
            {block.allowAlwaysLabel ??
              (block.alwaysScope === 'session' ? 'Permitir nesta sessão' : 'Permitir sempre')}
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
        {block.canAlwaysDeny ? (
          <button
            type="button"
            disabled={sent}
            className={quiet}
            onClick={() => answer({ decision: 'deny-always' })}
          >
            {block.denyAlwaysLabel ?? 'Negar sempre'}
          </button>
        ) : null}
      </div>
    </Card>
  );
}

export function PlanCard({ block, onAnswer }: { block: PlanBlock; onAnswer: Answer }) {
  const [sent, setSent] = useState(false);
  const answer = (a: PermissionAnswer) => {
    if (sent) return;
    setSent(true);
    onAnswer(a);
  };
  if (block.status !== 'pending') {
    return (
      <Resolved
        id={block.id}
        status={block.status}
        label="Plano"
        icon={<ClipboardList size={12} />}
      />
    );
  }
  // shortcut: aprovar ou rejeitar, sem "pedir mudanças" com texto; o cartão completo é do M2.
  return (
    <Card id={block.id} label="Plano para aprovar" testId="plan-card">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
        <ClipboardList size={15} className="text-accent-text" /> Plano pronto
      </div>
      <div className="max-h-96 overflow-auto rounded-md border border-line bg-surface-sunken px-4 py-2 select-text">
        <Markdown text={block.plan || '_O plano veio vazio._'} />
      </div>
      <div className="mt-3.5 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={sent}
          className={primary}
          onClick={() => answer({ decision: 'allow-once' })}
        >
          <Check size={14} className="mr-1.5" /> Aprovar plano
        </button>
        <button
          type="button"
          disabled={sent}
          className={quiet}
          onClick={() => answer({ decision: 'deny' })}
        >
          Rejeitar
        </button>
      </div>
    </Card>
  );
}

export function QuestionCard({ block, onAnswer }: { block: QuestionBlock; onAnswer: Answer }) {
  const agentLabel = useAgentLabel();
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [sent, setSent] = useState(false);
  if (block.status !== 'pending') {
    const summary = block.answers
      ? Object.values(block.answers).join(' · ')
      : (block.questions[0]?.question ?? '');
    return (
      <Resolved
        id={block.id}
        status={block.status}
        label={summary}
        icon={<HelpCircle size={12} />}
      />
    );
  }
  const ready = block.questions.every((q) => (picked[q.question] ?? []).length > 0);
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
  const send = (answer: PermissionAnswer) => {
    if (sent) return;
    setSent(true);
    onAnswer(answer);
  };
  // shortcut: só as opções dadas, sem "outra resposta" escrita; o cartão completo é do M2.
  return (
    <Card id={block.id} label={`Pergunta do ${agentLabel}`} testId="question-card">
      <div className="space-y-4">
        {block.questions.map((q) => (
          <fieldset key={q.question}>
            <legend className="mb-2 text-[13.5px] font-semibold">{q.question}</legend>
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
                    className={`rounded-md border px-3 py-2 text-left transition-[background-color,border-color] duration-150 ${on ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-hover active:bg-surface-sunken'}`}
                  >
                    <div className="text-[13px] font-medium">{option.label}</div>
                    {option.description ? (
                      <div className="text-[12px] text-muted">{option.description}</div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={!ready || sent}
          className={primary}
          onClick={() =>
            send({
              decision: 'answer',
              // Respostas múltiplas vão separadas por vírgulas, como o CLI faz.
              answers: Object.fromEntries(
                block.questions.map((q) => [q.question, (picked[q.question] ?? []).join(', ')]),
              ),
            })
          }
        >
          <CheckCheck size={14} className="mr-1.5" /> Responder
        </button>
        <button
          type="button"
          disabled={sent}
          className={quiet}
          onClick={() => send({ decision: 'deny' })}
        >
          <X size={14} className="mr-1.5" /> Não responder
        </button>
      </div>
    </Card>
  );
}
