import { useEffect, useMemo, useState } from 'react';
import { FileDiff, FolderPlus, Moon, SlidersHorizontal, Sun, X } from 'lucide-react';
import type { CommandResult } from '@solline/protocol';
import type { Theme } from '@solline/protocol/bridge';
import { Composer } from './features/composer/composer.tsx';
import { AgentsPanel } from './features/agents/agents-panel.tsx';
import { NewSessionButton } from './features/agents/new-session-button.tsx';
import { Conversation } from './features/conversation/conversation.tsx';
import { UncertainOperations } from './features/conversation/uncertain-operations.tsx';
import { QualityChip } from './features/quality/quality.tsx';
import { ChecksRow } from './features/quality/checks.tsx';
import { CloseDialog, WorkspaceChip } from './features/workspace/workspace.tsx';
import { BringDialog } from './features/workspace/bring-dialog.tsx';
import { CommitDialog } from './features/workspace/commit-dialog.tsx';
import { PullDialog } from './features/pull/pull-dialog.tsx';
import { IssuesDialog } from './features/issues/issues-dialog.tsx';
import { HandoffDialog } from './features/handoff/handoff-dialog.tsx';
import { SessionMenu } from './features/handoff/pass-to.tsx';
import { HandedBanner, SessionOriginLink } from './features/handoff/session-lineage.tsx';
import { MapDialog } from './features/map/map-dialog.tsx';
import { Desk, useNeedsYouCount } from './features/desk/desk.tsx';
import { RaceTitle, RaceView } from './features/race/race.tsx';
import { IconSwap } from '@solline/ui/icon-swap';
import { shouldAnimate } from '@solline/ui/motion';
import { ReviewPanel } from './features/review/review-panel.tsx';
import { Timeline } from './features/review/timeline.tsx';
import { Familiar, SessionBot, SessionMark } from './features/agents/bots.tsx';
import { Bot } from '@solline/ui/bot';
import { Sidebar } from './features/sidebar/sidebar.tsx';
import { usePresence } from '@solline/ui/react';
import { actions, connectRecovery, sessionStore, useApp, useSession } from './stores/app.ts';
import { WindowControls } from './features/window/window-controls.tsx';
import {
  connectNavigation,
  navigateTo,
  setStartupView,
  useNavigation,
} from './features/navigation/controller.ts';
import { NavigationSearch } from './features/navigation/search.tsx';
import { NavigationSettings } from './features/navigation/settings.tsx';
import { navigationEntries } from './features/navigation/search-entries.ts';
import { TaskContext } from './features/navigation/task-context.tsx';
import { McpSkippedNote } from './features/mcp/mcp-skipped.tsx';
import { Spaces } from './features/spaces/spaces.tsx';
import { quietSpace, useSpaces } from './stores/spaces.ts';

const THEME_KEY = 'solline.theme';

function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** O tema e se a última troca deve animar (pelo teclado, troca sem morph). */
function useTheme(): [Theme, (animate: boolean) => void, boolean] {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [animates, setAnimates] = useState(true);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    void window.solline.window.setTheme(theme);
  }, [theme]);
  return [
    theme,
    (animate) => {
      setAnimates(animate);
      setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
    },
    animates,
  ];
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
            `${ping.ms} ms · v${ping.reply.engineVersion}`,
            'ping-reply',
          ];
  // O detalhe (latência, versão) só interessa quando algo corre mal: ligado, fica no tooltip.
  const quiet = ping.status !== 'error';
  return (
    <div
      className="flex min-w-0 items-center gap-2 text-[12px] text-muted"
      data-testid={testId}
      title={detail}
    >
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      <span className={quiet && ping.status === 'ok' ? 'sr-only' : 'truncate'}>{label}</span>
      {detail ? (
        <span className={quiet ? 'sr-only' : 'truncate font-mono text-[11px] text-danger'}>
          {detail}
        </span>
      ) : null}
    </div>
  );
}

