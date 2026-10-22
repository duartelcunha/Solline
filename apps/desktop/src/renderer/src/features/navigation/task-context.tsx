import { ArrowLeft } from 'lucide-react';
import { useSpaces } from '../../stores/spaces.ts';
import { navigateTo } from './controller.ts';

export function TaskContext({ sessionId }: { sessionId: string }) {
  const task = useSpaces((s) =>
    s.data.tasks.find((t) => t.attempts.some((a) => a.sessionId === sessionId)),
  );
  if (!task) return null;
  return (
    <div className="shrink-0 border-b border-line/50 px-5 py-2">
      <button
        type="button"
        data-testid="back-to-task"
        onClick={() => navigateTo({ view: 'spaces', projectId: task.projectId, taskId: task.id })}
        className="flex max-w-full items-center gap-2 rounded-control px-2 py-1 text-left text-[12px] text-muted hover:bg-surface-hover hover:text-fg"
        aria-label={`Voltar à tarefa: ${task.title}`}
      >
        <ArrowLeft size={13} aria-hidden />
        <span className="shrink-0">Tarefa</span>
        <span className="truncate font-medium">{task.title}</span>
      </button>
    </div>
  );
}
