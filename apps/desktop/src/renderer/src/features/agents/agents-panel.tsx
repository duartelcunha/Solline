import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, LogIn, Plus, RefreshCw, X } from 'lucide-react';
import { EnvKeyName, type AgentDescriptor } from '@solline/protocol';
import { DURATION, EASE } from '@solline/ui/motion';
import { actions, useApp } from '../../stores/app.ts';
import { Spinner } from '../conversation/blocks.tsx';

type Status = AgentDescriptor['status'];

/** Cada estado tem uma cor de ponto e um chip; a mesma cor no resumo do topo. */
const STATUS: Record<Status, { label: string; dot: string; chip: string }> = {
  ready: { label: 'Pronto', dot: 'bg-success', chip: 'bg-success/12 text-success' },
  'not-found': {
    label: 'Não instalado',
    dot: 'bg-line-strong',
    chip: 'bg-surface-hover text-muted',
  },
  'needs-login': {
    label: 'Falta entrar',
    dot: 'bg-accent',
    chip: 'bg-accent-soft text-accent-text',
  },
  'needs-key': {
    label: 'Falta a chave',
    dot: 'bg-accent',
    chip: 'bg-accent-soft text-accent-text',
  },
  unreviewed: {
    label: 'Versão por rever',
    dot: 'bg-accent',
    chip: 'bg-accent-soft text-accent-text',
  },
  error: { label: 'Erro', dot: 'bg-danger', chip: 'bg-danger/12 text-danger' },
};

const smallButton =
  'inline-flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 text-[12px] font-medium text-muted sl-press hover:border-line-strong hover:bg-surface-hover hover:text-fg disabled:opacity-50';

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Abana o campo quando o nome não serve: o "não" sente-se sem ler a mensagem. */
function shake(element: HTMLElement | null): void {
  if (!element || reducedMotion()) return;
  element.animate(
    [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-4px)' },
      { transform: 'translateX(3px)' },
      { transform: 'translateX(-2px)' },
      { transform: 'translateX(0)' },
    ],
    { duration: DURATION.slow, easing: `cubic-bezier(${EASE.out.join(', ')})` },
  );
}

/** O ponto do estado. Ao passar de "falta entrar" a pronto, sai um anel uma vez. */
function StatusDot({ agent }: { agent: AgentDescriptor }) {
  // Compara com o estado anterior durante o desenho (sem efeito): o anel sai no mesmo frame.
  const [previous, setPrevious] = useState(agent.status);
  const [celebrate, setCelebrate] = useState(0);
  if (previous !== agent.status) {
    setPrevious(agent.status);
    if (previous === 'needs-login' && agent.status === 'ready') setCelebrate((n) => n + 1);
  }
  const pending = agent.login?.pending === true;
  return (
    <span aria-hidden className="relative mt-[6px] grid size-2.5 shrink-0 place-items-center">
      {celebrate > 0 ? (
        <span key={celebrate} className="status-ping absolute inset-0 rounded-full bg-success" />
      ) : null}
      <span
        className={`meter-dot size-2.5 rounded-full ${STATUS[agent.status].dot} ${pending ? 'dot-pulse' : ''}`}
      />
    </span>
  );
}

/** Entrar com o agente, ou esperar pelo browser e poder cancelar. */
function LoginButton({ agent }: { agent: AgentDescriptor }) {
  const asking = useApp((s) => s.loginRequests.includes(agent.id));
  // Com sessão iniciada não há nada a fazer aqui.
  if (!agent.login || (agent.status !== 'needs-login' && !agent.login.pending)) return null;
  if (agent.login.pending) {
    return (
      <span
        key="pending"
        className="status-swap inline-flex items-center gap-2 text-[12px] text-muted"
      >
        <Spinner label="À espera do browser" /> À espera do browser…
        <button
          type="button"
          onClick={() => void actions.cancelLogin(agent.id)}
          data-testid={`login-cancel-${agent.id}`}
          className={smallButton}
        >
          Cancelar
        </button>
      </span>
    );
  }
  return (
    <button
      key="login"
      type="button"
      onClick={() => void actions.login(agent.id)}
      disabled={asking}
      aria-busy={asking}
      data-testid={`login-${agent.id}`}
      className="status-swap inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-fg px-3 text-[12px] font-medium text-bg sl-press"
    >
      <LogIn size={13} strokeWidth={2} /> {agent.login.label}
    </button>
  );
}