function SessionHeaderTitle({ sessionId }: { sessionId: string }) {
  const title = useSession(sessionId, (s) => s.info.title);
  const state = useSession(sessionId, (s) => s.info.state);
  const label = {
    starting: 'A preparar',
    idle: 'À tua espera',
    running: 'A trabalhar',
    'needs-you': 'Precisa de ti',
    error: 'Ligação interrompida',
  }[state];
  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* O mesmo nome de transição do capuz dos cartões da mesa: abrir uma sessão transforma um no outro. */}
      <span className="session-bot-target">
        <SessionBot key={sessionId} sessionId={sessionId} size={36} alive />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5 py-1">
        <h1
          className="truncate text-[13px] font-semibold tracking-[-0.01em]"
          data-testid="session-title"
        >
          {title}
        </h1>
        <div className="flex min-w-0 items-center gap-2">
          <span className="session-state-chip shrink-0" data-state={state}>
            <SessionMark sessionId={sessionId} size={12} />
            {label}
          </span>
          <SessionOriginLink sessionId={sessionId} />
        </div>
      </div>
    </div>
  );
}

/** O título da mesa e o resumo de relance: quantas precisam de ti. */
function DeskTitle() {
  const hasDesk = useApp((s) => s.sessionIds.length > 0 || s.orphans.length > 0);
  const waiting = useNeedsYouCount();
  if (!hasDesk) return null;
  return (
    <div className="flex min-w-0 items-baseline gap-2.5">
      <h1 className="text-[15px] font-semibold tracking-[-0.015em]">Mesa</h1>
      {waiting > 0 ? (
        <span className="text-[12px] text-accent-text" data-testid="desk-summary">
          {waiting} {waiting === 1 ? 'precisa de ti' : 'precisam de ti'}
        </span>
      ) : null}
    </div>
  );
}

const Divider = () => <span aria-hidden className="mx-1.5 h-3.5 w-px shrink-0 bg-line" />;

/**
 * O estado da sessão aberta, à direita: onde trabalha | verificações e revisor | rever. Três
 * grupos com um divisor fino entre eles; o que não existe não deixa divisor.
 */
function SessionStatus({ sessionId }: { sessionId: string }) {
  const placed = useSession(
    sessionId,
    (s) => s.info.workspace?.kind === 'worktree' || s.info.workspace?.kind === 'shared',
  );
  return (
    <div className="ml-auto flex shrink-0 items-center">
      {placed ? (
        <>
          <WorkspaceChip sessionId={sessionId} />
          <Divider />
        </>
      ) : null}
      <div className="flex items-center gap-0.5">
        <ChecksRow sessionId={sessionId} />
        <QualityChip sessionId={sessionId} />
      </div>
      <Divider />
      <ReviewButton sessionId={sessionId} />
      <SessionMenu sessionId={sessionId} />
    </div>
  );
}

/** O botão de rever, com o que está por rever à vista. */
function ReviewButton({ sessionId }: { sessionId: string }) {
  const pending = useSession(sessionId, (s) => s.timeline?.pending ?? null);
  const open = useApp((s) => s.reviewOpen);
  const count = pending?.files ?? 0;
  return (
    <button
      type="button"
      onClick={() => actions.toggleReview()}
      aria-pressed={open}
      aria-label={count ? `Rever: ${count} ficheiros por rever` : 'Rever alterações'}
      data-testid="review-toggle"
      className={`no-drag sl-press inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium ${open ? 'bg-surface-hover text-fg' : 'text-muted hover:bg-surface-hover hover:text-fg'}`}
    >
      <FileDiff size={14} strokeWidth={1.75} />
      Rever
      {pending && count > 0 ? (
        <span
          className="font-mono text-[11px] whitespace-nowrap tabular-nums"
          data-testid="review-pending"
        >
          <span className="text-success">+{pending.additions}</span>{' '}
          <span className="text-danger">−{pending.deletions}</span>
        </span>
      ) : null}
    </button>
  );
}

