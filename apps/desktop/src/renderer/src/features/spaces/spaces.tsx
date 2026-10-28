import { useState } from 'react';
import {
  ArrowUpRight,
  Check,
  CheckCheck,
  Circle,
  CircleDot,
  Globe2,
  Lightbulb,
  Plus,
  X,
} from 'lucide-react';
import type { SpaceTask } from '@solline/protocol';
import { actions, useApp, useSession } from '../../stores/app.ts';
import { quietSpace, spaceRequest, useSpaces, type SpacePanel } from '../../stores/spaces.ts';
import { TaskDetails } from './task-details.tsx';
import { SpaceSettingsPanel } from './space-settings.tsx';
import { SpaceMemories } from './space-memories.tsx';
import { RulesEditor } from '../rules/rules-editor.tsx';
import { McpCatalog } from '../mcp/mcp-catalog.tsx';
import { ProjectMcp } from '../mcp/mcp-project.tsx';
import { pendingFor } from '../memory/memory-model.ts';
import './spaces.css';
import { sourceLabel } from './source-label.ts';

export const control = 'space-control';
const STATUS = {
  todo: 'Por fazer',
  active: 'Em curso',
  review: 'Para rever',
  done: 'Concluídas',
} as const;
const SYMBOL = { todo: Circle, active: CircleDot, review: CheckCheck, done: Check };

