import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDown, RotateCcw, WifiOff } from 'lucide-react';
import {
  isAutoScrolling,
  scrollIntoViewSmooth,
  scrollToSmooth,
  useDragScroll,
} from '@solline/ui/scroll';
import type { Block, PermissionAnswer, ToolBlock, Turn } from '@solline/protocol';
import { Markdown } from '../../components/markdown.tsx';
import { actions, useSession } from '../../stores/app.ts';
import { AgentLabelContext, useSessionAgentLabel } from '../agents/agent-label.tsx';
import { MorphScope } from '../../lib/morph.ts';
import { PermissionCard, PlanCard, QuestionCard } from './asks.tsx';
import { NoticeView, Spinner, ThinkingView, TodoView, ToolGroup } from './blocks.tsx';
import { ToolDetail } from './tool-detail.tsx';

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

/** As ferramentas seguidas ficam juntas num grupo; o resto passa como está. */
function groupTools(blocks: Block[]): (Exclude<Block, ToolBlock> | ToolBlock[])[] {
  const out: (Exclude<Block, ToolBlock> | ToolBlock[])[] = [];
  for (const block of blocks) {
    if (block.kind !== 'tool') {
      out.push(block);
      continue;
    }
    const last = out.at(-1);
    if (Array.isArray(last)) last.push(block);
    else out.push([block]);
  }
  return out;
}

function AssistantTurn({
  turn,
  firstPendingId,
  latest,
  onOpen,
  onAnswer,
}: {
  turn: Turn;
  firstPendingId: string | null;
  /** O último turno: só os pedidos dele se transformam (lib/morph.ts). */
  latest: boolean;
  onOpen: (tool: ToolBlock) => void;
  onAnswer: (requestId: string, answer: PermissionAnswer) => void;
}) {
  // shortcut: os passos de subagentes (parentToolId) aparecem na mesma lista, sem
  // sub-conversa dobrável; isso é do M2.
  // Ferramentas que já aparecem como cartão ou lista de tarefas não se repetem.
  // Um texto ainda vazio não parte um grupo de ferramentas.
  const blocks = groupTools(
    turn.blocks.filter((b) => !(b.kind === 'tool' && b.hidden) && !(b.kind === 'text' && !b.text)),
  );
  return (
    <MorphScope.Provider value={latest}>
      <div className="space-y-4" data-testid="assistant-turn">
        {blocks.map((block) => {
          if (Array.isArray(block))
            return <ToolGroup key={block[0]?.id} blocks={block} onOpen={onOpen} />;
          switch (block.kind) {
            case 'text':
              return block.text ? (
                <div
                  key={block.id}
                  data-testid="assistant-text"
                  className="text-[14.5px] leading-[1.6] select-text"
                >
                  <Markdown text={block.text} />
                </div>
              ) : null;
            case 'thinking':
              return <ThinkingView key={block.id} block={block} />;
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
                <QuestionCard
                  key={block.id}
                  block={block}
                  onAnswer={(a) => onAnswer(block.id, a)}
                />
              );
            case 'todo':
              return <TodoView key={block.id} block={block} />;
            case 'notice':
              return <NoticeView key={block.id} block={block} />;
          }
        })}
      </div>
    </MorphScope.Provider>
  );
}

function EmptySession({ cwd }: { cwd: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <h2 className="text-[1.6rem] leading-tight font-semibold tracking-[-0.025em]">
        Em que trabalhamos?
      </h2>
      <p className="mt-1.5 max-w-md truncate text-[13px] text-muted" title={cwd}>
        {cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd}
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
  const placed = useRef(false);
  // Subiste para ler: o que chegar depois não te puxa, só acende "Novo".
  const [away, setAway] = useState<string | null>(null);
  useDragScroll(scroller);

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

  // Segue o fundo com uma mola enquanto o Duarte não subir para ler; ao abrir, salta lá.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !pinned.current) return;
    if (!placed.current) {
      el.scrollTop = el.scrollHeight;
      placed.current = true;
    } else {
      scrollToSmooth(el, el.scrollHeight);
    }
  }, [turns]);

  // Um pedido que precisa de ti vem sempre à vista, mesmo que tenhas subido.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !firstPendingId) return;
    const card = el.querySelector(`[data-ask="${CSS.escape(firstPendingId)}"]`);
    if (card) scrollIntoViewSmooth(el, card, 'nearest', 32);
  }, [firstPendingId]);

  const signature = `${turns.length}:${turns.at(-1)?.blocks.length ?? 0}`;
  const hasNew = away !== null && away !== signature;

  const openTool = openToolId ? (tools.get(openToolId) ?? null) : null;
  // A linha do tempo marca o <html> com o turno de onde se voltaria: esse e os seguintes
  // ficam esbatidos, para se ver o que se perde antes de confirmar.
  const rewindFrom = useRewindFrom();
  const lostFrom = rewindFrom ? turns.findIndex((t) => t.id === rewindFrom) : -1;
  const working = state === 'running' && turns.at(-1)?.role === 'user';

  return (
    <AgentLabelContext.Provider value={agentLabel}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            // A mola é a app a seguir; só um gesto teu solta ou cola ao fundo.
            if (isAutoScrolling(el)) return;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            pinned.current = atBottom;
            if (atBottom && away !== null) setAway(null);
            else if (!atBottom && away === null) setAway(signature);
          }}
          className="scroll-fade min-h-0 flex-1 overflow-y-auto"
          data-testid="conversation"
        >
          {turns.length === 0 ? (
            <EmptySession cwd={cwd} />
          ) : (
            <div className="mx-auto w-full max-w-3xl space-y-8 px-8 pt-4 pb-10">
              {turns.map((turn, index) => (
                <div
                  key={turn.id}
                  data-turn-id={turn.id}
                  className="transition-opacity duration-200"
                  style={lostFrom >= 0 && index >= lostFrom ? { opacity: 0.4 } : undefined}
                >
                  {turn.role === 'user' ? (
                    <UserTurn turn={turn} />
                  ) : (
                    <AssistantTurn
                      turn={turn}
                      firstPendingId={firstPendingId}
                      latest={index === turns.length - 1}
                      onOpen={(tool) => setOpenToolId(tool.id)}
                      onAnswer={(requestId, answer) =>
                        void actions.answer(sessionId, requestId, answer)
                      }
                    />
                  )}
                </div>
              ))}
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

        {hasNew ? (
          <button
            type="button"
            onClick={() => {
              const el = scroller.current;
              if (!el) return;
              pinned.current = true;
              setAway(null);
              scrollToSmooth(el, el.scrollHeight);
            }}
            className="chip-in absolute bottom-3 left-1/2 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12px] text-muted shadow-raised sl-press hover:text-fg"
            data-testid="jump-new"
          >
            <ArrowDown size={13} /> Novo
          </button>
        ) : null}

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
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-fg px-3 text-[13px] font-medium text-bg sl-press"
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

/** O turno de onde a linha do tempo voltaria (data-rewind-from no <html>), ou null. */
function useRewindFrom(): string | null {
  return useSyncExternalStore(
    (onChange) => {
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, { attributeFilter: ['data-rewind-from'] });
      return () => observer.disconnect();
    },
    () => document.documentElement.dataset.rewindFrom ?? null,
  );
}
