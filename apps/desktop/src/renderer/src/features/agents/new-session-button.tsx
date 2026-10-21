import * as Menu from '@radix-ui/react-dropdown-menu';
import { AgentBot } from './bots.tsx';
import { Check, ChevronDown, LogIn, Plus, SlidersHorizontal } from 'lucide-react';
import type { AgentDescriptor, Project } from '@solline/protocol';
import { ActionItem, MenuShell } from '../../components/menu.tsx';
import { IconSwap } from '@solline/ui/icon-swap';
import { actions, useApp } from '../../stores/app.ts';
import { Spinner } from '../conversation/blocks.tsx';

/** Porque é que um agente não se pode abrir neste projeto, ou null se pode. */
const NOT_READY: Partial<Record<AgentDescriptor['status'], string>> = {
  'not-found': 'Não instalado',
  unreviewed: 'Versão por rever',
  'needs-login': 'Falta entrar',
  error: 'Com erro',
};

export function blockedReason(agent: AgentDescriptor, project: Project): string | null {
  if (agent.status !== 'ready') return NOT_READY[agent.status] ?? 'Não está pronto';
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
    <MenuShell
      title="Nova sessão com"
      trigger={trigger}
      side={side}
      align="start"
      // Ao abrir, volta a ver o estado (por exemplo uma chave acabada de guardar).
      onOpenChange={(open) => {
        if (open) void actions.loadAgents();
      }}
    >
      {agents.map((agent) => {
        const blocked = blockedReason(agent, project);
        // Sem sessão iniciada, o próprio item é o botão de entrar (ou de desistir).
        if (agent.status === 'needs-login' && agent.login) {
          const pending = agent.login.pending;
          return (
            <ActionItem
              key={agent.id}
              title={`${agent.label}: ${pending ? 'à espera do browser…' : agent.login.label}`}
              description={pending ? 'Carrega para cancelar' : agent.detail}
              icon={<LogIn size={14} strokeWidth={1.9} />}
              onSelect={() =>
                void (pending ? actions.cancelLogin(agent.id) : actions.login(agent.id))
              }
              testId={`agent-${agent.id}`}
            />
          );
        }
        return (
          <ActionItem
            key={agent.id}
            title={agent.experimental ? `${agent.label} (experimental)` : agent.label}
            description={blocked ?? undefined}
            icon={<AgentBot agent={agent} />}
            disabled={blocked !== null}
            onSelect={() => void actions.createSession(project.id, agent.id)}
            testId={`agent-${agent.id}`}
          />
        );
      })}
      <McpChoices />
      <Menu.Separator className="my-1 h-px bg-line" />
      <ActionItem
        title="Gerir agentes…"
        icon={<SlidersHorizontal size={14} strokeWidth={1.9} />}
        onSelect={actions.openAgentsPanel}
        testId="open-agents-panel"
      />
    </MenuShell>
  );
}

/** Servidores MCP para ligar às próximas sessões (só a elas, nunca à config do agente). */
function McpChoices() {
  const servers = useApp((s) => s.mcpServers);
  const selected = useApp((s) => s.mcpSelection);
  if (servers.length === 0) return null;
  return (
    <>
      <Menu.Separator className="my-1 h-px bg-line" />
      <Menu.Label className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-[0.04em] text-subtle uppercase">
        Servidores MCP
      </Menu.Label>
      {servers.map((server) => (
        <Menu.CheckboxItem
          key={server.id}
          checked={selected.includes(server.id)}
          disabled={server.status !== 'ready'}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={() => actions.toggleMcp(server.id)}
          data-testid={`mcp-${server.id}`}
          className="group flex cursor-default items-start gap-2.5 rounded-md px-2.5 py-2 text-[13px] outline-none select-none data-[highlighted]:bg-surface-hover data-[disabled]:opacity-50"
        >
          <span className="mt-0.5 grid size-4 shrink-0 place-items-center text-accent-text">
            <Menu.ItemIndicator>
              <Check size={14} strokeWidth={2.25} />
            </Menu.ItemIndicator>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{server.label}</span>
            <span className="block text-[11.5px] leading-snug text-muted">
              {server.status !== 'ready'
                ? 'Não instalado'
                : server.executesCode
                  ? 'Corre programas: sem Auto e sem "Permitir sempre"'
                  : 'Só nesta sessão'}
            </span>
          </span>
        </Menu.CheckboxItem>
      ))}
    </>
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
  const mcp = useApp((s) => s.mcpServers);
  const creating = useApp((s) =>
    variant === 'icon' ? s.creatingIn === project.id : s.creatingIn !== null,
  );
  const choose = agents.length > 1 || mcp.length > 0;

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
          className="grid size-6 shrink-0 place-items-center rounded-sm text-subtle sl-press hover:bg-surface-hover hover:text-fg disabled:opacity-100"
        >
          <IconSwap swapKey={creating ? 'creating' : 'idle'}>
            {creating ? <Spinner label="A abrir sessão" /> : <Plus size={14} strokeWidth={2} />}
          </IconSwap>
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
                className="grid h-6 w-4 shrink-0 place-items-center rounded-sm text-subtle sl-press hover:bg-surface-hover hover:text-fg data-[state=open]:bg-surface-hover data-[state=open]:text-fg"
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
        className="inline-flex h-10 items-center gap-2 pr-4 pl-5 text-[14px] font-medium sl-press disabled:opacity-60"
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
              className="grid h-10 place-items-center border-l border-bg/20 pr-4 pl-3 sl-press disabled:opacity-60"
            >
              <ChevronDown size={14} strokeWidth={2} />
            </Menu.Trigger>
          }
        />
      ) : null}
    </span>
  );
}
