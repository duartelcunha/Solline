import { Pin } from '../../components/pin.tsx';
import { FolderPlus, Folder, ShieldCheck, ShieldOff } from 'lucide-react';
import { APP_NAME } from '@solline/protocol/app';
import type { Project, SessionState } from '@solline/protocol';
import { actions, useApp, useSession } from '../../stores/app.ts';
import { SessionAvatar } from '../agents/crew.tsx';
import { NewSessionButton } from '../agents/new-session-button.tsx';

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
  const active = useApp((s) => s.activeSessionId === id);
  return (
    <li>
      <button
        type="button"
        onClick={() => actions.selectSession(id)}
        aria-current={active ? 'page' : undefined}
        aria-label={`${title}, ${STATE_LABEL[state]}`}
        data-testid="session-row"
        data-state={state}
        className={`flex w-full items-center gap-2 rounded-md py-1 pr-2 pl-5 text-left text-[13px] transition-colors duration-150 active:bg-surface-hover ${active ? 'bg-surface-hover text-fg' : 'text-muted hover:bg-surface-hover/70 hover:text-fg'}`}
      >
        <SessionAvatar sessionId={id} size={26} />
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </button>
    </li>
  );
}

/** Ações de linha que só aparecem ao passar ou com o foco lá dentro. */
const reveal =
  'opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 has-[[data-state=open]]:opacity-100';

function ProjectGroup({ project, sessionIds }: { project: Project; sessionIds: string[] }) {
  const activeProject = useApp((s) => s.activeProjectId === project.id);
  return (
    <li className="mb-2">
      <div className="group flex items-center gap-1 pr-1">
        <button
          type="button"
          onClick={() => actions.selectProject(project.id)}
          title={project.path}
          aria-label={`Projeto ${project.name}`}
          data-testid="project-row"
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition-colors duration-150 active:bg-surface-hover/70 ${activeProject ? 'text-fg' : 'text-muted hover:text-fg'}`}
        >
          <Folder size={14} strokeWidth={1.75} className="shrink-0 text-subtle" />
          <span className="truncate">{project.name}</span>
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
          {project.trusted ? (
            <ShieldCheck size={14} strokeWidth={1.9} />
          ) : (
            <ShieldOff size={14} strokeWidth={1.9} />
          )}
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
}: {
  sessionsByProject: Map<string, string[]>;
  footer: React.ReactNode;
}) {
  const projects = useApp((s) => s.projects);
  return (
    <aside
      className="flex min-h-0 flex-col border-r border-line bg-sidebar"
      aria-label="Projetos e sessões"
    >
      <div className="drag flex h-11 shrink-0 items-center gap-2 px-4">
        <Pin size={20} className="text-accent" />
        <span className="text-[13px] font-semibold tracking-[-0.035em]">{APP_NAME}</span>
      </div>

      <div className="px-2 pt-1">
        <button
          type="button"
          onClick={() => void actions.addProject()}
          data-testid="add-project"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-fg active:bg-surface-sunken"
        >
          <FolderPlus size={15} strokeWidth={1.75} />
          Adicionar projeto
        </button>
      </div>

      <div className="mt-4 px-4 text-[11px] font-medium tracking-[0.04em] text-subtle uppercase">
        Projetos
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pt-1.5">
        {projects.length === 0 ? (
          <p className="px-2 pt-1 text-[12.5px] leading-relaxed text-subtle">
            Adiciona uma pasta para começar.
          </p>
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
