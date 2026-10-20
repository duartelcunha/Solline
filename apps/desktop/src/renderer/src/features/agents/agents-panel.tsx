import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { LogIn, Plus, RefreshCw, X } from 'lucide-react';
import { EnvKeyName, type AgentDescriptor } from '@solline/protocol';
import { actions, useApp } from '../../stores/app.ts';
import { Spinner } from '../conversation/blocks.tsx';

const STATUS: Record<AgentDescriptor['status'], { label: string; tone: string }> = {
  ready: { label: 'Pronto', tone: 'bg-success' },
  'not-found': { label: 'Não instalado', tone: 'bg-line-strong' },
  'needs-login': { label: 'Falta entrar', tone: 'bg-accent' },
  'needs-key': { label: 'Falta a chave', tone: 'bg-accent' },
  unreviewed: { label: 'Versão por rever', tone: 'bg-accent' },
  error: { label: 'Erro', tone: 'bg-danger' },
};

const smallButton =
  'inline-flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 text-[12px] font-medium text-muted transition-[background-color,color,border-color,transform] duration-150 hover:border-line-strong hover:bg-surface-hover hover:text-fg active:scale-[0.97] disabled:opacity-50';

/** Entrar com o agente, ou esperar pelo browser e poder desistir. */
function LoginButton({ agent }: { agent: AgentDescriptor }) {
  // Com sessão iniciada não há nada a fazer aqui.
  if (!agent.login || (agent.status !== 'needs-login' && !agent.login.pending)) return null;
  if (agent.login.pending) {
    return (
      <span className="inline-flex items-center gap-2 text-[12px] text-muted">
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
      type="button"
      onClick={() => void actions.login(agent.id)}
      data-testid={`login-${agent.id}`}
      className={smallButton}
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
  const savedKey = saved.join('\n');

  const has = (name: string) => keys.some((k) => k.toUpperCase() === name.toUpperCase());
  const name = draft.trim();
  const valid = EnvKeyName.safeParse(name).success && !has(name);
  const changed = keys.join('\n') !== savedKey;
  const add = (value: string) => {
    if (!has(value)) setKeys([...keys, value]);
  };
  const suggestions = candidates.filter((c) => !has(c));

  return (
    <div className="mt-3 rounded-md border border-line bg-surface-sunken p-3">
      <p className="text-[12px] leading-snug text-muted">
        Corre sem os segredos do teu ambiente. Escolhe as variáveis que ele recebe (por exemplo a
        chave do fornecedor). A Solline só guarda os nomes.
      </p>
      <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={`Variáveis do ${agent.label}`}>
        {keys.length === 0 ? (
          <li className="text-[12px] text-subtle">Nenhuma.</li>
        ) : (
          keys.map((key) => (
            <li
              key={key}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-line bg-surface pr-1 pl-2.5 font-mono text-[11.5px]"
            >
              {key}
              <button
                type="button"
                aria-label={`Tirar ${key}`}
                onClick={() => setKeys(keys.filter((k) => k !== key))}
                className="grid size-4 place-items-center rounded-full text-subtle hover:bg-surface-hover hover:text-fg"
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
          if (!valid) return;
          add(name);
          setDraft('');
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="NOME_DA_VARIAVEL"
          aria-label={`Nova variável para o ${agent.label}`}
          spellCheck={false}
          data-testid={`keys-input-${agent.id}`}
          className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)]"
        />
        <button type="submit" disabled={!valid} className={smallButton}>
          <Plus size={13} strokeWidth={2} /> Juntar
        </button>
      </form>
      {draft && !valid ? (
        <p className="mt-1 text-[11.5px] text-subtle">
          Só letras, números e _, a começar por letra ou _ (sem repetir).
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
                className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-line px-2.5 font-mono text-[11.5px] text-muted hover:border-line-strong hover:text-fg"
              >
                <Plus size={11} /> {candidate}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="mt-3 flex justify-end gap-2">
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
          disabled={!changed || saving}
          data-testid={`keys-save-${agent.id}`}
          onClick={() => {
            setSaving(true);
            void actions.setKeys(agent.id, keys).then((ok) => {
              setSaving(false);
              if (!ok) setKeys(saved);
            });
          }}
          className="inline-flex h-7 items-center rounded-full bg-fg px-3 text-[12px] font-medium text-bg transition-transform duration-150 active:scale-[0.97] disabled:opacity-40"
        >
          {saving ? 'A guardar…' : 'Guardar'}
        </button>
      </div>
    </div>
  );
}

function AgentRow({ agent, candidates }: { agent: AgentDescriptor; candidates: string[] }) {
  const status = STATUS[agent.status];
  return (
    <li
      className="border-b border-line py-4 last:border-b-0"
      data-testid={`panel-agent-${agent.id}`}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className={`mt-[7px] size-2 shrink-0 rounded-full ${status.tone}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13.5px] font-semibold">{agent.label}</span>
            {agent.experimental ? (
              <span className="text-[11px] text-subtle">experimental</span>
            ) : null}
            <span className="text-[12px] text-muted" data-testid={`panel-status-${agent.id}`}>
              {status.label}
            </span>
          </div>
          {agent.detail ? (
            <p className="mt-0.5 text-[12px] leading-snug text-muted select-text">{agent.detail}</p>
          ) : null}
          {agent.version ? (
            <p className="mt-0.5 font-mono text-[11px] text-subtle">
              instalada {agent.version.installed ?? '?'} · revista {agent.version.reviewed}
            </p>
          ) : null}
          {agent.untrustedProjects === 'refused' ? (
            <p className="mt-0.5 text-[11.5px] text-subtle">Só em projetos de confiança.</p>
          ) : null}
        </div>
        <LoginButton agent={agent} />
      </div>
      {agent.keys ? (
        // Quando o motor muda a lista guardada, o rascunho recomeça a partir dela.
        <KeysEditor key={agent.keys.join('\n')} agent={agent} candidates={candidates} />
      ) : null}
    </li>
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
            </div>
            <button
              type="button"
              onClick={() => void actions.refreshAgents()}
              disabled={checking}
              data-testid="agents-refresh"
              className={smallButton}
            >
              {checking ? <Spinner label="A verificar" /> : <RefreshCw size={13} strokeWidth={2} />}
              Verificar de novo
            </button>
            <Dialog.Close
              aria-label="Fechar o painel de agentes"
              className="grid size-7 place-items-center rounded-sm text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-fg"
            >
              <X size={15} />
            </Dialog.Close>
          </header>
          <ul className="overflow-y-auto px-5">
            {agents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} candidates={candidates} />
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
