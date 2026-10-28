import { useState } from 'react';
import { ArrowRight, Wrench } from 'lucide-react';
import { MCP_PROJECT_MAX } from '@solline/protocol';
import { actions } from '../../stores/app.ts';
import { useMcpCatalog } from '../../stores/mcp-catalog.ts';
import { useSpaces } from '../../stores/spaces.ts';
import { StatusChip } from './mcp-catalog.tsx';
import { atLimit, projectSelection, sourceInfo, statusInfo, toggleSelection } from './mcp-model.ts';

/** Abre o catálogo global, que vive no espaço Geral. */
export function openCatalog(): void {
  actions.openSpace(null);
  useSpaces.setState({ panel: 'tools' });
}

/**
 * Os servidores MCP que entram em cada sessão nova deste projeto, até 8. O que ainda não está
 * pronto também se escolhe: a sessão abre sem ele e diz porquê.
 */
export function ProjectMcp({ projectId }: { projectId: string }) {
  const servers = useMcpCatalog((s) => s.data.servers);
  const projects = useMcpCatalog((s) => s.data.projects);
  const loaded = useMcpCatalog((s) => s.loaded);
  const [busy, setBusy] = useState(false);
  const selection = projectSelection(projects, projectId, servers);
  const full = atLimit(selection);

  async function toggle(id: string) {
    if (busy) return;
    setBusy(true);
    // Parte sempre do que o motor tem agora, para duas escolhas seguidas não se pisarem.
    const now = useMcpCatalog.getState().data;
    const current = projectSelection(now.projects, projectId, now.servers);
    await actions.setProjectMcp(projectId, toggleSelection(current, id));
    setBusy(false);
  }

  return (
    <section className="max-w-[800px]" aria-label="Servidores MCP do projeto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">Servidores MCP deste projeto</h2>
          <p className="mt-1 text-[12px] text-muted">
            Entram em cada sessão nova do projeto, em todos os agentes que os aceitam.
          </p>
        </div>
        <button
          type="button"
          className="space-control sl-press"
          onClick={openCatalog}
          data-testid="mcp-open-catalog"
        >
          Gerir o catálogo
          <ArrowRight size={13} />
        </button>
      </div>

      {servers.length === 0 && loaded ? (
        <div className="space-empty" data-testid="mcp-project-empty">
          <Wrench size={30} strokeWidth={1} aria-hidden />
          <p>Ainda não há servidores no catálogo.</p>
          <span>Acrescenta o primeiro em Geral, no separador MCP.</span>
        </div>
      ) : (
        <>
          <ul className="mt-5" data-testid="mcp-project-list">
            {servers.map((server) => {
              const on = selection.includes(server.id);
              const info = statusInfo(server);
              const blocked = !on && full;
              const id = `mcp-pick-${server.id}`;
              return (
                <li
                  key={server.id}
                  className="flex items-start gap-3 border-t border-line py-4 first:border-t-0"
                  data-testid="mcp-project-row"
                  data-chosen={on}
                >
                  <input
                    id={id}
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0"
                    checked={on}
                    disabled={busy || blocked}
                    onChange={() => void toggle(server.id)}
                  />
                  <label htmlFor={id} className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">
                      {server.spec.label}
                    </span>
                    <span className="mt-0.5 block truncate text-[11.5px] text-muted">
                      {sourceInfo(server.spec.source).title}
                    </span>
                    {on && info.tone !== 'ok' ? (
                      <span className="mt-1 block text-[11.5px] text-attention">
                        Ainda não entra nas sessões: {info.label.toLowerCase()}.
                      </span>
                    ) : null}
                    {blocked ? (
                      <span className="mt-1 block text-[11.5px] text-subtle">
                        Já escolheste {MCP_PROJECT_MAX}: tira um para pôr este.
                      </span>
                    ) : null}
                  </label>
                  <StatusChip server={server} />
                </li>
              );
            })}
          </ul>
          <p
            className="mt-3 text-[11.5px] text-subtle tabular-nums"
            data-testid="mcp-project-count"
          >
            {selection.length} de {MCP_PROJECT_MAX}
          </p>
        </>
      )}
    </section>
  );
}
