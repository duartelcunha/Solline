import { useRef, useState } from 'react';
import { CheckCheck, Clock, GripVertical, Pencil, Play, X } from 'lucide-react';
import type { Block } from '@solline/protocol';
import { IconSwap } from '@solline/ui/icon-swap';
import { actions, useSession } from '../../stores/app.ts';

type SteerBlock = Extract<Block, { kind: 'steer' }>;

/**
 * Uma mensagem que guiou o agente a meio do turno: fica onde a mandaste, do teu lado, "à
 * espera" até o agente a ler na próxima pausa e "lida" depois (o ícone transforma-se).
 */
export function SteerView({ block }: { block: SteerBlock }) {
  const read = block.status === 'absorbed';
  return (
    <div className="flex justify-end" data-testid="steer" data-status={block.status}>
      <div className="max-w-[85%] rounded-2xl bg-surface-sunken px-3.5 py-2 text-[13.5px] leading-snug select-text">
        <p className="whitespace-pre-wrap">{block.text}</p>
        <span className="mt-1 flex items-center justify-end gap-1 text-[11px] text-subtle">
          <IconSwap swapKey={block.status}>
            {read ? <CheckCheck size={12} className="text-success" /> : <Clock size={12} />}
          </IconSwap>
          {read ? 'lida pelo agente' : 'à espera da próxima pausa'}
        </span>
      </div>
    </div>
  );
}

/**
 * O que escreveste enquanto o agente trabalhava, por baixo do turno que corre: esbatido, com
 * "na fila". Arrasta-se pela pega para mudar a ordem; o lápis devolve à caixa de texto.
 */
export function QueueList({ sessionId }: { sessionId: string }) {
  const queue = useSession(sessionId, (s) => s.queue);
  const list = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<{ id: string; dy: number; start: number } | null>(null);
  if (!queue || queue.items.length === 0) return null;
  const items = queue.items;

  /** Onde o item arrastado cai: conta quantos centros de outros itens já passou. */
  const targetIndex = (id: string, dy: number) => {
    const rows = Array.from(list.current?.children ?? []) as HTMLElement[];
    const from = items.findIndex((i) => i.id === id);
    const self = rows[from];
    if (!self) return from;
    const center = self.offsetTop + self.offsetHeight / 2 + dy;
    let to = 0;
    rows.forEach((row, i) => {
      if (i !== from && row.offsetTop + row.offsetHeight / 2 < center) to++;
    });
    return to;
  };

  return (
    <div className="space-y-1.5" data-testid="queue">
      <div className="flex items-center justify-end gap-2 text-[11px] text-subtle">
        {queue.paused ? (
          <>
            <span>Fila em pausa</span>
            <button
              type="button"
              onClick={() => void actions.resumeQueue(sessionId)}
              className="sl-press inline-flex items-center gap-1 rounded-control px-1.5 py-0.5 text-fg hover:bg-surface-hover"
              data-testid="queue-resume"
            >
              <Play size={11} /> Continuar
            </button>
          </>
        ) : (
          <span>
            {items.length === 1 ? 'Segue quando o turno acabar' : `${items.length} na fila`}
          </span>
        )}
      </div>
      <ol ref={list} className="space-y-1.5">
        {items.map((item, index) => {
          const dragging = drag?.id === item.id;
          return (
            <li
              key={item.id}
              data-testid="queued"
              className={`sl-enter flex justify-end ${dragging ? 'relative z-10' : 'transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]'}`}
              style={dragging ? { transform: `translateY(${drag.dy}px)` } : undefined}
            >
              <div
                className={`group flex max-w-[85%] items-start gap-1.5 rounded-2xl border border-dashed border-line px-2 py-1.5 text-[13.5px] leading-snug text-muted ${dragging ? 'bg-surface shadow-raised' : ''}`}
              >
                <button
                  type="button"
                  aria-label="Arrastar para mudar a ordem"
                  className="mt-0.5 cursor-grab touch-none text-subtle opacity-0 group-hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing"
                  onPointerDown={(e) => {
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                    setDrag({ id: item.id, dy: 0, start: e.clientY });
                  }}
                  onPointerMove={(e) => {
                    if (drag?.id === item.id) setDrag({ ...drag, dy: e.clientY - drag.start });
                  }}
                  onPointerUp={() => {
                    if (drag?.id !== item.id) return;
                    const to = targetIndex(item.id, drag.dy);
                    setDrag(null);
                    if (to === index) return;
                    const ids = items.map((i) => i.id).filter((id) => id !== item.id);
                    ids.splice(to, 0, item.id);
                    void actions.reorderQueue(sessionId, ids);
                  }}
                >
                  <GripVertical size={13} />
                </button>
                <p className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap">{item.text}</p>
                <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
                  <button
                    type="button"
                    onClick={() => void actions.editQueued(sessionId, item.id)}
                    aria-label="Editar"
                    className="grid size-5 place-items-center rounded-control text-subtle hover:text-fg"
                    data-testid="queued-edit"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void actions.unqueue(sessionId, item.id)}
                    aria-label="Tirar da fila"
                    className="grid size-5 place-items-center rounded-control text-subtle hover:text-fg"
                    data-testid="queued-remove"
                  >
                    <X size={12} />
                  </button>
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
