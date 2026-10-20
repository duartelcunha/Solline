import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, WifiOff } from 'lucide-react';
import type { PermissionAnswer, ToolBlock, Turn } from '@solline/protocol';
import { Markdown } from '../../components/markdown.tsx';
import { actions, useSession } from '../../stores/app.ts';
import { AgentLabelContext, useSessionAgentLabel } from '../agents/agent-label.tsx';
import { PermissionCard, PlanCard, QuestionCard } from './asks.tsx';
import { NoticeView, Spinner, ThinkingView, ToolRow } from './blocks.tsx';
import { ToolDetail } from './tool-detail.tsx';

/** Ferramentas que já aparecem como cartão próprio. */
const SHOWN_AS_CARD = new Set(['AskUserQuestion', 'ExitPlanMode']);

function UserTurn({ turn }: { turn: Turn }) {
  const text = turn.blocks.find((b) => b.kind === 'text');
  return (
    <div className="flex justify-end" data-testid="user-turn">
      <div className="max-w-[80%] rounded-lg rounded-br-sm bg-surface-hover px-3.5 py-2 text-[14px] whitespace-pre-wrap select-text">
        {text?.kind === 'text' ? text.text : ''}
      </div>
    </div>
  );
}

function AssistantTurn({
  turn,
  firstPendingId,
  onOpen,
  onAnswer,
}: {
  turn: Turn;
  firstPendingId: string | null;
  onOpen: (tool: ToolBlock) => void;
  onAnswer: (requestId: string, answer: PermissionAnswer) => void;
}) {
  // shortcut: os passos de subagentes (parentToolId) aparecem na mesma lista, sem
  // sub-conversa dobrável; isso é do M2.
  const blocks = turn.blocks.filter((b) => !(b.kind === 'tool' && SHOWN_AS_CARD.has(b.name)));
  return (
    <div className="space-y-3" data-testid="assistant-turn">
      {blocks.map((block) => {
        switch (block.kind) {
          case 'text':
            return block.text ? (
              <div key={block.id} data-testid="assistant-text" className="text-[14px] select-text">
                <Markdown text={block.text} />
              </div>
            ) : null;
          case 'thinking':
            return <ThinkingView key={block.id} block={block} />;
          case 'tool':
            return <ToolRow key={block.id} block={block} onOpen={() => onOpen(block)} />;
          case 'permission':
            return (
              <PermissionCard
                key={block.id}
                block={block}
                active={block.id === firstPendingId}
                onAnswer={(a) => onAnswer(block.id, a)}
              />
            );
          case 'plan':
            return (
              <PlanCard key={block.id} block={block} onAnswer={(a) => onAnswer(block.id, a)} />
            );
          case 'question':
            return (
              <QuestionCard key={block.id} block={block} onAnswer={(a) => onAnswer(block.id, a)} />
            );
          case 'notice':
            return <NoticeView key={block.id} block={block} />;
        }
      })}
    </div>
  );
}

function EmptySession({ cwd }: { cwd: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <h2 className="text-[1.6rem] leading-tight font-semibold tracking-[-0.025em]">
        Em que trabalhamos?
      </h2>
      <p className="mt-1.5 max-w-md truncate font-mono text-[12px] text-subtle" title={cwd}>
        {cwd}
      </p>
    </div>
  );
}

export function Conversation({ sessionId }: { sessionId: string }) {
  const turns = useSession(sessionId, (s) => s.turns);
  const state = useSession(sessionId, (s) => s.info.state);
  const cwd = useSession(sessionId, (s) => s.info.cwd);
  const error = useSession(sessionId, (s) => s.error);
  const canResume = useSession(sessionId, (s) => s.capabilities?.features.resume !== false);
  const agentLabel = useSessionAgentLabel(sessionId);
  const [openToolId, setOpenToolId] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const { tools, firstPendingId } = useMemo(() => {
    const tools = new Map<string, ToolBlock>();
    let firstPendingId: string | null = null;
    for (const turn of turns) {
      for (const block of turn.blocks) {
        if (block.kind === 'tool') tools.set(block.id, block);
        if (!firstPendingId && 'status' in block && block.status === 'pending')
          firstPendingId = block.id;
      }
    }
    return { tools, firstPendingId };
  }, [turns]);

  // Fica colado ao fundo enquanto o Duarte não subir para ler.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const openTool = openToolId ? (tools.get(openToolId) ?? null) : null;
  const working = state === 'running' && turns.at(-1)?.role === 'user';

  return (
    <AgentLabelContext.Provider value={agentLabel}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
          className="scroll-fade min-h-0 flex-1 overflow-y-auto"
          data-testid="conversation"
        >
          {turns.length === 0 ? (
            <EmptySession cwd={cwd} />
          ) : (
            <div className="mx-auto w-full max-w-3xl space-y-6 px-8 pt-4 pb-10">
              {turns.map((turn) =>
                turn.role === 'user' ? (
                  <UserTurn key={turn.id} turn={turn} />
                ) : (
                  <AssistantTurn
                    key={turn.id}
                    turn={turn}
                    firstPendingId={firstPendingId}
                    onOpen={(tool) => setOpenToolId(tool.id)}
                    onAnswer={(requestId, answer) =>
                      void actions.answer(sessionId, requestId, answer)
                    }
                  />
                ),
              )}
              {working ? (
                <div
                  className="flex items-center gap-2 text-[12.5px] text-muted"
                  data-testid="working"
                >
                  <Spinner label={`O ${agentLabel} está a trabalhar`} /> A pensar…
                </div>
              ) : null}
            </div>
          )}
        </div>

        {error ? (
          <div className="mx-auto w-full max-w-3xl px-8 pb-2">
            <div
              role="alert"
              data-testid="session-error"
              className="appear flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 shadow-raised"
            >
              <WifiOff size={16} className="shrink-0 text-muted" />
              <p className="min-w-0 flex-1 text-[13px] text-muted">{error}</p>
              {canResume ? (
                <button
                  type="button"
                  onClick={() => void actions.resume(sessionId)}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-fg px-3 text-[13px] font-medium text-bg transition-transform duration-150 active:scale-[0.97]"
                >
                  <RotateCcw size={14} /> Retomar
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <ToolDetail tool={openTool} onClose={() => setOpenToolId(null)} />
      </div>
    </AgentLabelContext.Provider>
  );
}
