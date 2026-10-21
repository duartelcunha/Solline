import { useEffect, type RefObject } from 'react';
import { SPRING, Spring, prefersReducedMotion, project, rubberband } from './motion.ts';

/**
 * Deslocar sem barras: a app segue sozinha o que acontece com uma mola suave, e qualquer zona
 * vazia se arrasta com o rato, com inércia ao largar e resistência nas pontas. Um gesto teu
 * (roda, arrasto) para logo a mola: nada te puxa enquanto mexes.
 */

type Axis = 'x' | 'y';

interface Motion {
  spring: Spring;
  moving: boolean;
  /** A mola continua um gesto teu (inércia de um arremesso): não é a app a seguir. */
  user: boolean;
}

const motions = new WeakMap<HTMLElement, Partial<Record<Axis, Motion>>>();
const watched = new WeakSet<HTMLElement>();

function position(el: HTMLElement, axis: Axis): number {
  return axis === 'y' ? el.scrollTop : el.scrollLeft;
}

function maxOf(el: HTMLElement, axis: Axis): number {
  return axis === 'y' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
}

function set(el: HTMLElement, axis: Axis, value: number): void {
  if (axis === 'y') el.scrollTop = value;
  else el.scrollLeft = value;
}

function stopAll(el: HTMLElement): void {
  const m = motions.get(el);
  for (const axis of ['x', 'y'] as const) {
    const motion = m?.[axis];
    if (motion?.moving) {
      motion.spring.stop();
      motion.moving = false;
    }
  }
}

/** A roda ou um toque teu param a mola: o gesto ganha sempre. */
function watch(el: HTMLElement): void {
  if (watched.has(el)) return;
  watched.add(el);
  const stop = () => stopAll(el);
  el.addEventListener('wheel', stop, { passive: true });
  el.addEventListener('touchstart', stop, { passive: true });
  // Selecionar texto (ou qualquer clique) também para a mola: nada te puxa enquanto mexes.
  el.addEventListener('pointerdown', stop, { passive: true });
  el.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) stop();
  });
}

/** A mola desta área está a deslocar (o scroll que provoca não é do Duarte). */
export function isAutoScrolling(el: HTMLElement): boolean {
  const m = motions.get(el);
  return Boolean((m?.x?.moving && !m.x.user) || (m?.y?.moving && !m.y.user));
}

/** Desloca até `to` com uma mola; muda de alvo a meio sem perder a velocidade. */
export function scrollToSmooth(
  el: HTMLElement,
  to: number,
  axis: Axis = 'y',
  options: { velocity?: number; release?: boolean } = {},
): void {
  const target = Math.min(Math.max(to, 0), Math.max(0, maxOf(el, axis)));
  if (prefersReducedMotion()) {
    set(el, axis, target);
    return;
  }
  watch(el);
  const m = motions.get(el) ?? {};
  motions.set(el, m);
  let motion = m[axis];
  if (!motion || !motion.moving) {
    const fresh: Motion = {
      moving: true,
      user: false,
      spring: new Spring({
        value: position(el, axis),
        onUpdate: (v) => set(el, axis, v),
        onRest: () => {
          fresh.moving = false;
        },
      }),
    };
    motion = fresh;
    m[axis] = motion;
  }
  motion.moving = true;
  motion.user = options.release === true;
  motion.spring.to(target, {
    velocity: options.velocity ?? 0,
    params: options.release ? SPRING.release : SPRING.settle,
  });
}

/** Traz um elemento à vista dentro da área, suavemente (só se precisar). */
export function scrollIntoViewSmooth(
  container: HTMLElement,
  target: Element,
  block: 'nearest' | 'center' | 'end' = 'nearest',
  margin = 24,
): void {
  const box = container.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const top = rect.top - box.top + container.scrollTop;
  const bottom = top + rect.height;
  const view = container.clientHeight;
  let to: number | null = null;
  if (block === 'center') to = top - (view - rect.height) / 2;
  else if (block === 'end') to = bottom - view + margin;
  else if (top < container.scrollTop + margin) to = top - margin;
  else if (bottom > container.scrollTop + view - margin) to = bottom - view + margin;
  if (to !== null) scrollToSmooth(container, to);
}

