import type { Project, SpaceTask } from '@solline/protocol';

export function sourceLabel(
  id: string,
  tasks: SpaceTask[],
  projects: Project[],
  sessionTitle?: (id: string) => string | undefined,
): string {
  if (id.startsWith('task:'))
    return tasks.find((t) => t.id === id.slice(5))?.title ?? 'Tarefa guardada';
  if (id.startsWith('chat:')) return sessionTitle?.(id.split(':')[1] ?? '') ?? 'Conversa guardada';
  const separator = id.indexOf(':');
  if (separator > 0)
    return `${projects.find((p) => p.id === id.slice(0, separator))?.name ?? 'Projeto'} · ${id.slice(separator + 1)}`;
  return 'Contexto guardado';
}
