import { useEffect, useMemo, useState } from 'react';
import { FolderPlus, Moon, Plus, Sun, X } from 'lucide-react';
import type { CommandResult } from '@solline/protocol';
import type { Theme } from '@solline/protocol/bridge';
import { Composer } from './features/composer/composer.tsx';
import { Conversation } from './features/conversation/conversation.tsx';
import { Sidebar, StateDot } from './features/sidebar/sidebar.tsx';
import { actions, dispatch, sessionStore, useApp, useSession } from './stores/app.ts';

const THEME_KEY = 'solline.theme';

function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    void window.solline.window.setTheme(theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

type PingState =
  | { status: 'pending' }
  | { status: 'ok'; ms: number; reply: CommandResult<'engine.ping'> }
  | { status: 'error'; message: string };

function usePing(): PingState {
  const [state, setState] = useState<PingState>({ status: 'pending' });
  useEffect(() => {
    let alive = true;
    const started = performance.now();
    window.solline
      .request('engine.ping', {})
      .then((reply) => {
        if (alive) setState({ status: 'ok', ms: Math.round(performance.now() - started), reply });
      })
      .catch((error: unknown) => {
        if (alive) setState({ status: 'error', message: String(error) });
      });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

function EngineStatus({ ping }: { ping: PingState }) {
  const [dot, label, detail, testId] =
    ping.status === 'pending'
      ? ['bg-subtle', 'A ligar o motor…', undefined, undefined]
      : ping.status === 'error'
        ? ['bg-danger', 'Motor sem resposta', ping.message, undefined]
        : [
            'bg-success',
            'Motor ligado',
            `pong em ${ping.ms} ms · v${ping.reply.engineVersion}`,
            'ping-reply',
          ];
  return (
    <div className="flex items-start gap-2.5" data-testid={testId}>
      <span aria-hidden className={`mt-[7px] size-1.5 shrink-0 rounded-full ${dot}`} />
      <div className="min-w-0">
        <div className="text-[12.5px]">{label}</div>
        {detail ? <div className="truncate font-mono text-[11px] text-subtle">{detail}</div> : null}
      </div>
    </div>
  );
}

function SessionHeaderTitle({ sessionId }: { sessionId: string }) {
  const title = useSession(sessionId, (s) => s.info.title);
  const state = useSession(sessionId, (s) => s.info.state);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <StateDot state={state} />
      <h1
        className="truncate text-[13px] font-semibold tracking-[-0.01em]"
        data-testid="session-title"
      >
        {title}
      </h1>
    </div>
  );
}

function Welcome() {
  const projects = useApp((s) => s.projects);
  const activeProjectId = useApp((s) => s.activeProjectId);
  const creating = useApp((s) => s.creatingIn !== null);
  const project = projects.find((p) => p.id === activeProjectId);
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-6 px-8 text-center">
      <div>
        <h2 className="text-[2rem] leading-tight font-semibold tracking-[-0.025em]">
          {project ? project.name : 'Bem-vindo'}
        </h2>
        <p className="mt-1.5 text-muted">
          {project
            ? 'Abre uma sessão para conversar com o Claude neste projeto.'
            : 'Poder do terminal, facilidade da app.'}
        </p>
      </div>
      {project ? (
        <button
          type="button"
          disabled={creating}
          onClick={() => void actions.createSession(project.id)}
          data-testid="welcome-new-session"
          className="inline-flex h-10 items-center gap-2 rounded-full bg-fg px-5 text-[14px] font-medium text-bg transition-transform duration-150 active:scale-[0.97] disabled:opacity-60"
        >
          <Plus size={16} /> {creating ? 'A abrir…' : 'Nova sessão'}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void actions.addProject()}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-fg px-5 text-[14px] font-medium text-bg transition-transform duration-150 active:scale-[0.97]"
        >
          <FolderPlus size={16} /> Adicionar projeto
        </button>
      )}
    </section>
  );
}

export function App() {
  const [theme, toggleTheme] = useTheme();
  const ping = usePing();
  const sessionIds = useApp((s) => s.sessionIds);
  const activeSessionId = useApp((s) => s.activeSessionId);
  const notice = useApp((s) => s.notice);

  useEffect(() => {
    const off = window.solline.onEvent(dispatch);
    void actions.loadProjects();
    return off;
  }, []);

  const sessionsByProject = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const id of sessionIds) {
      const projectId = sessionStore(id)?.getState().projectId;
      if (projectId) map.set(projectId, [...(map.get(projectId) ?? []), id]);
    }
    return map;
  }, [sessionIds]);

  return (
    <div className="grid h-full grid-cols-[16rem_1fr]">
      <Sidebar sessionsByProject={sessionsByProject} footer={<EngineStatus ping={ping} />} />

      <main className="flex min-w-0 flex-col">
        <header className="drag flex h-11 shrink-0 items-center gap-3 pr-[9.5rem] pl-5">
          {activeSessionId ? <SessionHeaderTitle sessionId={activeSessionId} /> : null}
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
            data-testid="theme-toggle"
            className="no-drag ml-auto grid size-8 place-items-center rounded-sm text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-fg active:scale-95"
          >
            {theme === 'dark' ? (
              <Sun size={16} strokeWidth={1.75} />
            ) : (
              <Moon size={16} strokeWidth={1.75} />
            )}
          </button>
        </header>

        {notice ? (
          <div
            role="status"
            className="appear mx-auto mt-1 flex w-full max-w-3xl items-center gap-3 px-8"
          >
            <p
              className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2 text-[12.5px] text-muted"
              data-testid="app-notice"
            >
              {notice}
            </p>
            <button
              type="button"
              aria-label="Fechar aviso"
              onClick={actions.dismissNotice}
              className="grid size-7 place-items-center rounded-sm text-subtle hover:bg-surface-hover hover:text-fg"
            >
              <X size={14} />
            </button>
          </div>
        ) : null}

        {activeSessionId ? (
          <>
            <Conversation key={activeSessionId} sessionId={activeSessionId} />
            <Composer key={`c-${activeSessionId}`} sessionId={activeSessionId} />
          </>
        ) : (
          <Welcome />
        )}
      </main>
    </div>
  );
}