const INTERACTIVE =
  'button, a, input, textarea, select, label, summary, pre, code, kbd, img, video, canvas, [contenteditable=""], [contenteditable="true"], [role="button"], [role="slider"], [role="menuitem"], [role="checkbox"], [data-no-drag]';

/** Por baixo do rato há texto (uma letra mesmo, não o espaço vazio à volta)? */
function overText(target: Element, x: number, y: number): boolean {
  for (const node of Array.from(target.childNodes)) {
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of Array.from(range.getClientRects())) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
  }
  return false;
}

/** Só se arrasta onde não há texto, controlos nem código. */
export function canDragFrom(target: EventTarget | null, x: number, y: number): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(INTERACTIVE)) return false;
  if (overText(target, x, y)) return false;
  return !window.getSelection()?.toString();
}

/**
 * Arrastar para deslocar: premir e arrastar numa zona vazia desloca a área, com inércia ao
 * largar e resistência elástica nas pontas. O clique que acaba um arrasto não chega a nada.
 */
export function useDragScroll(
  ref: RefObject<HTMLElement | null>,
  axes: { x?: boolean; y?: boolean } = { y: true },
): void {
  const allowX = axes.x === true;
  const allowY = axes.y !== false;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let start: { x: number; y: number; left: number; top: number } | null = null;
    let dragging = false;
    let samples: { x: number; y: number; t: number }[] = [];
    let stretch = { x: 0, y: 0 };
    const content = () => Array.from(el.children) as HTMLElement[];

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType !== 'mouse') return;
      if (!canDragFrom(e.target, e.clientX, e.clientY)) return;
      stopAll(el);
      start = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
      samples = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }];
    };

    const axisMove = (axis: Axis, raw: number) => {
      const max = Math.max(0, maxOf(el, axis));
      const size = axis === 'y' ? el.clientHeight : el.clientWidth;
      if (raw < 0) {
        set(el, axis, 0);
        stretch[axis] = rubberband(-raw, size);
      } else if (raw > max) {
        set(el, axis, max);
        stretch[axis] = -rubberband(raw - max, size);
      } else {
        set(el, axis, raw);
        stretch[axis] = 0;
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!dragging) {
        if (Math.hypot(dx, dy) < 5) return;
        dragging = true;
        el.setPointerCapture(e.pointerId);
        el.dataset.dragging = '';
      }
      if (allowY) axisMove('y', start.top - dy);
      if (allowX) axisMove('x', start.left - dx);
      if (prefersReducedMotion()) stretch = { x: 0, y: 0 };
      for (const c of content()) {
        c.style.transition = 'none';
        c.style.transform =
          stretch.x || stretch.y ? `translate(${stretch.x}px, ${stretch.y}px)` : '';
      }
      samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
      if (samples.length > 5) samples.shift();
    };

    const onUp = (e: PointerEvent) => {
      if (!start) return;
      const wasDragging = dragging;
      start = null;
      dragging = false;
      delete el.dataset.dragging;
      if (!wasDragging) return;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      // O clique que acaba o arrasto não abre nem escolhe nada.
      el.addEventListener('click', (c) => c.stopPropagation(), { capture: true, once: true });
      if (stretch.x || stretch.y) {
        // Volta da ponta elástica como uma mola curta (só transform); depois limpa tudo, para
        // não estragar as transições próprias dos blocos.
        const children = content();
        for (const c of children) {
          c.style.transition = 'transform 240ms cubic-bezier(0.23, 1, 0.32, 1)';
          c.style.transform = '';
        }
        setTimeout(() => {
          for (const c of children) c.style.transition = '';
        }, 260);
        stretch = { x: 0, y: 0 };
        return;
      }
      const first = samples[0];
      const last = samples.at(-1);
      const dt = first && last ? (last.t - first.t) / 1000 : 0;
      if (!first || !last || dt <= 0) return;
      // Inércia: continua na direção do gesto e assenta como um trackpad.
      if (allowY) {
        const v = -(last.y - first.y) / dt;
        scrollToSmooth(el, el.scrollTop + project(v, 0.995), 'y', { velocity: v, release: true });
      }
      if (allowX) {
        const v = -(last.x - first.x) / dt;
        scrollToSmooth(el, el.scrollLeft + project(v, 0.995), 'x', { velocity: v, release: true });
      }
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
  }, [ref, allowX, allowY]);
}
