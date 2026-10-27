import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { SessionState } from '@solline/protocol';
import { useDragScroll } from '@solline/ui/scroll';
import { actions, sessionStore, useApp } from '../../stores/app.ts';
import { SessionBot } from '../agents/bots.tsx';
import {
  NODE_H,
  NODE_W,
  defaultMapProject,
  edgePath,
  handoffPreview,
  layoutLineage,
  projectsWithLinks,
  type MapEdge,
  type MapNode,
  type MapSession,
} from './map-model.ts';

const STATE_LABEL: Record<SessionState, string> = {
  starting: 'a arrancar',
  idle: 'parada',
  running: 'a trabalhar',
  'needs-you': 'precisa de ti',
  error: 'caiu',
};

/** As sessões abertas, para o Mapa; volta a ler só quando algo que o desenho usa muda. */
function useMapSessions(ids: readonly string[]): MapSession[] {
  const snapshot = (): string =>
    JSON.stringify(
      ids.map((id) => {
        const s = sessionStore(id)?.getState();
        return s
          ? [
              id,
              s.info.title,
              s.info.agent,
              s.info.state,
              s.info.projectId,
              s.info.origin ?? null,
              s.info.raceId ?? null,
            ]
          : [id];
      }),
    );
  const subscribe = useCallback(
    (onChange: () => void) => {
      const stops = ids.map((id) => sessionStore(id)?.subscribe(onChange));
      return () => stops.forEach((stop) => stop?.());
    },
    [ids],
  );
  const key = useSyncExternalStore(subscribe, snapshot);
  return useMemo(
    () =>
      (JSON.parse(key) as unknown[][]).flatMap(
        ([id, title, agent, state, projectId, origin, raceId]) =>
          typeof id === 'string' && typeof title === 'string'
            ? [
                {
                  id,
                  title,
                  agent: String(agent),
                  state: state as SessionState,
                  projectId: String(projectId),
                  ...(origin ? { origin: origin as NonNullable<MapSession['origin']> } : {}),
                  ...(raceId ? { raceId: String(raceId) } : {}),
                } satisfies MapSession,
              ]
            : [],
      ),
    [key],
  );
}

/** Um ponto de estado: o contorno e o rótulo dizem o mesmo que a cor. */
function StateDot({ state }: { state: SessionState }) {
  const tone =
    state === 'needs-you'
      ? 'bg-attention'
      : state === 'error'
        ? 'bg-danger'
        : state === 'running' || state === 'starting'
          ? 'bg-fg'
          : 'border border-line-strong bg-transparent';
  return (
    <span
      aria-hidden
      data-testid="map-state"
      data-state={state}
      className={`block size-2 shrink-0 rounded-full ${tone}`}
    />
  );
}

export function MapDialog() {
  const open = useApp((s) => s.mapOpen);
  if (!open) return null;
  return <MapBody />;
}

