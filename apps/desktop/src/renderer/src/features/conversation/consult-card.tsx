import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Forward, Info, MessagesSquare } from 'lucide-react';
import type { ConsultDecision, ConsultRequest } from '@solline/protocol';
import { actions, useApp, useSession } from '../../stores/app.ts';
import { labelFor } from '../agents/agent-label.tsx';
import { Card, Kbd, primary, quiet, secondary, useShortcuts } from './asks.tsx';
import { consultCopy } from './consult-model.ts';

/** O nome de um agente para a interface (a lista de agentes da app). */
export function useAgentName(): (id: string) => string {
  const agents = useApp((s) => s.agents);
  return (id) => labelFor(agents, id);
}

/**
 * Um agente pede para perguntar a outro ou para lhe entregar uma tarefa. É um pedido como o de
 * permissão: o texto é do agente (dado, nunca ordem para a Solline) e nada acontece até decidires.
 */
export function ConsultCard({
  sessionId,
  request,
  active,
  autoFocus = true,
}: {
  sessionId: string;
  request: ConsultRequest;
  /** O primeiro pedido à espera nesta sessão: só ele responde às teclas. */
  active: boolean;
  autoFocus?: boolean;
}) {
  const name = useAgentName();
  const copy = consultCopy(request, name);
  const first = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);
  const [sent, setSent] = useState(false);
  const locked = useRef(false);

  // Uma só vez por pedido: voltar ao fundo da conversa nunca tira o foco a quem está a ler.
  useEffect(() => {
    if (!active || focused.current) return;
    focused.current = true;
    if (autoFocus) first.current?.focus({ preventScroll: true });
  }, [active, autoFocus]);

  function decide(decision: ConsultDecision) {
    if (locked.current) return;
    locked.current = true;
    setSent(true);
    void actions.answerConsult(sessionId, request.id, decision).then((ok) => {
      if (!ok) {
        locked.current = false;
        setSent(false);
      }
    });
  }

  useShortcuts(active && !sent, {
    '1': () => decide('allow'),
    '2': () => decide('allowSession'),
    '3': () => decide('deny'),
    Escape: () => decide('deny'),
  });

  const Icon = request.kind === 'ask' ? MessagesSquare : Forward;
  const session = request.kind === 'ask' ? 'perguntas' : 'delegações';
  return (
    <Card
      id={request.id}
      label={`Pedido de ${request.kind === 'ask' ? 'consulta' : 'delegação'}: ${copy.title}`}
      testId="consult-card"
    >
      <div className="flex items-start gap-3" data-kind={request.kind}>
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-attention-soft text-attention">
          <Icon size={15} strokeWidth={1.9} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold tracking-[-0.01em]" data-testid="consult-title">
            {copy.title}
          </h3>
          <p className="text-[12.5px] text-muted">{copy.effect}</p>
        </div>
      </div>

      <div className="mt-3 rounded-md border border-line bg-surface-sunken p-3 select-text">
        <p className="mb-1 text-[11px] font-medium tracking-[0.04em] text-subtle uppercase">
          {copy.textLabel}
        </p>
        <p
          className="max-h-48 overflow-auto text-[13px] leading-relaxed break-words whitespace-pre-wrap"
          data-testid="consult-text"
        >
          {request.text}
        </p>
        {request.context ? (
          <details className="mt-2.5 border-t border-line pt-2">
            <summary className="cursor-pointer text-[12px] text-muted">
              Contexto que o agente juntou
            </summary>
            <p className="mt-1.5 max-h-40 overflow-auto text-[12px] leading-relaxed break-words whitespace-pre-wrap text-muted">
              {request.context}
            </p>
          </details>
        ) : null}
      </div>

      {copy.facts.length ? (
        <dl
          className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px]"
          data-testid="consult-facts"
        >
          {copy.facts.map((fact) => (
            <div key={fact.label} className="flex min-w-0 gap-1.5">
              <dt className="shrink-0 text-subtle">{fact.label}</dt>
              <dd className="min-w-0 truncate font-medium">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {copy.notes.map((note) => (
        <p
          key={note}
          role="note"
          data-testid="consult-note"
          className="mt-3 flex items-start gap-2 rounded-md bg-attention-soft px-3 py-2 text-[12.5px] text-attention"
        >
          <Info size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span>{note}</span>
        </p>
      ))}

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <button
          ref={first}
          type="button"
          disabled={sent}
          className={primary}
          data-testid="consult-allow"
          onClick={() => decide('allow')}
        >
          Permitir
          <Kbd>1</Kbd>
        </button>
        <button
          type="button"
          disabled={sent}
          className={secondary}
          data-testid="consult-allow-session"
          title={`Não voltas a ver este cartão para ${session} desta sessão`}
          onClick={() => decide('allowSession')}
        >
          Permitir nesta sessão
          <Kbd>2</Kbd>
        </button>
        <button
          type="button"
          disabled={sent}
          className={quiet}
          data-testid="consult-deny"
          onClick={() => decide('deny')}
        >
          Recusar
          <Kbd>Esc</Kbd>
        </button>
      </div>
    </Card>
  );
}

/** Os pedidos de consulta e delegação desta sessão, o mais antigo primeiro. */
export function ConsultCards({
  sessionId,
  active,
  autoFocus,
}: {
  sessionId: string;
  /** Nenhum pedido de permissão ou pergunta antes deles: o primeiro cartão responde às teclas. */
  active: boolean;
  autoFocus: boolean;
}) {
  const consults = useSession(sessionId, (s) => s.consults);
  if (!consults.length) return null;
  return (
    <div className="space-y-4" data-testid="consults">
      {consults.map((request, index) => (
        <ConsultCard
          key={request.id}
          sessionId={sessionId}
          request={request}
          active={active && index === 0}
          autoFocus={autoFocus}
        />
      ))}
    </div>
  );
}

/** «Abrir» uma sessão a partir de uma linha pequena (consulta ou delegação já abertas). */
export function OpenSessionButton({ sessionId, label }: { sessionId: string; label: string }) {
  return (
    <button
      type="button"
      onClick={() => actions.selectSession(sessionId)}
      aria-label={label}
      className="sl-press inline-flex h-7 shrink-0 items-center gap-1 rounded-control border border-line px-2 text-[12px] font-medium hover:bg-surface-hover"
    >
      Abrir
      <ArrowUpRight size={12} aria-hidden />
    </button>
  );
}