function Welcome() {
  const projects = useApp((s) => s.projects);
  const activeProjectId = useApp((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);
  return (
    <section className="welcome flex flex-1 flex-col items-center justify-center gap-5 px-8 pb-16 text-center">
      {/* O familiar recebe-te: ao portátil no início, à porta de um projeto ainda vazio. */}
      <div className="companion-gathering" aria-hidden>
        <Bot hood="codex" mood="reading" size={82} />
        <Familiar size={152} />
        <Bot hood="claude" mood="waiting" size={90} />
      </div>
      <div>
        <h2 className="text-[2rem] leading-tight font-semibold tracking-[-0.025em]">
          {project ? project.name : 'Um lugar para criar.'}
        </h2>
        <p className="mt-3 max-w-sm text-[14px] leading-relaxed text-muted">
          {project
            ? 'O teu próximo passo começa aqui.'
            : 'Os teus projetos, os teus agentes. Tudo com espaço para pensar.'}
        </p>
      </div>
      {project ? (
        <NewSessionButton project={project} variant="primary" />
      ) : (
        <button
          type="button"
          onClick={() => void actions.addProject()}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-fg px-5 text-[14px] font-medium text-bg sl-press"
        >
          <FolderPlus size={16} /> Adicionar projeto
        </button>
      )}
    </section>
  );
}

/** O aviso entra e sai pelo mesmo caminho; enquanto sai, mostra ainda o último texto. */
function NoticeBar({ notice }: { notice: string | null }) {
  const { mounted, state } = usePresence(notice !== null);
  const [shown, setShown] = useState(notice);
  if (notice !== null && notice !== shown) setShown(notice);
  if (!mounted) return null;
  return (
    <div
      role="status"
      data-state={state}
      className="sl-enter sl-motion mx-auto mt-1 flex w-full max-w-3xl items-center gap-3 px-8"
    >
      <p
        className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2 text-[12.5px] text-muted"
        data-testid="app-notice"
      >
        {notice ?? shown}
      </p>
      <button
        type="button"
        aria-label="Fechar aviso"
        onClick={actions.dismissNotice}
        className="sl-press grid size-7 place-items-center rounded-sm text-subtle hover:bg-surface-hover hover:text-fg"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function App() {
  const navigation = useNavigation();
  const [theme, toggleTheme, themeAnimates] = useTheme();
  const ping = usePing();
  const sessionIds = useApp((s) => s.sessionIds);
  const activeSessionId = useApp((s) => (s.view === 'session' ? s.activeSessionId : null));
  const hasDesk = useApp((s) => s.sessionIds.length > 0 || s.orphans.length > 0);
  const notice = useApp((s) => s.notice);
  const recoveryStatus = useApp((s) => s.recoveryStatus);
  const closePending = useApp((s) => s.closePending);
  const raceId = useApp((s) => (s.view === 'race' ? s.activeRaceId : null));
  const showingSpaces = useApp((s) => s.view === 'spaces');
  const spaceKey = useApp((s) => s.spaceProjectId ?? 'general');

  useEffect(() => {
    let lastInput = Date.now();
    const input = () => {
      lastInput = Date.now();
    };
    window.addEventListener('pointerdown', input, { passive: true });
    window.addEventListener('keydown', input);
    const timer = window.setInterval(() => {
      const state = useSpaces.getState().data;
      if (
        !document.hidden &&
        Date.now() - lastInput >= 60_000 &&
        state.settings.analysisMode === 'proactive' &&
        state.settings.agent &&
        state.settings.projectIds.length &&
        state.analysis.state === 'idle'
      )
        quietSpace('spaces.tick', {});
    }, 60_000);
    const off = connectRecovery();
    const offNavigation = connectNavigation();
    // Clicar num aviso do Windows abre a sessão de que ele fala.
    const offFocus = window.solline.onFocusSession((id) => {
      navigateTo({ view: 'session', sessionId: id });
    });
    void actions.loadProjects().catch(() => {
      useNavigation.setState({
        ready: true,
        error: 'Não foi possível carregar os projetos. As preferências foram preservadas.',
      });
      useApp.setState({
        notice: 'Não foi possível carregar os projetos. Tenta recuperar a interface.',
      });
    });
    void actions.loadAgents();
    // O catálogo MCP chega por mcp.changed; a leitura inicial cobre o arranque.
    void actions.loadMcpCatalog();
    return () => {
      off();
      offNavigation();
      offFocus();
      window.clearInterval(timer);
      window.removeEventListener('pointerdown', input);
      window.removeEventListener('keydown', input);
    };
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
    <>
      <WindowControls />
      <div
        inert={recoveryStatus !== 'ready' || closePending || !navigation.ready}
        className="app-shell grid h-full min-h-0 grid-cols-[15rem_minmax(0,1fr)]"
      >
        <Sidebar
          sessionsByProject={sessionsByProject}
          search={
            <NavigationSearch
              readEntries={navigationEntries}
              onNavigate={navigateTo}
              enabled={navigation.ready && recoveryStatus === 'ready' && !closePending}
            />
          }
          footer={
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <EngineStatus ping={ping} />
              </div>
              <button
                type="button"
                onClick={(e) => toggleTheme(shouldAnimate(e.nativeEvent))}
                aria-label={theme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
                data-testid="theme-toggle"
                className="grid size-7 shrink-0 place-items-center rounded-control text-muted sl-press hover:bg-surface-hover hover:text-fg"
              >
                <IconSwap swapKey={theme} instant={!themeAnimates}>
                  {theme === 'dark' ? (
                    <Sun size={15} strokeWidth={1.75} />
                  ) : (
                    <Moon size={15} strokeWidth={1.75} />
                  )}
                </IconSwap>
              </button>
              <button
                type="button"
                onClick={actions.openAgentsPanel}
                aria-label="Agentes"
                title="Agentes: estado, login e variáveis"
                data-testid="sidebar-agents"
                className="grid size-7 shrink-0 place-items-center rounded-control text-muted sl-press hover:bg-surface-hover hover:text-fg"
              >
                <SlidersHorizontal size={15} strokeWidth={1.75} />
              </button>
              <NavigationSettings
                value={navigation.preferences.startupView}
                writable={navigation.writable}
                onChange={setStartupView}
                error={navigation.error}
                onAgents={actions.openAgentsPanel}
              />
            </div>
          }
        />
        <AgentsPanel />
        <CloseDialog />
        <BringDialog />
        <CommitDialog />
        <PullDialog />
        <IssuesDialog />
        <HandoffDialog />
        <MapDialog />

        <main tabIndex={-1} className="flex min-h-0 min-w-0 flex-col">
          <header className="session-header drag flex min-h-14 shrink-0 items-center gap-3 border-b border-line/60 pr-[12rem] pl-5">
            {activeSessionId ? (
              <SessionHeaderTitle sessionId={activeSessionId} />
            ) : raceId ? (
              <RaceTitle raceId={raceId} />
            ) : showingSpaces ? (
              <span className="text-[12px] text-muted">Espaços</span>
            ) : (
              <DeskTitle />
            )}
            {activeSessionId ? (
              <SessionStatus key={activeSessionId} sessionId={activeSessionId} />
            ) : null}
          </header>

          <NoticeBar notice={notice} />
          {activeSessionId ? <TaskContext sessionId={activeSessionId} /> : null}
          {activeSessionId ? (
            <McpSkippedNote key={`m-${activeSessionId}`} sessionId={activeSessionId} />
          ) : null}
          {activeSessionId ? (
            <HandedBanner key={activeSessionId} sessionId={activeSessionId} />
          ) : null}
          <UncertainOperations />

          {showingSpaces ? (
            <Spaces key={spaceKey} />
          ) : activeSessionId ? (
            <div className="session-body relative flex min-h-0 flex-1">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <Conversation key={activeSessionId} sessionId={activeSessionId} />
                <Composer
                  key={`c-${activeSessionId}`}
                  sessionId={activeSessionId}
                  above={<Timeline sessionId={activeSessionId} />}
                />
              </div>
              <ReviewPanel key={`r-${activeSessionId}`} sessionId={activeSessionId} />
            </div>
          ) : raceId ? (
            <RaceView raceId={raceId} />
          ) : hasDesk ? (
            <Desk />
          ) : (
            <Welcome />
          )}
        </main>
      </div>
      {recoveryStatus !== 'ready' ? (
        <div
          role="status"
          className="fixed inset-x-0 bottom-8 mx-auto w-fit max-w-xl rounded-panel border border-line bg-surface px-5 py-3 text-sm text-fg shadow-lg"
        >
          {recoveryStatus === 'loading' ? (
            'A recuperar o teu trabalho…'
          ) : (
            <>
              {notice}
              <button
                type="button"
                className="mt-3 block rounded-control bg-fg px-3 py-2 text-bg"
                onClick={() => void window.solline.recovery.open()}
              >
                Recuperar interface
              </button>
            </>
          )}
        </div>
      ) : null}
    </>
  );
}
