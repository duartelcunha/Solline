import { Logo } from '../../components/logo.tsx';
import {
  CircleDot,
  Folder,
  Globe2,
  LayoutGrid,
  Network,
  Plus,
  ShieldCheck,
  ShieldOff,
  X,
} from 'lucide-react';
import { IconSwap } from '@solline/ui/icon-swap';
import { useNeedsYouCount } from '../desk/desk.tsx';
import { APP_NAME } from '@solline/protocol/app';
import type { Project, SessionState } from '@solline/protocol';
import { actions, useApp, useSession } from '../../stores/app.ts';
import { SessionMark } from '../agents/bots.tsx';
import { NewSessionButton } from '../agents/new-session-button.tsx';
import { useSpaces } from '../../stores/spaces.ts';
import { pendingCounts } from '../memory/memory-model.ts';

/** Quantas propostas de memória esperam por ti: um número calmo, sem fundo, que só diz que há algo. */
function usePendingCounts() {
  const memories = useSpaces((s) => s.data.memories);
  return pendingCounts(memories);
}

function PendingCount({ count, testId }: { count: number; testId: string }) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden
      data-testid={testId}
      className="ml-auto shrink-0 text-[11px] tabular-nums text-attention"
    >
      {count}
    </span>
  );
}

function pendingLabel(count: number): string {
  return `${count} ${count === 1 ? 'memória proposta' : 'memórias propostas'} por aprovar`;
}

const STATE_LABEL: Record<SessionState, string> = {
  starting: 'a arrancar',
  idle: 'parada',
  running: 'a trabalhar',
  'needs-you': 'precisa de ti',
  error: 'caiu',
};

function SessionRow({ id }: { id: string }) {
  const title = useSession(id, (s) => s.info.title);
  const state = useSession(id, (s) => s.info.state);
  const active = useApp((s) => s.view === 'session' && s.activeSessionId === id);
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => actions.selectSession(id)}
        aria-current={active ? 'page' : undefined}
        aria-label={`${title}, ${STATE_LABEL[state]}`}
        title={title}
        data-testid="session-row"
        data-state={state}
        className={`relative flex w-full items-center gap-2 rounded-md py-1.5 pr-7 pl-5 text-left text-[13px] transition-colors duration-150 active:bg-surface-hover ${active ? 'bg-surface-hover text-fg' : 'text-muted hover:bg-surface-hover/70 hover:text-fg'}`}
      >
        {active ? (
          <span
            aria-hidden
            className="absolute top-1/2 left-1 h-4 w-0.5 -translate-y-1/2 rounded-full bg-current"
          />
        ) : null}
        <span className="grid w-4 shrink-0 place-items-center">
          <SessionMark sessionId={id} />
        </span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </button>
      <button
        type="button"
        onClick={() => void actions.closeSession(id)}
        aria-label={`Fechar ${title}`}
        title="Fechar sessão"
        data-testid="session-close"
        className={`absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-md text-subtle hover:bg-surface-hover hover:text-fg ${reveal}`}
      >
        <X size={13} />
      </button>
    </li>
  );
}

/** Ações de linha que só aparecem ao passar ou com o foco lá dentro. */
const reveal =
  'opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 has-[[data-state=open]]:opacity-100';

