import { afterEach, expect, it, vi } from 'vitest';
import { scrollIntoViewSmooth, scrollToSmooth } from '../src/scroll.ts';

afterEach(() => vi.unstubAllGlobals());

function environment() {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  const state = { reduced: false, focused: true };
  vi.stubGlobal('matchMedia', () => ({ matches: state.reduced }));
  vi.stubGlobal('document', { hidden: false, hasFocus: () => state.focused });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const el = Object.assign(new EventTarget(), {
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 2000,
    clientHeight: 500,
    scrollWidth: 500,
    clientWidth: 500,
    getBoundingClientRect: () => ({ top: 0 }),
  }) as unknown as HTMLElement;
  return { frames, el, state };
}

it.each(['keyboard', 'reduced', 'background'] as const)(
  '%s cancela a mola antiga antes do salto e não volta a puxar o texto',
  (reason) => {
    const { frames, el, state } = environment();
    scrollToSmooth(el, 1500);
    expect(frames.size).toBe(1);
    const tick = [...frames.values()][0]!;
    frames.clear();
    tick(16);
    expect(el.scrollTop).toBeGreaterThan(0);
    if (reason === 'reduced') state.reduced = true;
    if (reason === 'background') state.focused = false;
    scrollToSmooth(el, 300, 'y', { instant: reason === 'keyboard' });
    expect(el.scrollTop).toBe(300);
    expect(frames.size).toBe(0);
  },
);

it('um salto explícito de teclado traz o pedido inteiro à vista sem criar frames', () => {
  const { frames, el } = environment();
  el.scrollTop = 100;
  const card = { getBoundingClientRect: () => ({ top: 700, height: 160 }) } as unknown as Element;
  scrollIntoViewSmooth(el, card, 'nearest', 24, { instant: true });
  expect(el.scrollTop).toBe(484);
  expect(frames.size).toBe(0);
});