export function Spaces() {
  const projectId = useApp((s) => s.spaceProjectId);
  const projects = useApp((s) => s.projects);
  const project = projects.find((p) => p.id === projectId);
  const data = useSpaces((s) => s.data);
  const error = useSpaces((s) => s.error);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const selected = useSpaces((s) => s.selectedTaskId);
  const setSelected = (selectedTaskId: string | null) => useSpaces.setState({ selectedTaskId });
  const storedPanel = useSpaces((s) => s.panel);
  // As regras são de um projeto: em Geral não há o separador, e a escolha antiga volta às tarefas.
  const panel: SpacePanel = storedPanel === 'rules' && projectId === null ? 'tasks' : storedPanel;
  const setPanel = (panel: SpacePanel) => useSpaces.setState({ panel });
  const pending = useSpaces((s) => pendingFor(s.data.memories, projectId).length);
  const tasks = data.tasks.filter((t) => t.projectId === projectId);
  const task = tasks.find((t) => t.id === selected);
  const insights = data.insights.filter(
    (i) => i.state === 'suggested' && (projectId === null || i.projectId === projectId),
  );
  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      const created = await spaceRequest('spaces.taskCreate', {
        projectId,
        title,
        description: '',
      });
      setTitle('');
      setSelected(created.id);
    } catch {
      /* The error remains next to the form and the title is retained. */
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="spaces-view" data-testid="spaces-view">
      <div className="spaces-intro">
        <div className="flex min-w-0 items-center gap-3">
          {projectId === null ? <Globe2 size={22} className="text-subtle" aria-hidden /> : null}
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">
              {project?.name ?? 'Geral'}
            </h1>
            <p className="mt-1 text-[13px] text-muted">
              {projectId === null
                ? 'Ideias, próximos passos e o que liga os teus projetos.'
                : 'Do próximo passo ao trabalho revisto.'}
            </p>
          </div>
        </div>
        <div className="space-tabs" aria-label="Conteúdo do espaço">
          <button type="button" aria-pressed={panel === 'tasks'} onClick={() => setPanel('tasks')}>
            Tarefas
          </button>
          <button
            type="button"
            aria-pressed={panel === 'memory'}
            onClick={() => setPanel('memory')}
            data-testid="space-tab-memory"
          >
            Memória
            {pending > 0 ? (
              <span
                className="ml-1.5 tabular-nums text-attention"
                data-testid="space-tab-memory-count"
                aria-label={`${pending} ${pending === 1 ? 'proposta' : 'propostas'} por aprovar`}
              >
                {pending}
              </span>
            ) : null}
          </button>
          {projectId !== null ? (
            <button
              type="button"
              aria-pressed={panel === 'rules'}
              onClick={() => setPanel('rules')}
              data-testid="space-tab-rules"
            >
              Regras
            </button>
          ) : null}
          <button
            type="button"
            aria-pressed={panel === 'tools'}
            onClick={() => setPanel('tools')}
            data-testid="space-tab-tools"
          >
            MCP
          </button>
        </div>
      </div>
      {error ? (
        <div role="alert" className="space-error">
          {error}
        </div>
      ) : null}
      {panel === 'memory' ? (
        <SpaceMemories projectId={projectId} />
      ) : panel === 'rules' && projectId !== null ? (
        <RulesEditor key={projectId} projectId={projectId} />
      ) : panel === 'tools' ? (
        projectId === null ? (
          <McpCatalog />
        ) : (
          <ProjectMcp projectId={projectId} />
        )
      ) : (
        <>
          {projectId === null ? <SpaceSettingsPanel /> : null}
          <div className={`space-work ${task ? 'has-selection' : ''}`}>
            <section className="space-list" aria-label="Tarefas">
              <form onSubmit={(e) => void add(e)} className="space-capture">
                <Plus size={17} className="text-subtle shrink-0" aria-hidden />
                <input
                  aria-label="Nova tarefa"
                  data-testid="task-title-input"
                  value={title}
                  maxLength={300}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="O que queres fazer?"
                  disabled={saving}
                />
                <button
                  type="submit"
                  aria-label="Criar tarefa"
                  disabled={!title.trim() || saving}
                  className={control}
                >
                  <ArrowUpRight size={16} />
                </button>
              </form>
              {tasks.length === 0 ? (
                <div className="space-empty">
                  <Circle size={30} strokeWidth={1} aria-hidden />
                  <p>A próxima tarefa começa com uma linha.</p>
                  <span>Guarda a ideia. Delega quando estiver pronta.</span>
                </div>
              ) : null}
              {(Object.keys(STATUS) as SpaceTask['status'][]).map((status) => {
                const group = tasks.filter((t) => t.status === status);
                if (!group.length) return null;
                const Icon = SYMBOL[status];
                return (
                  <section key={status} className="space-group" aria-label={STATUS[status]}>
                    <h2>
                      <Icon size={13} aria-hidden />
                      {STATUS[status]}
                      <span>{group.length}</span>
                    </h2>
                    <ul>
                      {group.map((t) => (
                        <li key={t.id}>
                          <button
                            type="button"
                            className="space-task-row"
                            aria-current={selected === t.id ? 'true' : undefined}
                            onClick={() => setSelected(t.id)}
                            data-testid="task-row"
                          >
                            <Icon size={16} aria-hidden className="shrink-0 text-subtle" />
                            <span className="min-w-0 flex-1 truncate">{t.title}</span>
                            <TaskSignal task={t} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
              {insights.length ? (
                <section className="space-group space-insights" aria-label="Sugestões">
                  <h2>
                    <Lightbulb size={14} aria-hidden />
                    Sugestões
                  </h2>
                  {insights.map((insight) => (
                    <article key={insight.id} className="space-insight">
                      <h3>{insight.title}</h3>
                      <p>{insight.detail}</p>
                      <details>
                        <summary>Fontes</summary>
                        <ul>
                          {insight.sources.map((source) => (
                            <li key={source}>
                              {source.startsWith('task:') &&
                              data.tasks.some((t) => t.id === source.slice(5)) ? (
                                <button
                                  type="button"
                                  className="underline underline-offset-2"
                                  onClick={() => {
                                    const original = data.tasks.find(
                                      (t) => t.id === source.slice(5),
                                    );
                                    if (original) {
                                      setSelected(original.id);
                                      actions.openSpace(original.projectId);
                                    }
                                  }}
                                >
                                  {data.tasks.find((t) => t.id === source.slice(5))?.title}
                                </button>
                              ) : (
                                sourceLabel(source, data.tasks, projects)
                              )}
                              {insight.evidence?.find((e) => e.id === source) ? (
                                <details>
                                  <summary>Excerto analisado</summary>
                                  <pre className="max-h-52 overflow-auto whitespace-pre-wrap text-[11px]">
                                    {insight.evidence.find((e) => e.id === source)?.text}
                                  </pre>
                                </details>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </details>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className={control}
                          onClick={() =>
                            quietSpace('spaces.insightDecision', {
                              id: insight.id,
                              decision: 'accept',
                            })
                          }
                        >
                          Criar tarefa
                        </button>
                        <button
                          type="button"
                          className={control}
                          onClick={() =>
                            quietSpace('spaces.insightDecision', {
                              id: insight.id,
                              decision: 'dismiss',
                            })
                          }
                        >
                          Dispensar
                        </button>
                      </div>
                    </article>
                  ))}
                </section>
              ) : null}
            </section>
            {task ? (
              <aside className="space-detail" aria-label="Detalhes da tarefa">
                <button
                  type="button"
                  className={`${control} space-detail-close`}
                  aria-label="Fechar detalhes"
                  onClick={() => setSelected(null)}
                >
                  <X size={15} />
                </button>
                <TaskDetails key={task.id} task={task} />
              </aside>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function TaskSignal({ task }: { task: SpaceTask }) {
  const attempt = task.attempts.at(-1);
  const state = useSession(attempt?.sessionId ?? null, (s) => s.info.state);
  if (!attempt || !['active', 'review'].includes(task.status)) return null;
  if (attempt.error)
    return (
      <span className="space-task-signal text-danger" title={attempt.error}>
        !<span className="sr-only">Precisa de atenção</span>
      </span>
    );
  if (state === 'needs-you')
    return (
      <span className="space-task-signal" title="Precisa de ti">
        ?<span className="sr-only">Precisa de ti</span>
      </span>
    );
  return attempt.state === 'queued' ? (
    <span className="text-[11px] text-muted">Na fila</span>
  ) : null;
}