function ProjectGroup({ project, sessionIds }: { project: Project; sessionIds: string[] }) {
  const activeProject = useApp((s) => s.activeProjectId === project.id);
  const pending = usePendingCounts().byProject.get(project.id) ?? 0;
  return (
    <li className="mb-2">
      <div className="group flex items-center gap-1 pr-1">
        <button
          type="button"
          onClick={() => actions.openSpace(project.id)}
          title={project.path}
          aria-label={
            pending > 0
              ? `Projeto ${project.name}, ${pendingLabel(pending)}`
              : `Projeto ${project.name}`
          }
          data-testid="project-row"
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition-colors duration-150 active:bg-surface-hover/70 ${activeProject ? 'text-fg' : 'text-muted hover:text-fg'}`}
        >
          <Folder size={14} strokeWidth={1.75} className="shrink-0 text-subtle" />
          <span className="truncate">{project.name}</span>
          <PendingCount count={pending} testId="project-pending" />
        </button>
        <button
          type="button"
          onClick={() => void actions.setProjectTrusted(project.id, !project.trusted)}
          aria-pressed={project.trusted}
          aria-label={
            project.trusted
              ? `Tirar a confiança a ${project.name}`
              : `Confiar no projeto ${project.name}`
          }
          title={
            project.trusted
              ? 'Projeto de confiança: os agentes leem as definições da pasta'
              : 'Sem confiança: os agentes não leem as definições da pasta'
          }
          data-testid="project-trust"
          data-trusted={project.trusted}
          // De confiança é o normal: o escudo só aparece ao passar. Sem confiança fica à vista.
          className={`grid size-6 shrink-0 place-items-center rounded-sm sl-press transition-[color,background-color,opacity] duration-150 hover:bg-surface-hover hover:text-fg ${project.trusted ? `text-subtle ${reveal}` : 'text-accent-text'}`}
        >
          <IconSwap swapKey={project.trusted ? 'on' : 'off'}>
            {project.trusted ? (
              <ShieldCheck size={14} strokeWidth={1.9} />
            ) : (
              <ShieldOff size={14} strokeWidth={1.9} />
            )}
          </IconSwap>
        </button>
        <button
          type="button"
          onClick={() => actions.openIssues(project.id)}
          aria-label={`Issues de ${project.name}`}
          title="Issues"
          data-testid="project-issues"
          className={`grid size-6 shrink-0 place-items-center rounded-sm text-subtle sl-press hover:bg-surface-hover hover:text-fg ${
            activeProject ? '' : reveal
          }`}
        >
          <CircleDot size={14} strokeWidth={1.75} />
        </button>
        <span className={`flex shrink-0 ${activeProject ? '' : reveal}`}>
          <NewSessionButton project={project} variant="icon" />
        </span>
      </div>
      {sessionIds.length > 0 ? (
        <ul className="mt-0.5 space-y-px">
          {sessionIds.map((id) => (
            <SessionRow key={id} id={id} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function Sidebar({
  sessionsByProject,
  footer,
  search,
}: {
  sessionsByProject: Map<string, string[]>;
  footer: React.ReactNode;
  search?: React.ReactNode;
}) {
  const projects = useApp((s) => s.projects);
  const pending = usePendingCounts().total;
  return (
    <aside
      className="flex min-h-0 flex-col border-r border-line bg-sidebar"
      aria-label="Projetos e sessões"
    >
      <div className="drag flex h-11 shrink-0 items-center gap-2 px-4">
        <Logo size={20} />
        <span className="text-[13px] font-semibold tracking-[-0.035em]">{APP_NAME}</span>
      </div>

      <div className="px-2 pt-1">
        {search}
        <button
          type="button"
          onClick={() => actions.openSpace(null)}
          data-testid="open-general"
          aria-label={pending > 0 ? `Geral, ${pendingLabel(pending)}` : 'Geral'}
          className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-[13px] text-muted hover:bg-surface-hover hover:text-fg"
        >
          <Globe2 size={15} strokeWidth={1.75} />
          Geral
          <PendingCount count={pending} testId="general-pending" />
        </button>
        <DeskButton />
        <MapButton />
      </div>

      <div className="mt-4 flex items-center pr-2 pl-4">
        <span className="flex-1 text-[11px] font-medium tracking-[0.04em] text-subtle uppercase">
          Projetos
        </span>
        <button
          type="button"
          onClick={() => void actions.addProject()}
          aria-label="Adicionar projeto"
          title="Adicionar projeto"
          data-testid="add-project"
          className="grid size-6 place-items-center rounded-control text-subtle sl-press hover:bg-surface-hover hover:text-fg"
        >
          <Plus size={14} strokeWidth={1.9} />
        </button>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pt-1.5">
        {projects.length === 0 ? (
          <button
            type="button"
            onClick={() => void actions.addProject()}
            className="px-2 pt-1 text-left text-[12.5px] leading-relaxed text-subtle hover:text-fg"
          >
            Adiciona uma pasta para começar.
          </button>
        ) : (
          <ul>
            {projects.map((project) => (
              <ProjectGroup
                key={project.id}
                project={project}
                sessionIds={sessionsByProject.get(project.id) ?? []}
              />
            ))}
          </ul>
        )}
      </nav>

      <div className="border-t border-line px-4 py-3">{footer}</div>
    </aside>
  );
}

/** A mesa: todas as sessões de uma vez. O número âmbar diz quantas precisam de ti. */
function DeskButton() {
  const open = useApp((s) => s.view === 'desk');
  const waiting = useNeedsYouCount();
  return (
    <button
      type="button"
      onClick={() => actions.openDesk()}
      aria-current={open ? 'page' : undefined}
      data-testid="open-desk"
      className={`relative flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-[13px] transition-colors duration-150 active:bg-surface-sunken ${
        open ? 'bg-surface-hover text-fg' : 'text-muted hover:bg-surface-hover hover:text-fg'
      }`}
    >
      {open ? (
        <span
          aria-hidden
          className="absolute top-1/2 left-1 h-4 w-0.5 -translate-y-1/2 rounded-full bg-current"
        />
      ) : null}
      <LayoutGrid size={15} strokeWidth={1.75} />
      Mesa
      {waiting > 0 ? (
        <span
          className="ml-auto grid h-4.5 min-w-4.5 place-items-center rounded-full bg-attention-soft px-1 text-[10.5px] font-semibold text-attention tabular-nums"
          aria-label={`${waiting} à tua espera`}
          data-testid="desk-waiting"
        >
          {waiting}
        </span>
      ) : null}
    </button>
  );
}

/** O Mapa: quem passou o testemunho e quem se bifurcou de quem, por projeto. */
function MapButton() {
  const hasWork = useApp((s) => s.projects.length > 0 || s.sessionIds.length > 0);
  const open = useApp((s) => s.mapOpen);
  if (!hasWork) return null;
  return (
    <button
      type="button"
      onClick={() => actions.openMap()}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-testid="open-map"
      className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-[13px] text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-fg active:bg-surface-sunken"
    >
      <Network size={15} strokeWidth={1.75} />
      Mapa
    </button>
  );
}
