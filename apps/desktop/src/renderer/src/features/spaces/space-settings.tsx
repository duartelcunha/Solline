import { useState } from 'react';
import { Search, SlidersHorizontal } from 'lucide-react';
import { useApp } from '../../stores/app.ts';
import { quietSpace, spaceRequest, useSpaces } from '../../stores/spaces.ts';
import type { SpaceSettings } from '@solline/protocol';
import { SpaceChoice } from './space-choice.tsx';

export function SpaceSettingsPanel() {
  const settings = useSpaces((s) => s.data.settings);
  const analysis = useSpaces((s) => s.data.analysis);
  const agents = useApp((s) => s.agents);
  const projects = useApp((s) => s.projects);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SpaceSettings>(settings);
  const run = async () => {
    setBusy(true);
    try {
      await spaceRequest('spaces.analyze', {});
    } catch {
      /* Shown by the space. */
    } finally {
      setBusy(false);
    }
  };
  const available = agents.filter((a) => a.id === 'claude' && a.status === 'ready');
  return (
    <section className="space-analysis" aria-label="Análise dos projetos">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">Um olhar sobre os teus projetos</p>
          <p className="mt-1 text-[12px] text-muted">
            {analysis.state === 'running'
              ? 'A analisar o contexto novo…'
              : analysis.state === 'paused'
                ? analysis.error
                : settings.projectIds.length
                  ? `${settings.projectIds.length} projetos · ${settings.analysisMode === 'manual' ? 'a pedido' : 'proativo'} · só sugestões`
                  : 'Escolhe os projetos e o agente para começar.'}
          </p>
        </div>
        <button
          type="button"
          className="space-control"
          aria-label="Definições de análise e aprendizagem"
          aria-expanded={open}
          onClick={() => {
            if (!open) setDraft(settings);
            setOpen(!open);
          }}
        >
          <SlidersHorizontal size={15} />
        </button>
        <button
          type="button"
          className="space-control"
          disabled={
            busy || analysis.state === 'running' || !settings.agent || !settings.projectIds.length
          }
          onClick={() => void run()}
        >
          <Search size={14} />
          Analisar
        </button>
      </div>
      {open ? (
        <form
          className="space-analysis-settings"
          onSubmit={(e) => {
            e.preventDefault();
            quietSpace('spaces.configure', draft);
          }}
        >
          <fieldset>
            <legend className="space-label">Análise</legend>
            <div className="space-tabs">
              <button
                type="button"
                aria-pressed={draft.analysisMode === 'manual'}
                onClick={() => setDraft({ ...draft, analysisMode: 'manual' })}
              >
                A pedido
              </button>
              <button
                type="button"
                aria-pressed={draft.analysisMode === 'proactive'}
                onClick={() => setDraft({ ...draft, analysisMode: 'proactive' })}
              >
                Proativo
              </button>
            </div>
            <p className="mt-2 text-[11px] text-muted">
              O modo proativo usa a app aberta e ociosa, no máximo uma vez por dia, quando há
              contexto novo.
            </p>
          </fieldset>
          <fieldset>
            <legend className="space-label">Aprendizagem</legend>
            <div className="space-tabs">
              <button
                type="button"
                aria-pressed={draft.learningMode === 'approval'}
                onClick={() => setDraft({ ...draft, learningMode: 'approval' })}
              >
                Aprovar memórias
              </button>
            </div>
          </fieldset>
          <div>
            <label className="space-label" htmlFor="analysis-agent">
              Agente de análise
            </label>
            <SpaceChoice
              id="analysis-agent"
              label="Agente de análise"
              value={draft.agent ?? ''}
              placeholder="Escolher agente…"
              options={available.map((a) => ({ value: a.id, label: a.label }))}
              onChange={(value) => setDraft({ ...draft, agent: value })}
            />
            <p className="mt-2 text-[11px] text-muted">
              Disponível para agentes com um perfil verificado sem ferramentas de alteração.
            </p>
          </div>
          <details>
            <summary>Modelo</summary>
            <input
              aria-label="Modelo de análise"
              placeholder="Predefinição do agente"
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            />
          </details>
          <fieldset>
            <legend className="space-label">Projetos autorizados</legend>
            {projects.map((p) => (
              <label key={p.id} className="space-check">
                <input
                  type="checkbox"
                  disabled={!p.trusted}
                  checked={draft.projectIds.includes(p.id)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      projectIds: e.target.checked
                        ? [...draft.projectIds, p.id]
                        : draft.projectIds.filter((id) => id !== p.id),
                    })
                  }
                />
                <span>
                  {p.name}
                  {!p.trusted ? ' · requer confiança' : ''}
                </span>
              </label>
            ))}
          </fieldset>
          <button type="submit" className="space-control space-primary">
            Guardar preferências
          </button>
        </form>
      ) : null}
    </section>
  );
}
