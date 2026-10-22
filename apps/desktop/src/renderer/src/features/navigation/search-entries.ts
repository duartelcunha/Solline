import type { NavigationEntry } from './search-model.ts';
import { sessionStore, useApp } from '../../stores/app.ts';
import { useSpaces } from '../../stores/spaces.ts';

const taskStatus = {
  todo: 'Por fazer',
  active: 'Em curso',
  review: 'Para rever',
  done: 'Concluída',
};
/** Called when opening the palette: streaming tokens never rebuild the search index. */
export function navigationEntries(): NavigationEntry[] {
  const { projects, sessionIds, races } = useApp.getState();
  const projectName = (id: string | null) =>
    id === null ? 'Geral' : (projects.find((p) => p.id === id)?.name ?? 'Projeto indisponível');
  return [
    {
      id: 'general',
      title: 'Geral',
      detail: 'Tarefas e ideias',
      kind: 'destination',
      target: { view: 'spaces', projectId: null },
    },
    {
      id: 'desk',
      title: 'Mesa',
      detail: 'Trabalho dos agentes',
      kind: 'destination',
      target: { view: 'desk' },
    },
    ...projects.map((p) => ({
      id: `project:${p.id}`,
      title: p.name,
      detail: 'Projeto · Tarefas e memória',
      kind: 'project' as const,
      target: { view: 'spaces' as const, projectId: p.id },
    })),
    ...useSpaces.getState().data.tasks.map((t) => ({
      id: `task:${t.id}`,
      title: t.title,
      detail: `Tarefa · ${projectName(t.projectId)} · ${taskStatus[t.status]}`,
      kind: 'task' as const,
      target: { view: 'spaces' as const, projectId: t.projectId, taskId: t.id },
    })),
    ...sessionIds.flatMap((id) => {
      const s = sessionStore(id)?.getState();
      return s
        ? [
            {
              id: `session:${id}`,
              title: s.info.title,
              detail: `Conversa · ${projectName(s.projectId)}`,
              kind: 'session' as const,
              target: { view: 'session' as const, sessionId: id },
            },
          ]
        : [];
    }),
    ...Object.values(races)
      .filter((r) => r.phase !== 'closed')
      .map((r) => ({
        id: `race:${r.id}`,
        title: r.text.slice(0, 120),
        detail: `Corrida · ${projectName(r.projectId)}`,
        kind: 'race' as const,
        target: { view: 'race' as const, raceId: r.id },
      })),
  ];
}