/** As variáveis que um agente ACP recebe: só nomes, guardados depois de confirmares. */
function KeysEditor({ agent, candidates }: { agent: AgentDescriptor; candidates: string[] }) {
  const saved = agent.keys ?? [];
  const [keys, setKeys] = useState<string[]>(saved);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const savedKey = saved.join('\n');
  // Quando o motor muda a lista guardada, o rascunho recomeça a partir dela.
  const [base, setBase] = useState(savedKey);
  if (base !== savedKey) {
    setBase(savedKey);
    setKeys(saved);
  }
  useEffect(() => {
    if (!justSaved) return;
    const timer = setTimeout(() => setJustSaved(false), 1600);
    return () => clearTimeout(timer);
  }, [justSaved]);

  const has = (name: string) => keys.some((k) => k.toUpperCase() === name.toUpperCase());
  const name = draft.trim();
  const valid = EnvKeyName.safeParse(name).success && !has(name);
  const changed = keys.join('\n') !== savedKey;
  const add = (value: string) => {
    if (!has(value)) setKeys([...keys, value]);
  };
  const suggestions = candidates.filter((c) => !has(c));

  return (
    <div className="mt-3 ml-[22px] rounded-md border border-line bg-surface-sunken p-3">
      <p className="text-[12px] leading-snug text-muted">
        Não recebe os segredos do teu ambiente, só as variáveis que escolheres aqui (a chave do
        fornecedor, por exemplo). A Solline guarda só os nomes.
      </p>
      <ul
        className="mt-2 flex min-h-6 flex-wrap gap-1.5"
        aria-label={`Variáveis do ${agent.label}`}
      >
        {keys.length === 0 ? (
          <li className="text-[12px] leading-6 text-subtle">Ainda nenhuma.</li>
        ) : (
          keys.map((key) => (
            <li
              key={key}
              className="chip-in inline-flex h-6 items-center gap-1 rounded-full border border-line bg-surface pr-1 pl-2.5 font-mono text-[11.5px]"
            >
              {key}
              <button
                type="button"
                aria-label={`Tirar ${key}`}
                onClick={() => setKeys(keys.filter((k) => k !== key))}
                className="grid size-4 place-items-center rounded-full text-subtle sl-press hover:bg-surface-hover hover:text-fg"
              >
                <X size={11} />
              </button>
            </li>
          ))
        )}
      </ul>
      <form
        className="mt-2.5 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) {
            shake(input.current);
            return;
          }
          add(name);
          setDraft('');
        }}
      >
        <input
          ref={input}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="NOME_DA_VARIAVEL"
          aria-label={`Nova variável para o ${agent.label}`}
          aria-invalid={draft !== '' && !valid}
          spellCheck={false}
          data-testid={`keys-input-${agent.id}`}
          className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 font-mono text-[12px] outline-none transition-[border-color] duration-150 aria-[invalid=true]:border-danger/60 focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)]"
        />
        <button type="submit" disabled={!valid} className={smallButton}>
          <Plus size={13} strokeWidth={2} /> Juntar
        </button>
      </form>
      {draft && !valid ? (
        <p className="appear mt-1 text-[11.5px] text-subtle">
          {has(name) ? 'Já está na lista.' : 'Letras, números e _, sem começar por um número.'}
        </p>
      ) : null}
      {suggestions.length > 0 ? (
        <div className="mt-2.5">
          <span className="text-[11px] font-medium tracking-[0.04em] text-subtle uppercase">
            No teu ambiente
          </span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {suggestions.map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => add(candidate)}
                className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-line px-2.5 font-mono text-[11.5px] text-muted sl-press hover:border-line-strong hover:text-fg"
              >
                <Plus size={11} /> {candidate}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={!changed || saving}
          onClick={() => setKeys(saved)}
          className={smallButton}
        >
          Repor
        </button>
        <button
          type="button"
          disabled={(!changed && !justSaved) || saving}
          data-testid={`keys-save-${agent.id}`}
          onClick={() => {
            setSaving(true);
            void actions.setKeys(agent.id, keys).then((ok) => {
              setSaving(false);
              if (ok) setJustSaved(true);
              else setKeys(saved);
            });
          }}
          className="inline-flex h-7 min-w-[5.5rem] items-center justify-center gap-1.5 rounded-full bg-fg px-3 text-[12px] font-medium text-bg sl-press disabled:opacity-40"
        >
          <span
            key={saving ? 's' : justSaved ? 'ok' : 'idle'}
            className="status-swap inline-flex items-center gap-1.5"
          >
            {saving ? (
              'A guardar…'
            ) : justSaved ? (
              <>
                <Check size={13} strokeWidth={2.25} /> Guardado
              </>
            ) : (
              'Guardar'
            )}
          </span>
        </button>
      </div>
    </div>
  );
}

