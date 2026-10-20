import * as Menu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Plus } from 'lucide-react';
import type { AgentDescriptor, Project } from '@solline/protocol';
import { ActionItem, MenuShell } from '../../components/menu.tsx';
import { actions, useApp } from '../../stores/app.ts';
import { Spinner } from '../conversation/blocks.tsx';

/** Porque é que um agente não se pode abrir neste projeto, ou null se pode. */
export function blockedReason(agent: AgentDescriptor, project: Project): string | null {
  if (agent.status !== 'ready') return agent.detail ?? 'Não está pronto nesta máquina';
  if (agent.untrustedProjects === 'refused' && !project.trusted) {
    return 'Só corre em projetos de confiança';
  }
  return null;
}

function AgentMenu({
  project,
  agents,
  trigger,
  side,
}: {
  project: Project;
  agents: readonly AgentDescriptor[];
  trigger: React.ReactNode;
  side: 'right' | 'bottom';
}) {
  return (
    <MenuShell title="Nova sessão com" trigger={trigger} side={side} align="start">
      {agents.map((agent) => {
        const blocked = blockedReason(agent, project);
        return (
          <ActionItem
            key={agent.id}
            title={agent.experimental ? `${agent.label} (experimental)` : agent.label}
            description={blocked ?? undefined}
            disabled={blocked !== null}
            onSelect={() => void actions.createSession(project.id, agent.id)}
            testId={`agent-${agent.id}`}
          />
        );
      })}
    </MenuShell>
  );
}

/**
 * Nova sessão num projeto. O clique principal abre com o agente por omissão; com mais de um
 * agente aparece uma seta para escolher.
 */
export function NewSessionButton({
  project,
  variant,
}: {
  project: Project;
  variant: 'icon' | 'primary';
}) {
  const agents = useApp((s) => s.agents);
  const creating = useApp((s) =>
    variant === 'icon' ? s.creatingIn === project.id : s.creatingIn !== null,
  );
  const choose = agents.length > 1;

  if (variant === 'icon') {
    return (
      <span className="flex shrink-0 items-center">
        <button
          type="button"
          onClick={() => void actions.createSession(project.id)}
          disabled={creating}
          aria-label={`Nova sessão em ${project.name}`}
          title="Nova sessão"
          data-testid="new-session"
          className="grid size-6 shrink-0 place-items-center rounded-sm text-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-fg disabled:opacity-100"
        >
          {creating ? <Spinner label="A abrir sessão" /> : <Plus size={14} strokeWidth={2} />}
        </button>
        {choose ? (
          <AgentMenu
            project={project}
            agents={agents}
            side="right"
            trigger={
              <Menu.Trigger
                disabled={creating}
                aria-label={`Escolher o agente para a nova sessão em ${project.name}`}
                title="Escolher o agente"
                data-testid="new-session-agent"
                className="grid h-6 w-4 shrink-0 place-items-center rounded-sm text-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-fg data-[state=open]:bg-surface-hover data-[state=open]:text-fg"
              >
                <ChevronDown size={12} strokeWidth={2} />
              </Menu.Trigger>
            }
          />
        ) : null}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center overflow-hidden rounded-full bg-fg text-bg">
      <button
        type="button"
        disabled={creating}
        onClick={() => void actions.createSession(project.id)}
        data-testid="welcome-new-session"
        className="inline-flex h-10 items-center gap-2 pr-4 pl-5 text-[14px] font-medium transition-transform duration-150 active:scale-[0.97] disabled:opacity-60"
      >
        <Plus size={16} /> {creating ? 'A abrir…' : 'Nova sessão'}
      </button>
      {choose ? (
        <AgentMenu
          project={project}
          agents={agents}
          side="bottom"
          trigger={
            <Menu.Trigger
              disabled={creating}
              aria-label="Escolher o agente para a nova sessão"
              data-testid="welcome-new-session-agent"
              className="grid h-10 place-items-center border-l border-bg/20 pr-4 pl-3 transition-opacity duration-150 disabled:opacity-60"
            >
              <ChevronDown size={14} strokeWidth={2} />
            </Menu.Trigger>
          }
        />
      ) : null}
    </span>
  );
}
