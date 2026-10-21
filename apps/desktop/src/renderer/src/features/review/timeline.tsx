import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { History, RotateCcw, Undo2 } from 'lucide-react';
import type { Checkpoint, Timeline as TimelineData } from '@solline/protocol';
import { SPRING, project, rubberband, shouldAnimate } from '@solline/ui/motion';
import { useReducedMotion, useSpring } from '@solline/ui/react';
import { actions, useSession } from '../../stores/app.ts';

/**
 * A linha do tempo da sessão: um ponto antes de cada turno e o "agora" no fim. Arrasta-se a
 * pega (ou clica-se num ponto) para escolher para onde voltar; ao largar, a pega assenta
 * numa mola e abre a confirmação. Cancelar devolve-a ao sítio, a partir de onde estiver.
 *
 * Teclado: a pega é um slider. As setas mudam de ponto sem animar; Enter confirma.
 */

const HANDLE = 14;

function stopOf(timeline: TimelineData): number {
  const n = timeline.checkpoints.length;
  if (!timeline.rewoundTo) return n;
  const i = timeline.checkpoints.findIndex((c) => c.turnId === timeline.rewoundTo);
  return i === -1 ? n : i;
}

function changes(c: Checkpoint): number {
  return c.stats.additions + c.stats.deletions;
}

export function Timeline({ sessionId }: { sessionId: string }) {
  const timeline = useSession(sessionId, (s) => s.timeline);
  const state = useSession(sessionId, (s) => s.info.state);
  if (!timeline?.available || timeline.checkpoints.length === 0) return null;
  return <TimelineTrack sessionId={sessionId} timeline={timeline} busy={state !== 'idle'} />;
}