function AgentRow({
  agent,
  candidates,
  index,
}: {
  agent: AgentDescriptor;
  candidates: string[];
  index: number;
}) {
  const status = STATUS[agent.status];
  const outdated = agent.version && agent.version.installed !== agent.version.reviewed;
  return (
    <li
      className="row-in border-b border-line py-4 last:border-b-0"
      style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
      data-testid={`panel-agent-${agent.id}`}
    >
      <div className="flex items-start gap-3">
        <StatusDot agent={agent} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13.5px] font-semibold tracking-[-0.005em]">{agent.label}</span>
            <span
              key={agent.status}
              className={`status-swap inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium ${status.chip}`}
              data-testid={`panel-status-${agent.id}`}
            >
              {status.label}
            </span>
            {agent.experimental ? (
              <span className="inline-flex h-5 items-center rounded-full border border-line px-2 text-[11px] text-subtle">
                experimental
              </span>
            ) : null}
          </div>
          {agent.detail ? (
            <p className="mt-1 text-[12px] leading-snug text-muted select-text">{agent.detail}</p>
          ) : null}
          {agent.version || agent.untrustedProjects === 'refused' ? (
            <p className="mt-1 flex flex-wrap gap-x-3 text-[11.5px] text-subtle">
              {agent.version ? (
                <span className="font-mono">
                  <span className={outdated ? 'text-accent-text' : undefined}>
                    {agent.version.installed ?? '?'}
                  </span>{' '}
                  instalada · {agent.version.reviewed} revista
                </span>
              ) : null}
              {agent.untrustedProjects === 'refused' ? (
                <span>Só em projetos de confiança</span>
              ) : null}
            </p>
          ) : null}
        </div>
        <LoginButton agent={agent} />
      </div>
      {agent.keys ? <KeysEditor agent={agent} candidates={candidates} /> : null}
    </li>
  );
}

/** Um ponto por agente, pela ordem do registo: vê-se de relance o que está pronto. */
function Readiness({ agents }: { agents: readonly AgentDescriptor[] }) {
  const ready = agents.filter((a) => a.status === 'ready').length;
  return (
    <div className="flex items-center gap-2" data-testid="agents-readiness">
      <span className="flex items-center gap-1" aria-hidden>
        {agents.map((agent) => (
          <span
            key={agent.id}
            title={`${agent.label}: ${STATUS[agent.status].label}`}
            className={`meter-dot size-1.5 rounded-full ${STATUS[agent.status].dot}`}
          />
        ))}
      </span>
      <span className="text-[12px] text-muted tabular-nums">
        {ready} de {agents.length} {ready === 1 ? 'pronto' : 'prontos'}
      </span>
    </div>
  );
}

/** O estado de cada agente nesta máquina, o login e as variáveis que recebem. */
export function AgentsPanel() {
  const open = useApp((s) => s.agentsPanel);
  const agents = useApp((s) => s.agents);
  const checking = useApp((s) => s.checkingAgents);
  const [candidates, setCandidates] = useState<string[]>([]);
  useEffect(() => {
    if (open) void actions.keyCandidates().then(setCandidates);
  }, [open]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => (next ? undefined : actions.closeAgentsPanel())}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Content
          data-testid="agents-panel"
          className="dialog-content fixed top-1/2 left-1/2 z-50 flex max-h-[86vh] w-[min(40rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-surface shadow-raised outline-none"
        >
          <header className="flex items-start gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[15px] font-semibold tracking-[-0.01em]">
                Agentes
              </Dialog.Title>
              <Dialog.Description className="text-[12px] text-muted">
                O que está pronto nesta máquina e o que cada agente recebe.
              </Dialog.Description>
              <div className="mt-2">
                <Readiness agents={agents} />
              </div>
            </div>
            <button
              type="button"
              onClick={() => void actions.refreshAgents()}
              disabled={checking}
              aria-busy={checking}
              data-testid="agents-refresh"
              className={`${smallButton} disabled:opacity-100`}
            >
              <RefreshCw size={13} strokeWidth={2} className={checking ? 'icon-spin' : undefined} />
              {checking ? 'A verificar…' : 'Verificar de novo'}
            </button>
            <Dialog.Close
              aria-label="Fechar o painel de agentes"
              className="grid size-7 place-items-center rounded-sm text-muted sl-press hover:bg-surface-hover hover:text-fg"
            >
              <X size={15} />
            </Dialog.Close>
          </header>
          <ul className="overflow-y-auto px-5">
            {agents.map((agent, index) => (
              <AgentRow key={agent.id} agent={agent} candidates={candidates} index={index} />
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
