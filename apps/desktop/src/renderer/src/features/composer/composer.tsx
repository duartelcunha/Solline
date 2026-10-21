import { useEffect, useRef, useState } from 'react';
import { ArrowUp, CornerDownRight, ListPlus, Square } from 'lucide-react';
import type { Checks, TokenUsage } from '@solline/protocol';
import { IconSwap } from '@solline/ui/icon-swap';
import { actions, useSession } from '../../stores/app.ts';
import { useSessionAgentLabel } from '../agents/agent-label.tsx';
import { morphName } from '../../lib/morph.ts';
import { SettingsPills } from './pills.tsx';

export const money = new Intl.NumberFormat('pt-PT', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const tokens = new Intl.NumberFormat('pt-PT', { notation: 'compact', maximumFractionDigits: 1 });

/**
 * O contexto só aparece quando começa a contar (50 %): abaixo disso não há nada a decidir.
 * Uma fatia cheia, não um arco, para não parecer um carregamento.
 */
export function ContextMeter({
  used,
  max,
  percent,
}: {
  used: number;
  max: number;
  percent: number;
}) {
  const p = Math.min(Math.max(percent, 0), 100);
  if (p < 50) return null;
  const tone = p >= 85 ? 'text-danger' : p >= 65 ? 'text-accent-text' : 'text-muted';
  const label = `Contexto: ${tokens.format(used)} de ${tokens.format(max)} tokens (${p}%)`;
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${tone}`}
      title={label}
      aria-label={label}
      role="img"
      data-testid="context-meter"
    >
      <span
        aria-hidden
        className="size-3 shrink-0 rounded-full"
        style={{
          background: `conic-gradient(currentColor ${p}%, color-mix(in oklab, currentColor 22%, transparent) 0)`,
        }}
      />
      <span className="hidden tabular-nums @[30rem]:inline">{p}%</span>
    </span>
  );
}

function TokenCount({ usage }: { usage: TokenUsage }) {
  const label =
    `Tokens desta sessão: ${tokens.format(usage.input)} de entrada` +
    (usage.cachedInput ? ` (${tokens.format(usage.cachedInput)} em cache)` : '') +
    `, ${tokens.format(usage.output)} de saída` +
    (usage.reasoning ? ` (${tokens.format(usage.reasoning)} a pensar)` : '');
  return (
    <span
      className="hidden tabular-nums @[34rem]:inline"
      title={label}
      aria-label={label}
      data-testid="session-tokens"
    >
      {tokens.format(usage.input + usage.output)} tokens
    </span>
  );
}

/** A primeira verificação que falhou no último turno verificado, com o nome dela. */
function firstFailing(checks: Checks | null): { id: string; label: string } | null {
  if (!checks?.turnId) return null;
  const result = checks.results.find((r) => r.state === 'failed' || r.state === 'timeout');
  if (!result) return null;
  const spec = checks.specs.find((c) => c.id === result.id);
  return { id: result.id, label: spec?.label ?? result.id };
}

export function Composer({ sessionId, above }: { sessionId: string; above?: React.ReactNode }) {
  const state = useSession(sessionId, (s) => s.info.state);
  const settings = useSession(sessionId, (s) => s.info.settings);
  const capabilities = useSession(sessionId, (s) => s.capabilities);
  const usage = useSession(sessionId, (s) => s.usage);
  const actionError = useSession(sessionId, (s) => s.actionError);
  const agentLabel = useSessionAgentLabel(sessionId);
  const features = capabilities?.features;
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  // A mensagem de um turno rebobinado volta para aqui, para editar e mandar de novo.
  const draft = useSession(sessionId, (s) => s.draft);
  const [seenDraft, setSeenDraft] = useState<string | null>(null);
  if (draft !== seenDraft) {
    setSeenDraft(draft);
    if (draft !== null) setText(draft);
  }
  useEffect(() => {
    if (draft === null) return;
    actions.takeDraft(sessionId);
    input.current?.focus();
  }, [draft, sessionId]);

  // O componente monta de novo por sessão (key), por isso basta focar à entrada.
  useEffect(() => {
    input.current?.focus();
  }, []);

  const checks = useSession(sessionId, (s) => s.checks);
  const busy = state === 'running' || state === 'needs-you';
  const offline = state === 'starting' || state === 'error';
  const hasText = text.trim().length > 0;
  const canSend = !offline && hasText;
  const canSteer = busy && features?.steer === true;
  const failing = firstFailing(checks);

  /**
   * Com o agente parado, segue logo. A trabalhar: 'queue' vai para a fila (segue quando o
   * turno acabar) e 'now' guia o turno que corre, onde o agente aceita.
   */
  async function send(how: 'queue' | 'now' = 'queue') {
    if (!canSend) return;
    const message = text.trim();
    setText('');
    const ok = await actions.send(sessionId, message, busy ? how : undefined);
    if (!ok) setText(message);
  }

  // O botão muda de papel: enviar, parar (a trabalhar sem texto) ou pôr na fila.
  const role: 'send' | 'stop' | 'queue' = !busy ? 'send' : hasText ? 'queue' : 'stop';

  return (
    <div className="shrink-0 pb-5">
      {/* A mesma largura e margem da conversa: as duas colunas alinham. */}
      <div className="mx-auto w-full max-w-3xl px-8">
        {above}
        {actionError ? (
          <p
            role="alert"
            className="mb-2 px-1 text-[12.5px] text-danger"
            data-testid="action-error"
          >
            {actionError}
          </p>
        ) : null}
        {failing && !busy && !offline ? (
          <p
            key={failing.id}
            data-testid="check-suggestion"
            className="sl-enter mb-2 flex items-center gap-1.5 px-1 text-[12px] text-muted"
          >
            <span className="min-w-0 truncate">{failing.label} falhou ·</span>
            <button
              type="button"
              onClick={() => void actions.fixCheck(sessionId, failing.id)}
              className="shrink-0 rounded-sm text-fg underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)]"
            >
              Mandar ao agente
            </button>
          </p>
        ) : null}
        <div className="composer @container rounded-xl border border-line bg-surface shadow-raised transition-[border-color,box-shadow] duration-200 focus-within:border-line-strong">
          <textarea
            ref={input}
            value={text}
            rows={1}
            disabled={offline}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(e.ctrlKey || e.metaKey ? 'now' : 'queue');
              }
            }}
            placeholder={
              offline
                ? 'A sessão não está ligada'
                : busy
                  ? canSteer
                    ? `O ${agentLabel} está a trabalhar · Enter põe na fila, Ctrl+Enter guia agora`
                    : `O ${agentLabel} está a trabalhar · Enter põe na fila`
                  : 'Escreve uma mensagem'
            }
            aria-label="Mensagem"
            data-testid="composer-input"
            className="block max-h-64 min-h-12 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14px] leading-[1.5] outline-none [field-sizing:content] placeholder:text-subtle disabled:cursor-default"
          />
          <div className="flex items-center gap-3 px-2.5 pt-1 pb-2.5">
            {/* Estreito (painel de rever aberto): as pílulas ficam numa linha e saem os números. */}
            {capabilities ? (
              <SettingsPills
                settings={settings}
                capabilities={capabilities}
                disabled={offline}
                onModel={(model) => void actions.setModel(sessionId, model)}
                onEffort={(effort) => void actions.setEffort(sessionId, effort)}
                onMode={(mode) => void actions.setMode(sessionId, mode)}
              />
            ) : null}
            <div className="ml-auto flex items-center gap-3 text-[12px] text-muted">
              {usage.context && features?.context !== false ? (
                <ContextMeter
                  used={usage.context.usedTokens}
                  max={usage.context.maxTokens}
                  percent={usage.context.percent}
                />
              ) : null}
              {usage.costUsd !== null && features?.cost !== false ? (
                <span
                  className="hidden tabular-nums @[34rem]:inline"
                  title="Custo estimado desta sessão"
                  data-testid="session-cost"
                >
                  {money.format(usage.costUsd)}
                </span>
              ) : usage.tokens ? (
                <TokenCount usage={usage.tokens} />
              ) : null}
              {canSteer && hasText ? (
                <button
                  type="button"
                  onClick={() => void send('now')}
                  title="Guiar o turno agora (Ctrl+Enter)"
                  data-testid="steer-now"
                  className="chip-in sl-press inline-flex h-7 items-center gap-1 rounded-control px-2 text-[12px] text-fg hover:bg-surface-hover"
                >
                  <CornerDownRight size={13} /> Agora
                </button>
              ) : null}
              {/* Um só botão que muda de papel: o ícone troca no mesmo sítio. */}
              <button
                type="button"
                onClick={() => (role === 'stop' ? void actions.interrupt(sessionId) : void send())}
                disabled={role === 'send' && !canSend}
                aria-label={
                  role === 'stop' ? 'Interromper' : role === 'queue' ? 'Pôr na fila' : 'Enviar'
                }
                title={
                  role === 'stop'
                    ? 'Interromper'
                    : role === 'queue'
                      ? 'Pôr na fila (Enter): segue quando o turno acabar'
                      : 'Enviar (Enter)'
                }
                data-testid={
                  role === 'stop' ? 'interrupt' : role === 'queue' ? 'queue-send' : 'send'
                }
                style={morphName('composer-action')}
                className="grid size-8 place-items-center rounded-full bg-fg text-bg sl-press disabled:bg-surface-sunken disabled:text-subtle"
              >
                <IconSwap swapKey={role}>
                  {role === 'stop' ? (
                    <Square size={11} fill="currentColor" strokeWidth={0} />
                  ) : role === 'queue' ? (
                    <ListPlus size={16} strokeWidth={2} />
                  ) : (
                    <ArrowUp size={16} strokeWidth={2.25} />
                  )}
                </IconSwap>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
