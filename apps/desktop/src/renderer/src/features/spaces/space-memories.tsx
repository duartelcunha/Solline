import { useState } from 'react';
import { Brain, Check, Pencil, Plus, Trash2 } from 'lucide-react';
import type { SpaceMemory } from '@solline/protocol';
import { quietSpace, spaceRequest, useSpaces } from '../../stores/spaces.ts';
import { actions, sessionStore, useApp } from '../../stores/app.ts';
import { sourceLabel } from './source-label.ts';

export function SpaceMemories({ projectId }: { projectId: string | null }) {
  const tasks = useSpaces((s) => s.data.tasks);
  const projects = useApp((s) => s.projects);
  const memories = useSpaces((s) => s.data.memories).filter((m) => m.projectId === projectId);
  const [editing, setEditing] = useState<SpaceMemory | 'new' | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const open = (m: SpaceMemory | 'new') => {
    setEditing(m);
    setText(m === 'new' ? '' : m.text);
  };
  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await spaceRequest('spaces.memorySave', {
        ...(editing && editing !== 'new' ? { id: editing.id } : {}),
        projectId,
        text,
        source:
          editing && editing !== 'new' ? editing.source : 'Duarte · memória escrita no espaço',
        sourceId: editing && editing !== 'new' ? editing.sourceId : null,
        state: 'active',
      });
      setEditing(null);
    } catch {
      /* Retain the text on a failed save. */
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-memory-view" aria-label="Memória do espaço">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium">O que vale a pena lembrar</h2>
          <p className="mt-1 text-[12px] text-muted">
            Preferências e lições com origem visível. Podes mudar de ideias.
          </p>
        </div>
        <button type="button" className="space-control" onClick={() => open('new')}>
          <Plus size={14} />
          Memória
        </button>
      </div>
      {editing ? (
        <div className="space-memory-editor">
          <label className="space-label" htmlFor="memory-text">
            Memória
          </label>
          <textarea
            id="memory-text"
            value={text}
            maxLength={20_000}
            onChange={(e) => setText(e.target.value)}
            rows={4}
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="space-control space-primary"
              onClick={() => void save()}
              disabled={busy || !text.trim()}
            >
              Guardar
            </button>
            <button type="button" className="space-control" onClick={() => setEditing(null)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : null}
      {!memories.length && !editing ? (
        <div className="space-empty">
          <Brain size={30} strokeWidth={1} aria-hidden />
          <p>Um espaço para o que aprendemos.</p>
          <span>As memórias aprovadas acompanham as próximas tarefas.</span>
        </div>
      ) : null}
      <ul className="space-memories">
        {memories.map((m) => (
          <li key={m.id}>
            <div className="flex items-start gap-3">
              <Brain size={16} className="mt-1 shrink-0 text-subtle" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap text-[13px]">{m.text}</p>
                <p className="mt-2 text-[11px] text-muted">
                  {m.sourceId?.startsWith('task:') &&
                  tasks.some((t) => t.id === m.sourceId?.slice(5)) ? (
                    <button
                      type="button"
                      className="underline underline-offset-2"
                      aria-label={`Abrir origem: ${sourceLabel(m.sourceId, tasks, projects)}`}
                      onClick={() => {
                        const task = tasks.find((t) => t.id === m.sourceId?.slice(5));
                        if (task) {
                          useSpaces.setState({ selectedTaskId: task.id });
                          actions.openSpace(task.projectId);
                        }
                      }}
                    >
                      {sourceLabel(m.sourceId, tasks, projects)}
                    </button>
                  ) : m.sourceId ? (
                    sourceLabel(
                      m.sourceId,
                      tasks,
                      projects,
                      (id) => sessionStore(id)?.getState().info.title,
                    )
                  ) : (
                    m.source
                  )}{' '}
                  ·{' '}
                  {m.state === 'pending'
                    ? 'Por aprovar'
                    : m.state === 'disabled'
                      ? 'Desativada'
                      : 'Ativa'}
                </p>
              </div>
              <button
                type="button"
                className="space-control"
                aria-label="Editar memória"
                onClick={() => open(m)}
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                className="space-control"
                aria-label="Apagar memória"
                onClick={() => quietSpace('spaces.memoryDelete', { id: m.id })}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="space-control"
                onClick={() =>
                  quietSpace('spaces.memorySave', {
                    id: m.id,
                    projectId: m.projectId,
                    text: m.text,
                    source: m.source,
                    sourceId: m.sourceId,
                    state: m.state === 'active' ? 'disabled' : 'active',
                  })
                }
              >
                <Check size={13} />
                {m.state === 'pending' ? 'Aprovar' : m.state === 'active' ? 'Desativar' : 'Ativar'}
              </button>
              {projectId !== null ? (
                <button
                  type="button"
                  className="space-control"
                  onClick={() =>
                    quietSpace('spaces.memorySave', {
                      id: m.id,
                      projectId: null,
                      text: m.text,
                      source: m.source,
                      sourceId: m.sourceId,
                      state: m.state,
                    })
                  }
                >
                  Mover para Geral
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