function TimelineTrack({
  sessionId,
  timeline,
  busy,
}: {
  sessionId: string;
  timeline: TimelineData;
  busy: boolean;
}) {
  const reduced = useReducedMotion();
  const checkpoints = timeline.checkpoints;
  const stops = checkpoints.length;
  const home = stopOf(timeline);
  const track = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState(0);
  /** O ponto escolhido e ainda por confirmar (null: nenhum). */
  const [picked, setPicked] = useState<number | null>(null);
  const [working, setWorking] = useState(false);
  const drag = useRef<{ id: number; offset: number; samples: { x: number; t: number }[] } | null>(
    null,
  );

  const xOf = (stop: number) => (stops === 0 ? 0 : (stop / stops) * width);
  const spring = useSpring(0, (x) => {
    if (handle.current) handle.current.style.transform = `translateX(${x - HANDLE / 2}px)`;
  });

  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A pega segue o sítio certo quando a linha muda (turno novo, rebobinar, largura). A
  // primeira vez, e quando não é para animar, salta.
  const position = picked ?? home;
  const placed = useRef(false);
  useEffect(() => {
    const s = spring.current;
    if (drag.current || !s) return;
    const target = stops === 0 ? 0 : (position / stops) * width;
    if (!placed.current || reduced || !shouldAnimate()) s.jump(target);
    else s.to(target);
    placed.current = width > 0;
  }, [position, width, stops, reduced, spring]);

  function nearest(x: number): number {
    if (width === 0) return stops;
    return Math.min(stops, Math.max(0, Math.round((x / width) * stops)));
  }

  function settleAt(stop: number, velocity = 0, animate = true) {
    const s = spring.current;
    if (s) {
      if (animate && !reduced) s.to(xOf(stop), { velocity, params: SPRING.release });
      else s.jump(xOf(stop));
    }
    setPicked(stop === home ? null : stop);
  }

  function onPointerDown(e: React.PointerEvent) {
    if (busy || working || e.button !== 0 || !track.current) return;
    const rect = track.current.getBoundingClientRect();
    const s = spring.current;
    const current = s?.value ?? xOf(position);
    const onHandle = e.target === handle.current;
    // Respeita onde se agarrou a pega; na linha, a pega salta para o dedo.
    const offset = onHandle ? e.clientX - rect.left - current : 0;
    s?.stop();
    drag.current = { id: e.pointerId, offset, samples: [{ x: e.clientX, t: e.timeStamp }] };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (!onHandle) s?.to(e.clientX - rect.left);
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !track.current) return;
    const rect = track.current.getBoundingClientRect();
    const raw = e.clientX - rect.left - d.offset;
    // Para lá das pontas, resiste em vez de parar.
    const x =
      raw < 0
        ? -rubberband(-raw, width)
        : raw > width
          ? width + rubberband(raw - width, width)
          : raw;
    spring.current?.jump(x);
    d.samples.push({ x: e.clientX, t: e.timeStamp });
    if (d.samples.length > 5) d.samples.shift();
  }

  function onPointerUp(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const first = d.samples[0];
    const last = d.samples.at(-1);
    const dt = first && last ? (last.t - first.t) / 1000 : 0;
    const velocity = first && last && dt > 0 ? (last.x - first.x) / dt : 0;
    const current = spring.current?.value ?? 0;
    settleAt(nearest(current + project(velocity, 0.99)), velocity);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (busy || working) return;
    const from = picked ?? home;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = Math.max(0, from - 1);
    else if (e.key === 'ArrowRight') next = Math.min(stops, from + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = stops;
    else if (e.key === 'Escape' && picked !== null) next = home;
    if (next === null) return;
    e.preventDefault();
    settleAt(next, 0, false);
  }

  async function rewind(what: { files: boolean; conversation: boolean }) {
    const target = picked === null ? undefined : checkpoints[picked];
    if (!target) return;
    setWorking(true);
    const ok = await actions.rewind(sessionId, target.turnId, what);
    setWorking(false);
    setPicked(null);
    if (!ok) settleAt(home);
  }

  const label = (stop: number) =>
    stop >= stops ? 'Agora' : `Antes do turno ${checkpoints[stop]?.index ?? stop + 1}`;
  const max = Math.max(1, ...checkpoints.map(changes));
  const target = picked === null ? undefined : checkpoints[picked];

  return (
    <div className="mb-2.5" data-testid="timeline">
      {/* Calma até lá chegares: compacta (no máximo 56 px por turno) e meio apagada. */}
      <div
        className={`flex items-center gap-2.5 transition-opacity duration-200 hover:opacity-100 focus-within:opacity-100 ${
          picked === null && !timeline.rewoundTo ? 'opacity-55' : ''
        }`}
      >
        <History size={14} strokeWidth={1.75} className="shrink-0 text-subtle" aria-hidden />
        <div
          ref={track}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className={`relative h-8 flex-1 touch-none ${busy ? 'opacity-60' : 'cursor-pointer'}`}
          style={{ maxWidth: stops * 56 }}
          title={busy ? 'Espera que o agente acabe para rebobinar' : undefined}
        >
          {/* A linha engrossa nos turnos que mudaram ficheiros: quanto mais, mais forte. */}
          <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line" />
          {checkpoints.map((c, i) => {
            const weight = changes(c) === 0 ? 0 : Math.log1p(changes(c)) / Math.log1p(max);
            const from = xOf(i) + 7;
            const to = xOf(i + 1) - 7;
            return (
              <div key={c.turnId}>
                {weight > 0 && to > from ? (
                  <span
                    aria-hidden
                    className="absolute top-1/2 h-[2px] -translate-y-1/2 rounded-full bg-fg"
                    style={{ left: from, width: to - from, opacity: 0.1 + weight * 0.3 }}
                  />
                ) : null}
                <button
                  type="button"
                  tabIndex={-1}
                  disabled={busy || working}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    if (!busy && !working) settleAt(i, 0, shouldAnimate(e.nativeEvent));
                  }}
                  aria-label={`${label(i)}: ${c.title}`}
                  title={`${label(i)} · ${c.title}${changes(c) ? ` · +${c.stats.additions} −${c.stats.deletions}` : ''}`}
                  data-testid="timeline-stop"
                  className="group absolute top-1/2 grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center"
                  style={{ left: xOf(i) }}
                >
                  <span
                    className={`block size-2 rounded-full transition-[background-color,transform] duration-150 group-hover:scale-125 motion-reduce:group-hover:scale-100 ${
                      c.state === 'running'
                        ? 'dot-pulse bg-accent'
                        : i >= home
                          ? 'bg-line-strong'
                          : 'bg-fg/70'
                    } ${picked === i ? 'ring-[3px] ring-accent/30' : ''}`}
                  />
                </button>
              </div>
            );
          })}
          <span
            aria-hidden
            className="absolute top-1/2 right-0 size-1.5 translate-x-1/2 -translate-y-1/2 rounded-full bg-line-strong"
          />
          <button
            ref={handle}
            type="button"
            role="slider"
            aria-label="Linha do tempo da sessão"
            aria-valuemin={0}
            aria-valuemax={stops}
            aria-valuenow={position}
            aria-valuetext={label(position)}
            disabled={busy || working}
            onKeyDown={onKeyDown}
            data-testid="timeline-handle"
            className={`absolute top-1/2 left-0 -mt-[7px] size-[14px] rounded-full border-2 border-surface shadow-raised transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)] active:cursor-grabbing ${
              picked === null ? 'bg-fg/80' : 'bg-accent'
            }`}
            style={{ cursor: busy ? 'default' : 'grab' }}
          />
        </div>
        <span className="shrink-0 truncate text-[11.5px] text-muted tabular-nums">
          {label(position)}
        </span>
      </div>

      {timeline.rewoundTo && picked === null ? (
        <div className="sl-enter sl-motion mt-1.5 flex items-center gap-2 pl-[26px] text-[12px] text-muted">
          <span>Os ficheiros estão como {label(home).toLowerCase()}.</span>
          {timeline.undo ? (
            <button
              type="button"
              onClick={() => void actions.undo(sessionId)}
              className="sl-press inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-fg hover:bg-surface-hover"
              data-testid="timeline-present"
            >
              <Undo2 size={13} /> Voltar ao presente
            </button>
          ) : null}
        </div>
      ) : null}

      {target ? (
        <div
          role="dialog"
          aria-label={`Voltar a antes do turno ${target.index}`}
          className="sl-enter sl-motion mt-2 rounded-lg border border-line bg-surface p-3 shadow-raised"
          data-testid="rewind-confirm"
        >
          <div className="flex items-baseline gap-2">
            <h3 className="text-[13px] font-semibold">Voltar a antes do turno {target.index}</h3>
            <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{target.title}</span>
          </div>
          <p className="mt-1 text-[12px] text-muted">
            {timeline.conversationRewind === 'agent'
              ? 'A conversa volta a esse ponto. Os ficheiros voltam a como estavam, e dá para desfazer.'
              : 'Este agente não sabe voltar atrás na conversa: abre-se uma sessão nova que leva um resumo do que ficou. Os ficheiros voltam a como estavam, e dá para desfazer.'}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={working}
              onClick={() => void rewind({ files: true, conversation: true })}
              className="sl-press inline-flex h-8 items-center gap-1.5 rounded-md bg-fg px-3 text-[12.5px] font-medium text-bg disabled:opacity-60"
              data-testid="rewind-both"
            >
              <RotateCcw size={13} /> Ficheiros e conversa
            </button>
            <button
              type="button"
              disabled={working}
              onClick={() => void rewind({ files: true, conversation: false })}
              className="sl-press inline-flex h-8 items-center rounded-md border border-line px-3 text-[12.5px] font-medium hover:bg-surface-hover disabled:opacity-60"
              data-testid="rewind-files"
            >
              Só ficheiros
            </button>
            <button
              type="button"
              disabled={working}
              onClick={() => void rewind({ files: false, conversation: true })}
              className="sl-press inline-flex h-8 items-center rounded-md border border-line px-3 text-[12.5px] font-medium hover:bg-surface-hover disabled:opacity-60"
              data-testid="rewind-conversation"
            >
              Só conversa
            </button>
            <button
              type="button"
              disabled={working}
              onClick={(e) => settleAt(home, 0, shouldAnimate(e.nativeEvent))}
              className="sl-press ml-auto inline-flex h-8 items-center rounded-md px-3 text-[12.5px] text-muted hover:bg-surface-hover hover:text-fg"
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