function MapBody() {
  const projects = useApp((s) => s.projects);
  const sessionIds = useApp((s) => s.sessionIds);
  const activeProjectId = useApp((s) => s.activeProjectId);
  const all = useMapSessions(sessionIds);

  const linked = useMemo(() => projectsWithLinks(projects, all), [projects, all]);
  const [chosen, setChosen] = useState<string | null>(null);
  const projectId =
    chosen ??
    defaultMapProject(
      activeProjectId,
      linked,
      projects.map((p) => p.id),
    );
  const project = projects.find((p) => p.id === projectId);
  // A lista vem da mais recente para a mais antiga; o Mapa lê-se da esquerda para a direita, pela
  // ordem em que as sessões nasceram.
  const sessions = useMemo(
    () => all.filter((s) => s.projectId === projectId).reverse(),
    [all, projectId],
  );
  const layout = useMemo(() => layoutLineage(sessions), [sessions]);

  // A entrada (aparece a escalonar) só acontece ao abrir; o que muda depois não anima.
  const [intro, setIntro] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setIntro(false), 500);
    return () => clearTimeout(timer);
  }, []);

  const area = useRef<HTMLDivElement>(null);
  useDragScroll(area);
  const choices = projects.filter((p) => linked.includes(p.id));

  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : actions.closeMap())}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Content
          data-testid="map-dialog"
          className="dialog-content sl-motion fixed top-1/2 left-1/2 z-50 flex h-[min(46rem,88vh)] w-[min(72rem,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-raised outline-none"
        >
          <header className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[14px] font-semibold tracking-[-0.01em]">
                Mapa
              </Dialog.Title>
              <Dialog.Description className="truncate text-[12px] text-muted">
                {project ? `${project.name}: ` : ''}quem passou o testemunho e quem se bifurcou de
                quem.
              </Dialog.Description>
            </div>
            {choices.length > 1 ? (
              <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Projeto">
                {choices.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setChosen(p.id)}
                    aria-pressed={p.id === projectId}
                    data-testid="map-project"
                    className={`sl-press h-7 rounded-control px-2.5 text-[12px] ${p.id === projectId ? 'bg-surface-hover font-medium text-fg' : 'text-muted hover:bg-surface-hover hover:text-fg'}`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            ) : null}
            <Dialog.Close
              aria-label="Fechar o mapa"
              data-testid="map-close"
              className="sl-press grid size-7 shrink-0 place-items-center rounded-md text-subtle hover:bg-surface-hover hover:text-fg"
            >
              <X size={14} />
            </Dialog.Close>
          </header>

          {layout.empty ? (
            <div
              className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 text-center"
              data-testid="map-empty"
            >
              <p className="text-[13px] font-medium">Ainda não há sessões ligadas entre si.</p>
              <p className="max-w-sm text-[12px] text-muted">
                Passa o testemunho a outro agente ou bifurca uma sessão e o mapa desenha-se aqui.
              </p>
            </div>
          ) : (
            <div
              ref={area}
              className="scroll-fade-y min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-bg"
              data-testid="map-canvas"
            >
              <div
                className="relative mx-auto"
                style={{ width: layout.width, height: layout.height }}
              >
                {layout.clusters.map((cluster) => (
                  <div
                    key={`${cluster.kind}:${cluster.id}`}
                    data-testid="map-cluster"
                    data-kind={cluster.kind}
                    className="absolute rounded-xl border border-dashed border-line-strong"
                    style={{ left: cluster.x, top: cluster.y, width: cluster.w, height: cluster.h }}
                  >
                    <span className="absolute top-1 left-2.5 text-[10.5px] font-medium tracking-[0.04em] text-subtle uppercase">
                      {cluster.label}
                    </span>
                  </div>
                ))}
                <svg
                  aria-hidden
                  width={layout.width}
                  height={layout.height}
                  className="pointer-events-none absolute inset-0"
                >
                  {layout.edges.map((edge) => (
                    <path
                      key={`${edge.from}>${edge.to}`}
                      d={edgePath(edge.points)}
                      fill="none"
                      stroke="var(--sl-border-strong)"
                      strokeWidth={1.5}
                      strokeLinejoin="round"
                      strokeDasharray={edge.kind === 'fork' ? '5 4' : undefined}
                      className={intro ? 'map-fade' : undefined}
                    />
                  ))}
                  {layout.nodes.flatMap((node) =>
                    node.stub ? (
                      <line
                        key={`stub-${node.id}`}
                        x1={node.x + NODE_W / 2}
                        y1={node.y}
                        x2={node.x + NODE_W / 2}
                        y2={node.y - 24}
                        stroke="var(--sl-border-strong)"
                        strokeWidth={1.5}
                        strokeDasharray="2 4"
                        strokeLinecap="round"
                        data-testid="map-stub"
                      />
                    ) : (
                      []
                    ),
                  )}
                </svg>
                {layout.edges.map((edge) => (
                  <EdgeLabel key={`l-${edge.from}>${edge.to}`} edge={edge} />
                ))}
                {layout.nodes.map((node, index) => (
                  <Node key={node.id} node={node} index={index} intro={intro} />
                ))}
              </div>
            </div>
          )}
          {layout.loose > 0 && !layout.empty ? (
            <p className="text-[11.5px] text-subtle" data-testid="map-loose">
              {layout.loose === 1
                ? 'Mais 1 sessão sem ligações não aparece aqui.'
                : `Mais ${layout.loose} sessões sem ligações não aparecem aqui.`}
            </p>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Node({ node, index, intro }: { node: MapNode; index: number; intro: boolean }) {
  const active = useApp((s) => s.view === 'session' && s.activeSessionId === node.id);
  return (
    <button
      type="button"
      onClick={() => {
        actions.closeMap();
        actions.selectSession(node.id);
      }}
      aria-label={`${node.title}, ${STATE_LABEL[node.state]}${node.stub ? ', sem origem aberta' : ''}`}
      aria-current={active ? 'true' : undefined}
      data-testid="map-node"
      data-session={node.id}
      data-state={node.state}
      data-depth={node.depth}
      className={`sl-press absolute flex items-center gap-2 rounded-lg border bg-surface px-2.5 text-left outline-none hover:border-line-strong focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)] ${
        node.state === 'needs-you' ? 'border-accent' : active ? 'border-line-strong' : 'border-line'
      } ${intro ? 'map-in' : ''}`}
      style={
        {
          left: node.x,
          top: node.y,
          width: NODE_W,
          height: NODE_H,
          '--i': index,
        } as React.CSSProperties
      }
    >
      <span className="grid size-8 shrink-0 place-items-center" aria-hidden>
        <SessionBot sessionId={node.id} size={30} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{node.title}</span>
      <StateDot state={node.state} />
    </button>
  );
}

/**
 * O rótulo de uma ligação ("passagem", "bifurcação"): clicar abre a sessão que nasceu dela. Numa
 * passagem, passar o rato (ou focar) mostra as primeiras linhas do que foi passado.
 */
function EdgeLabel({ edge }: { edge: MapEdge }) {
  const preview = useMemo(
    () =>
      edge.kind === 'handoff'
        ? handoffPreview(sessionStore(edge.to)?.getState().turns ?? [])
        : null,
    [edge.kind, edge.to],
  );
  return (
    <span
      className="group absolute z-10 -translate-x-1/2 -translate-y-1/2"
      style={{ left: edge.labelAt.x, top: edge.labelAt.y }}
    >
      <button
        type="button"
        onClick={() => {
          actions.closeMap();
          actions.selectSession(edge.to);
        }}
        data-testid="map-edge"
        data-kind={edge.kind}
        aria-label={`${edge.label}: abrir a sessão que nasceu daqui`}
        className="sl-press rounded-full border border-line bg-surface px-2 text-[10.5px] leading-[18px] whitespace-nowrap text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)]"
      >
        {edge.label}
      </button>
      {preview ? (
        <span
          role="tooltip"
          data-testid="map-edge-preview"
          className="pointer-events-none absolute top-full left-1/2 z-20 mt-1.5 hidden w-60 -translate-x-1/2 rounded-lg border border-line bg-surface px-2.5 py-2 text-left text-[11.5px] leading-snug whitespace-pre-line text-muted shadow-raised group-focus-within:block group-hover:block"
        >
          {preview}
        </span>
      ) : null}
    </span>
  );
}
