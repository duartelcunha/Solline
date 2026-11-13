import { useEffect, useRef, useState } from 'react';
import { ArrowUp, CornerDownRight, ListPlus, Square } from 'lucide-react';
import type { Checks, TokenUsage } from '@solline/protocol';
import { IconSwap } from '@solline/ui/icon-swap';
import { actions, flushDrafts, useApp, useSession } from '../../stores/app.ts';
import { useSessionAgentLabel } from '../agents/agent-label.tsx';
import { SettingsPills } from './pills.tsx';
import { checkCounts, proofLine } from '../session/glance.ts';
import { LedgerPanel } from '../ledger/ledger-panel.tsx';
import { RacePill } from '../race/race-pill.tsx';
import { handedBanner, handedReason } from '../handoff/handoff-model.ts';
import { useSplitFlow } from '../split/split-flow.tsx';
import type { RaceLaneSpec } from '@solline/protocol';

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
  const engineOffline = useApp((s) => s.engineOffline);
  const state = useSession(sessionId, (s) => s.info.state);
  const settings = useSession(sessionId, (s) => s.info.settings);
  const capabilities = useSession(sessionId, (s) => s.capabilities);
  const usage = useSession(sessionId, (s) => s.usage);
  const actionError = useSession(sessionId, (s) => s.actionError);
  const agentLabel = useSessionAgentLabel(sessionId);
  const features = capabilities?.features;
  const text = useSession(sessionId, (s) => s.composerText);
  const setText = (value: string | ((current: string) => string)) =>
    actions.editComposer(sessionId, value);
  const sending = useSession(sessionId, (s) => s.pendingSend !== null);
  // As pistas de uma corrida (vazio: uma mensagem normal).
  const [lanes, setLanes] = useState<RaceLaneSpec[]>([]);
  const agent = useSession(sessionId, (s) => s.info.agent);
  const projectId = useSession(sessionId, (s) => s.projectId);
  const input = useRef<HTMLTextAreaElement>(null);
  // A mensagem de um turno rebobinado volta para aqui, para editar e mandar de novo.
  const draft = useSession(sessionId, (s) => s.draft);
  useEffect(() => {
    if (draft === null) return;
    actions.receiveDraft(sessionId);
    input.current?.focus();
  }, [draft, sessionId]);

  // O componente monta de novo por sessão (key), por isso basta focar à entrada.
  useEffect(() => {
    if (input.current && !input.current.closest('main')?.querySelector('[data-ask]'))
      input.current.focus();
  }, []);

  const checks = useSession(sessionId, (s) => s.checks);
  const pendingFiles = useSession(sessionId, (s) => s.timeline?.pending?.files ?? 0);
  const proof = proofLine({ pendingFiles, ...checkCounts(checks?.results) });
  // Passou o testemunho: só se lê. O compositor diz porquê em vez de falhar ao enviar.
  const archived = useSession(sessionId, (s) => s.info.archived === true);
  const handedTo = useSession(sessionId, (s) => s.info.handedTo);
  const handedTarget = useApp((s) =>
    handedTo && s.sessionIds.includes(handedTo) ? handedTo : undefined,
  );
  const handedTitle = useSession(handedTarget ?? null, (s) => s.info.title);
  const handed = handedReason(
    handedBanner(handedTo, handedTarget ? { id: handedTarget, title: handedTitle } : undefined),
  );
  const busy = state === 'running' || state === 'needs-you';
  const offline = engineOffline || state === 'starting' || state === 'error' || handed !== null;
  const hasText = text.trim().length > 0;
  const canSend = !offline && hasText && !sending;
  const canSteer = busy && features?.steer === true;
  const failing = firstFailing(checks);

  /**
   * Com o agente parado, segue logo. A trabalhar: 'queue' vai para a fila (segue quando o
   * turno acabar) e 'now' guia o turno que corre, onde o agente aceita.
   */
  async function send(how: 'queue' | 'now' = 'queue') {
    if (!canSend) return;
    const message = text.trim();
    if (!actions.beginComposerSend(sessionId, message)) return;
    try {
      await flushDrafts();
    } catch {
      actions.finishComposerSend(sessionId, false);
      return;
    }
    if (lanes.length > 1 && !busy) {
      // N×: o mesmo pedido em várias pistas, cada uma na sua worktree.
      const started = await actions.startRace(projectId, message, lanes);
      if (started) setLanes([]);
      actions.finishComposerSend(sessionId, started);
      return;
    }
    const ok = await actions.send(sessionId, message, busy ? how : undefined);
    actions.finishComposerSend(sessionId, ok);
  }

  // Partir: o planeador lê o projeto e propõe o corte; nada arranca sem o teu clique.
  const split = useSplitFlow({
    sessionId,
    projectId,
    text,
    disabled: offline || busy,
    onSendNormal: () => void send(),
  });

  // O botão muda de papel: enviar, parar (a trabalhar sem texto) ou pôr na fila.
  const role: 'send' | 'stop' | 'queue' = !busy ? 'send' : hasText ? 'queue' : 'stop';

  if (archived) {
    return (
      <div className="shrink-0 pb-5">
        <div className="mx-auto w-full max-w-3xl px-8">
          <p
            data-testid="archived-note"
            className="rounded-xl border border-line bg-surface px-4 py-3 text-[13px] text-muted"
          >
            O PR entrou. A sessão fica para ler.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 pb-5">
      {/* A mesma largura e margem da conversa: as duas colunas alinham. */}
      <div className="mx-auto w-full max-w-3xl px-8">
        {above}
        {proof ? (
          <p data-testid="turn-summary" className="mb-2 px-1 text-[12px] leading-snug text-muted">
            {proof}
          </p>
        ) : null}
        <LedgerPanel sessionId={sessionId} />
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
            <span className="min-w-0">{failing.label} falhou ·</span>
            <button
              type="button"
              onClick={() => void actions.fixCheck(sessionId, failing.id)}
              className="shrink-0 rounded-sm text-fg underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)]"
            >
              Mandar ao agente
            </button>
          </p>
        ) : null}
        {split.card}
        <div className="composer @container rounded-xl bg-surface shadow-raised transition-shadow duration-200">
          <textarea
            ref={input}
            value={text}
            rows={1}
            disabled={offline}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(canSteer && (e.ctrlKey || e.metaKey) ? 'now' : 'queue');
              }
            }}
            placeholder={
              handed
                ? handed
                : offline
                  ? 'A sessão não está ligada'
                  : state === 'needs-you'
                    ? `O ${agentLabel} aguarda a tua decisão · podes deixar uma mensagem na fila`
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
          <div className="flex items-end gap-2 px-2.5 pt-1 pb-2.5">
            {/* Estreito (painel de rever aberto): as pílulas ocupam a largura e o enviar fica à parte. */}
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {capabilities ? (
                <RacePill
                  agent={agent}
                  settings={settings}
                  capabilities={capabilities}
                  lanes={lanes}
                  onLanes={setLanes}
                  disabled={offline || busy}
                />
              ) : null}
              {capabilities ? split.pill : null}
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
            </div>
            <div className="flex shrink-0 items-center gap-3 pb-0.5 text-[12px] text-muted">
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
                className="grid size-8 place-items-center rounded-full bg-fg text-bg sl-press disabled:bg-surface-sunken disabled:text-subtle"
              >
                {/* Anima só quando o agente começa ou acaba; escrever troca parar/fila sem animar. */}
                <IconSwap swapKey={busy ? 'busy' : 'idle'}>
                  {busy ? (
                    <IconSwap swapKey={role} instant>
                      {role === 'stop' ? (
                        <Square size={11} fill="currentColor" strokeWidth={0} />
                      ) : (
                        <ListPlus size={16} strokeWidth={2} />
                      )}
                    </IconSwap>
                  ) : (
                    <ArrowUp size={16} strokeWidth={2.25} />
                  )}
                </IconSwap>
              </button>
            </div>
          </div>
        </div>
      </div>
      {split.dialog}
    </div>
  );
}
