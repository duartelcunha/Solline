import { useMemo, useReducer, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Gauge, X } from 'lucide-react';
import { findModel } from '@solline/protocol';
import { Item, MenuShell, triggerClass } from '../../components/menu.tsx';
import { actions, sessionStore, useApp, useSession } from '../../stores/app.ts';
import { AgentBot } from '../agents/bots.tsx';
import { blockedReason } from '../agents/new-session-button.tsx';
import { shortModelName } from '../composer/pills.tsx';
import { laneOptions } from '../race/lane-options.ts';
import { draftGate, draftNote, handoffReducer, initialHandoff, sendGate } from './handoff-model.ts';

const button =
  'sl-press h-8 rounded-control px-3 text-[12.5px] disabled:cursor-default disabled:opacity-50';

/** Abre quando `handoffFor` aponta para uma sessão; fecha-se sozinho ao enviar. */
export function HandoffDialog() {
  const sessionId = useApp((s) => s.handoffFor);
  if (!sessionId) return null;
  return <HandoffBody key={sessionId} sessionId={sessionId} />;
}

function HandoffBody({ sessionId }: { sessionId: string }) {
  const agents = useApp((s) => s.agents);
  const projects = useApp((s) => s.projects);
  const title = useSession(sessionId, (s) => s.info.title);
  const agent = useSession(sessionId, (s) => s.info.agent);
  const projectId = useSession(sessionId, (s) => s.projectId);
  const settings = useSession(sessionId, (s) => s.info.settings);
  const capabilities = useSession(sessionId, (s) => s.capabilities);
  const project = projects.find((p) => p.id === projectId);

  // O agente seguinte: os outros modelos do mesmo agente e os outros agentes prontos neste projeto.
  const options = useMemo(() => {
    const usable = agents.filter((a) => !project || blockedReason(a, project) === null);
    return laneOptions({
      agent,
      model: settings.model,
      models: capabilities?.models ?? [],
      agents: usable,
      modelLabel: (m) => shortModelName(m, m.id),
    });
  }, [agents, project, agent, settings.model, capabilities]);
  const preferred = options.find((o) => o.lane.agent !== agent) ?? options[0];

  const [state, dispatch] = useReducer(handoffReducer, preferred?.key ?? null, initialHandoff);
  const cancelled = useRef(false);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const goalInput = useRef<HTMLTextAreaElement>(null);

  const chosen = options.find((o) => o.key === state.choice);
  const target = chosen?.lane;
  const targetLabel = chosen?.label ?? 'agente';
  const targetDescriptor = agents.find((a) => a.id === target?.agent);

  // O esforço só se escolhe quando o agente seguinte é o mesmo (só dele se conhecem os modelos).
  const sameAgent = target?.agent === agent;
  const targetModel = sameAgent
    ? findModel(capabilities?.models ?? [], target?.model ?? settings.model)
    : undefined;
  const efforts = useMemo(() => {
    const order = capabilities?.effortOrder ?? [];
    return [...(targetModel?.efforts ?? [])].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }, [capabilities, targetModel]);

  const draft = draftGate(state);
  const send = sendGate(state);
  const working = state.step === 'drafting' || state.step === 'sending';

  async function writeDraft() {
    if (!target || !draft.ok) return;
    cancelled.current = false;
    dispatch({ type: 'draft' });
    const result = await actions.draftHandoff(
      sessionId,
      target.agent,
      state.goal.trim(),
      target.model,
    );
    if (cancelled.current) {
      // Desistir não é uma falha: o erro que o motor guardou ao cancelar não interessa.
      sessionStore(sessionId)?.setState({ actionError: null });
      return;
    }
    if (result) {
      dispatch({ type: 'drafted', result });
      queueMicrotask(() => textInput.current?.focus());
    } else {
      const message = sessionStore(sessionId)?.getState().actionError ?? null;
      sessionStore(sessionId)?.setState({ actionError: null });
      dispatch({ type: 'draftFailed', error: message ?? 'Não foi possível escrever o rascunho.' });
    }
  }

  function stopDraft() {
    cancelled.current = true;
    dispatch({ type: 'cancelDraft' });
    void actions.cancelHandoffDraft(sessionId);
    sessionStore(sessionId)?.setState({ actionError: null });
  }

  async function submit() {
    if (!target || !send.ok) return;
    dispatch({ type: 'send' });
    const ok = await actions.startHandoff(sessionId, target.agent, state.text.trim(), {
      ...(target.model ? { model: target.model } : {}),
      ...(state.effort ? { effort: state.effort } : {}),
    });
    if (ok) actions.closeHandoff();
    else {
      const message = sessionStore(sessionId)?.getState().actionError ?? null;
      sessionStore(sessionId)?.setState({ actionError: null });
      dispatch({ type: 'sendFailed', error: message ?? 'Não foi possível passar o testemunho.' });
    }
  }

  // Esc e o clique fora passam por aqui: um rascunho a meio cancela-se antes de fechar.
  const onOpenChange = (open: boolean) => {
    if (open) return;
    if (state.step === 'sending') return;
    if (state.step === 'drafting') stopDraft();
    actions.closeHandoff();
  };

  const note = state.step === 'edit' || state.step === 'sending' ? draftNote(state) : null;

  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Content
          data-testid="handoff-dialog"
          data-step={state.step}
          // Abre a pedir o objetivo: é a única coisa que falta escrever.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            goalInput.current?.focus();
          }}
          onKeyDown={(event) => {
            // Ctrl/⌘+Enter: o atalho do botão principal (que também se clica).
            if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
            event.preventDefault();
            if (state.step === 'form') void writeDraft();
            else if (state.step === 'edit') void submit();
          }}
          className="dialog-content fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] w-[min(36rem,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-raised outline-none"
        >
          <header className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[14px] font-semibold tracking-[-0.01em]">
                Passar a outro agente
              </Dialog.Title>
              <Dialog.Description className="line-clamp-2 text-[12px] text-muted">
                O trabalho de “{title}” continua na mesma pasta. Nada arranca sem o enviares.
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Fechar sem passar"
              data-testid="handoff-close"
              className="sl-press grid size-7 shrink-0 place-items-center rounded-md text-subtle hover:bg-surface-hover hover:text-fg"
            >
              <X size={14} />
            </Dialog.Close>
          </header>

          {options.length === 0 ? (
            <p className="text-[12.5px] text-muted" data-testid="handoff-none">
              Não há outro agente pronto neste projeto. Abre a gestão de agentes para entrar ou
              instalar um.
            </p>
          ) : (
            <>
              <div
                className="flex flex-wrap items-center gap-2"
                role="group"
                aria-label="Para quem passa"
              >
                <MenuShell
                  title="Passar a"
                  side="bottom"
                  trigger={
                    <Menu.Trigger
                      disabled={working}
                      data-testid="handoff-agent"
                      aria-label={`Passar a: ${targetLabel}. Mudar`}
                      className={`${triggerClass} max-w-full`}
                    >
                      {targetDescriptor ? <AgentBot agent={targetDescriptor} size={18} /> : null}
                      <span className="min-w-0 truncate">{targetLabel}</span>
                      <ChevronDown aria-hidden size={12} strokeWidth={2} className="opacity-60" />
                    </Menu.Trigger>
                  }
                >
                  <Menu.RadioGroup
                    value={state.choice ?? ''}
                    onValueChange={(choice) => dispatch({ type: 'choose', choice })}
                  >
                    {options.map((o) => (
                      <Item
                        key={o.key}
                        value={o.key}
                        title={o.label}
                        description={
                          o.lane.agent === agent ? 'Mesmo agente, outro modelo' : undefined
                        }
                        icon={(() => {
                          const descriptor = agents.find((a) => a.id === o.lane.agent);
                          return descriptor ? <AgentBot agent={descriptor} size={18} /> : null;
                        })()}
                        testId={`handoff-option-${o.lane.agent}${o.lane.model ? `-${o.lane.model}` : ''}`}
                      />
                    ))}
                  </Menu.RadioGroup>
                </MenuShell>

                {efforts.length > 0 ? (
                  <MenuShell
                    title="Esforço"
                    side="bottom"
                    trigger={
                      <Menu.Trigger
                        disabled={working}
                        data-testid="handoff-effort"
                        aria-label={`Esforço: ${state.effort ?? 'padrão'}. Mudar`}
                        className={triggerClass}
                      >
                        <Gauge aria-hidden size={13} strokeWidth={1.9} />
                        {state.effort ?? 'esforço padrão'}
                        <ChevronDown aria-hidden size={12} strokeWidth={2} className="opacity-60" />
                      </Menu.Trigger>
                    }
                  >
                    <Menu.RadioGroup
                      value={state.effort ?? ''}
                      onValueChange={(effort) => dispatch({ type: 'effort', effort })}
                    >
                      {efforts.map((level) => (
                        <Item
                          key={level}
                          value={level}
                          title={level}
                          testId={`handoff-effort-${level}`}
                        />
                      ))}
                    </Menu.RadioGroup>
                  </MenuShell>
                ) : null}
              </div>

              {state.step === 'form' || state.step === 'drafting' ? (
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium text-muted">O que deve fazer</span>
                  <textarea
                    value={state.goal}
                    disabled={state.step === 'drafting'}
                    onChange={(e) => dispatch({ type: 'goal', goal: e.target.value })}
                    rows={3}
                    maxLength={4000}
                    placeholder="ex. executa a fase 1 do plano"
                    data-testid="handoff-goal"
                    ref={goalInput}
                    className="block max-h-[40vh] min-h-[4.5rem] w-full resize-none rounded-control border border-line bg-bg px-3 py-2 text-[13px] leading-[1.5] outline-none [field-sizing:content] placeholder:text-subtle focus:border-line-strong disabled:opacity-60"
                  />
                </label>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <p className="truncate text-[12px] text-muted" title={state.goal}>
                    Objetivo: {state.goal}
                  </p>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[12px] font-medium text-muted">
                      Rascunho para {targetLabel}
                    </span>
                    <textarea
                      ref={textInput}
                      value={state.text}
                      disabled={state.step === 'sending'}
                      onChange={(e) => dispatch({ type: 'edit', text: e.target.value })}
                      data-testid="handoff-text"
                      className="block max-h-[45vh] min-h-[10rem] w-full resize-none rounded-control border border-line bg-bg px-3 py-2 font-mono text-[12px] leading-[1.55] outline-none [field-sizing:content] focus:border-line-strong disabled:opacity-60"
                    />
                  </label>
                </div>
              )}

              {state.step === 'drafting' ? (
                <p
                  role="status"
                  className="flex items-center gap-2 text-[12.5px] text-muted"
                  data-testid="handoff-progress"
                >
                  <span
                    aria-hidden
                    className="spinner block size-[12px] shrink-0 rounded-full border-[1.5px] border-current border-t-transparent text-subtle"
                  />
                  A escrever o rascunho… é só leitura, nada muda na pasta.
                </p>
              ) : null}
              {note ? (
                <p className="text-[12px] text-muted" data-testid="handoff-note">
                  {note}
                </p>
              ) : null}
              {state.error ? (
                <p role="alert" className="text-[12.5px] text-danger" data-testid="handoff-error">
                  {state.error}
                </p>
              ) : null}
            </>
          )}

          <footer className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            {state.step === 'drafting' ? (
              <button
                type="button"
                onClick={stopDraft}
                className={`${button} border border-line hover:bg-surface-hover`}
                data-testid="handoff-cancel-draft"
              >
                Cancelar rascunho
              </button>
            ) : state.step === 'edit' || state.step === 'sending' ? (
              <>
                <button
                  type="button"
                  disabled={state.step === 'sending'}
                  onClick={() => dispatch({ type: 'back' })}
                  className={`${button} text-muted hover:bg-surface-hover hover:text-fg`}
                  data-testid="handoff-back"
                >
                  Voltar
                </button>
                <button
                  type="button"
                  disabled={!send.ok || state.step === 'sending'}
                  onClick={() => void submit()}
                  title={send.reason ?? 'Enviar (Ctrl+Enter)'}
                  className={`${button} ml-auto bg-fg font-medium text-bg`}
                  data-testid="handoff-send"
                >
                  {state.step === 'sending' ? 'A passar…' : `Enviar a ${targetLabel}`}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => actions.closeHandoff()}
                  className={`${button} text-muted hover:bg-surface-hover hover:text-fg`}
                  data-testid="handoff-dismiss"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={!draft.ok || options.length === 0}
                  onClick={() => void writeDraft()}
                  title={draft.reason ?? 'Escrever rascunho (Ctrl+Enter)'}
                  className={`${button} ml-auto bg-fg font-medium text-bg`}
                  data-testid="handoff-draft"
                >
                  Escrever rascunho
                </button>
              </>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
