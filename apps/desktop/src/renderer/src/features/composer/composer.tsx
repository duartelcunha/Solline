import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import type { TokenUsage } from '@solline/protocol';
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

export function ContextMeter({
  used,
  max,
  percent,
}: {
  used: number;
  max: number;
  percent: number;
}) {
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const p = Math.min(Math.max(percent, 0), 100);
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
      <svg aria-hidden width="16" height="16" viewBox="0 0 16 16">
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.2"
          strokeWidth="2"
        />
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${(p / 100) * c} ${c}`}
          transform="rotate(-90 8 8)"
          className="meter-arc"
        />
      </svg>
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

  const busy = state === 'running' || state === 'needs-you';
  const offline = state === 'starting' || state === 'error';
  const canSend = !busy && !offline && text.trim().length > 0;

  // shortcut: não há fila de mensagens enquanto o agente trabalha; o envio fica bloqueado
  // até ao fim do turno. Rever quando fizer falta mandar mensagens a meio (M2).
  async function send() {
    if (!canSend) return;
    const message = text.trim();
    setText('');
    const ok = await actions.send(sessionId, message);
    if (!ok) setText(message);
  }

  return (
    <div className="shrink-0 px-4 pb-5 sm:px-8">
      <div className="mx-auto max-w-3xl">
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
                void send();
              }
            }}
            placeholder={
              offline
                ? 'A sessão não está ligada'
                : busy
                  ? `O ${agentLabel} está a trabalhar…`
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
              {busy ? (
                <button
                  type="button"
                  onClick={() => void actions.interrupt(sessionId)}
                  aria-label="Interromper"
                  title="Interromper"
                  data-testid="interrupt"
                  style={morphName('composer-action')}
                  className="grid size-8 place-items-center rounded-full bg-fg text-bg sl-press"
                >
                  <Square size={11} fill="currentColor" strokeWidth={0} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={!canSend}
                  aria-label="Enviar"
                  title="Enviar (Enter)"
                  data-testid="send"
                  style={morphName('composer-action')}
                  className="grid size-8 place-items-center rounded-full bg-fg text-bg sl-press disabled:bg-surface-sunken disabled:text-subtle"
                >
                  <ArrowUp size={16} strokeWidth={2.25} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
