import { useState } from 'react';
import { ArrowUpRight, Check, FileDiff, MessageSquare, Send } from 'lucide-react';
import type { SpaceTask } from '@solline/protocol';
import { actions, sessionStore, useApp } from '../../stores/app.ts';
import { quietSpace, spaceRequest, useSpaces } from '../../stores/spaces.ts';
import { SpaceChoice } from './space-choice.tsx';
import { blockedReason } from '../agents/new-session-button.tsx';

export function TaskDetails({ task }: { task: SpaceTask }) {
  const agents = useApp((s) => s.agents);
  const project = useApp((s) => s.projects.find((p) => p.id === task.projectId));
  const sessionIds = useApp((s) => s.sessionIds);
  const allMemories = useSpaces((s) => s.data.memories);
  const memories = allMemories.filter(
    (m) => m.state === 'active' && (m.projectId === null || m.projectId === task.projectId),
  );
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [delegating, setDelegating] = useState(false);
  const [target, setTarget] = useState<'new' | 'existing'>('new');
  const [agent, setAgent] = useState('');
  const [model, setModel] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [text, setText] = useState([task.title, task.description].filter(Boolean).join('\n\n'));
  const [memoryIds, setMemoryIds] = useState(() => memories.map((m) => m.id));
  const [busy, setBusy] = useState(false);
  const running = task.attempts.some((a) => ['prepared', 'queued', 'running'].includes(a.state));
  const choices = agents.map((a) => {
    const reason = blockedReason(
      a,
      project ?? { id: '__general__', name: 'Geral', path: '', addedAt: 0, trusted: false },
    );
    return {
      value: a.id,
      label: a.label,
      disabled: reason !== null,
      ...(reason ? { detail: reason } : {}),
    };
  });
  const sessions = sessionIds.flatMap((id) => {
    const info = sessionStore(id)?.getState().info;
    return info?.projectId === (task.projectId ?? '__general__') ? [info] : [];
  });
  async function delegate() {
    if (busy) return;
    setBusy(true);
    try {
      await spaceRequest('spaces.delegate', {
        id: task.id,
        requestId: crypto.randomUUID(),
        target:
          target === 'new'
            ? { kind: 'new', agent, ...(model.trim() ? { model: model.trim() } : {}) }
            : { kind: 'existing', sessionId },
        text: text.trim(),
        memoryIds: memoryIds.filter((id) => memories.some((m) => m.id === id)),
      });
      setDelegating(false);
    } catch {
      /* Preserve the edited prompt for an explicit new attempt. */
    } finally {
      await actions.refreshTaskSessions().catch(() => undefined);
      setBusy(false);
    }
  }
  return (
    <div className="space-task-detail">
      <label className="sr-only" htmlFor="task-detail-title">
        Título da tarefa
      </label>
      <input
        id="task-detail-title"
        className="space-detail-title"
        value={title}
        maxLength={300}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          if (title.trim() && title !== task.title)
            quietSpace('spaces.taskUpdate', { id: task.id, title });
        }}
      />
      <label className="space-label" htmlFor="task-description">
        Contexto
      </label>
      <textarea
        id="task-description"
        value={description}
        maxLength={20_000}
        placeholder="O resultado que procuras, referências ou uma ideia para começar…"
        onChange={(e) => setDescription(e.target.value)}
        onBlur={() => {
          if (description !== task.description)
            quietSpace('spaces.taskUpdate', { id: task.id, description });
        }}
        rows={4}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="space-control space-primary"
          disabled={running || busy || task.status === 'done'}
          onClick={() => {
            setText([title, description].filter(Boolean).join('\n\n'));
            setDelegating((v) => !v);
          }}
        >
          <Send size={14} />
          Delegar
        </button>
        {!running ? (
          <button
            type="button"
            className="space-control"
            onClick={() =>
              quietSpace('spaces.taskUpdate', {
                id: task.id,
                status: task.status === 'done' ? 'todo' : 'done',
              })
            }
          >
            <Check size={14} />
            {task.status === 'done' ? 'Reabrir' : 'Concluir'}
          </button>
        ) : null}
      </div>
      {delegating ? (
        <section className="space-delegation" aria-label="Delegar tarefa">
          <div className="space-tabs" aria-label="Destino">
            <button type="button" aria-pressed={target === 'new'} onClick={() => setTarget('new')}>
              Nova conversa
            </button>
            <button
              type="button"
              aria-pressed={target === 'existing'}
              onClick={() => setTarget('existing')}
            >
              Conversa existente
            </button>
          </div>
          {target === 'new' ? (
            <>
              <label className="space-label" htmlFor="task-agent">
                Agente
              </label>
              <SpaceChoice
                id="task-agent"
                label="Agente"
                value={agent}
                placeholder="Escolher agente…"
                options={choices}
                onChange={(value) => {
                  setAgent(value);
                  setModel('');
                }}
              />
              <details>
                <summary>Modelo</summary>
                <label className="sr-only" htmlFor="task-model">
                  Modelo
                </label>
                <input
                  id="task-model"
                  placeholder="Predefinição do agente"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              </details>
            </>
          ) : (
            <>
              <label className="space-label" htmlFor="task-session">
                Conversa
              </label>
              <SpaceChoice
                id="task-session"
                label="Conversa"
                value={sessionId}
                placeholder="Escolher conversa…"
                options={sessions.map((s) => ({ value: s.id, label: s.title }))}
                onChange={setSessionId}
              />
              {sessions.length === 0 ? (
                <p className="text-[12px] text-muted">Ainda não há conversas neste espaço.</p>
              ) : null}
            </>
          )}
          <label className="space-label" htmlFor="task-prompt">
            O que o agente recebe
          </label>
          <textarea
            id="task-prompt"
            rows={6}
            maxLength={20_000}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {memories.length ? (
            <fieldset>
              <legend className="space-label">Memórias incluídas</legend>
              {memories.map((m) => (
                <label className="space-check" key={m.id}>
                  <input
                    type="checkbox"
                    checked={memoryIds.includes(m.id)}
                    onChange={(e) =>
                      setMemoryIds((ids) =>
                        e.target.checked ? [...ids, m.id] : ids.filter((id) => id !== m.id),
                      )
                    }
                  />
                  <span>{m.text}</span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <button
            type="button"
            className="space-control space-primary"
            disabled={busy || !text.trim() || (target === 'new' ? !agent : !sessionId)}
            onClick={() => void delegate()}
          >
            <ArrowUpRight size={14} />
            {busy ? 'A delegar…' : 'Enviar tarefa'}
          </button>
        </section>
      ) : null}
      {task.attempts.length ? (
        <section className="space-attempts">
          <h2 className="space-label">Atividade</h2>
          {[...task.attempts].reverse().map((a) => (
            <article key={a.id}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-muted">
                  {
                    {
                      prepared: 'A preparar',
                      queued: 'Na fila',
                      running: 'Em curso',
                      review: 'Para rever',
                      failed: 'Interrompida',
                      unknown: 'Confirmar resultado',
                    }[a.state]
                  }
                </span>
                {a.sessionId && sessionIds.includes(a.sessionId) ? (
                  <button
                    type="button"
                    className="space-control"
                    onClick={() => a.sessionId && actions.selectSession(a.sessionId)}
                  >
                    <MessageSquare size={14} />
                    Abrir conversa
                  </button>
                ) : null}
              </div>
              {a.error ? <p className="mt-2 text-[12px] text-danger">{a.error}</p> : null}
              {a.result ? (
                <div className="mt-3">
                  <h3 className="space-label">Resultado</h3>
                  <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-muted">
                    {a.result.slice(0, 2000)}
                  </p>
                  {a.result.length > 2000 ? (
                    <details>
                      <summary>Resultado completo</summary>
                      <p className="whitespace-pre-wrap text-[12px] text-muted">{a.result}</p>
                    </details>
                  ) : null}
                </div>
              ) : null}
              {a.changes ? (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <span className="font-mono text-[11px] text-muted">
                    {a.changes.files} {a.changes.files === 1 ? 'ficheiro' : 'ficheiros'} · +
                    {a.changes.additions} −{a.changes.deletions}
                  </span>
                  {a.sessionId && sessionIds.includes(a.sessionId) ? (
                    <button
                      type="button"
                      className="space-control"
                      onClick={() => {
                        if (a.sessionId) {
                          actions.editReview(a.sessionId, {
                            scope: { kind: 'turn', turnId: a.turnId },
                          });
                          actions.selectSession(a.sessionId);
                          actions.toggleReview(true);
                        }
                      }}
                    >
                      <FileDiff size={14} />
                      Ver alterações
                    </button>
                  ) : null}
                </div>
              ) : null}
              {a.conversation?.length ? (
                <details>
                  <summary>Conversa guardada</summary>
                  {a.conversation.map((turn, index) => (
                    <div key={index} className="my-3">
                      <h3 className="space-label">{turn.role === 'user' ? 'Tu' : 'Agente'}</h3>
                      <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-muted">
                        {turn.text}
                      </p>
                    </div>
                  ))}
                </details>
              ) : null}
              <details>
                <summary>Pedido enviado</summary>
                <p className="whitespace-pre-wrap text-[12px] text-muted">{a.text}</p>
              </details>
            </article>
          ))}
        </section>
      ) : null}
    </div>
  );
}
