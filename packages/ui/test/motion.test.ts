import { describe, expect, it } from 'vitest';
import {
  DURATION,
  MAX_UI_DURATION,
  SPRING,
  Spring,
  isSettled,
  project,
  rubberband,
  shouldAnimate,
  stepSpring,
} from '../src/motion.ts';

/** Um relógio de frames manual: cada tick avança 16 ms. */
function clock() {
  const queue: ((time: number) => void)[] = [];
  let now = 0;
  return {
    frame: (cb: (time: number) => void) => queue.push(cb),
    cancelFrame: () => queue.splice(0),
    run(frames: number) {
      for (let i = 0; i < frames && queue.length > 0; i++) {
        now += 16;
        queue.shift()!(now);
      }
    },
    get pending() {
      return queue.length;
    },
  };
}

describe('tokens', () => {
  it('tudo abaixo de 300 ms e a saída mais rápida do que a entrada', () => {
    for (const ms of Object.values(DURATION)) expect(ms).toBeLessThan(MAX_UI_DURATION);
    expect(DURATION.exit).toBeLessThan(DURATION.base);
  });
});

describe('mola', () => {
  it('com dampingRatio 1 chega ao alvo sem passar dele', () => {
    let state = { value: 0, velocity: 0 };
    let max = 0;
    for (let i = 0; i < 120; i++) {
      state = stepSpring(state, 100, SPRING.settle, 1 / 60);
      max = Math.max(max, state.value);
    }
    expect(max).toBeLessThanOrEqual(100.01);
    expect(isSettled(state, 100)).toBe(true);
  });

  it('abaixo de 1 passa do alvo e volta', () => {
    let state = { value: 0, velocity: 0 };
    let max = 0;
    for (let i = 0; i < 120; i++) {
      state = stepSpring(state, 100, SPRING.release, 1 / 60);
      max = Math.max(max, state.value);
    }
    expect(max).toBeGreaterThan(100.5);
    expect(isSettled(state, 100)).toBe(true);
  });

  it('é interruptível: o novo alvo parte do valor e da velocidade atuais', () => {
    const c = clock();
    const values: number[] = [];
    const spring = new Spring({ value: 0, onUpdate: (v) => values.push(v), ...c });
    spring.to(100);
    c.run(6);
    const mid = spring.value;
    const velocity = spring.velocity;
    expect(mid).toBeGreaterThan(0);
    expect(velocity).toBeGreaterThan(0);
    spring.to(0);
    c.run(1);
    // Sem saltos: o primeiro frame depois de mudar o alvo ainda segue na mesma direção.
    expect(spring.value).toBeGreaterThan(mid);
    c.run(200);
    expect(spring.value).toBe(0);
    expect(spring.animating).toBe(false);
  });

  it('jump salta sem animar e pára a que corria', () => {
    const c = clock();
    const values: number[] = [];
    const spring = new Spring({ value: 0, onUpdate: (v) => values.push(v), ...c });
    spring.to(50);
    c.run(2);
    spring.jump(10);
    expect(values.at(-1)).toBe(10);
    expect(spring.animating).toBe(false);
    expect(c.pending).toBe(0);
  });

  it('a velocidade de um gesto passa para a mola', () => {
    const c = clock();
    const spring = new Spring({ value: 0, onUpdate: () => undefined, ...c });
    spring.to(0, { velocity: 800 });
    c.run(1);
    expect(spring.value).toBeGreaterThan(5);
  });
});

describe('gestos', () => {
  it('projeta para onde o gesto ia parar', () => {
    expect(project(0)).toBe(0);
    expect(project(1000)).toBeCloseTo(499, 0);
    expect(project(-1000)).toBeCloseTo(-499, 0);
  });

  it('o rubberband resiste cada vez mais', () => {
    expect(rubberband(0, 300)).toBe(0);
    const a = rubberband(50, 300);
    const b = rubberband(200, 300);
    expect(a).toBeLessThan(50);
    expect(b - a).toBeLessThan(150);
  });

  it('um click de teclado (detail 0) não anima', () => {
    expect(shouldAnimate({ detail: 0 })).toBe(false);
    expect(shouldAnimate({ detail: 1 })).toBe(true);
  });
});

describe('pausa do que se repete', () => {
  it('fica em pausa com a janela escondida ou sem foco, e volta', async () => {
    const { trackAmbient } = await import('../src/motion.ts');
    const listeners: Record<string, () => void> = {};
    const state = { hidden: false, focus: true };
    const html = { dataset: {} as Record<string, string> };
    const doc = {
      get hidden() {
        return state.hidden;
      },
      hasFocus: () => state.focus,
      documentElement: html,
      addEventListener: (type: string, fn: () => void) => (listeners[type] = fn),
      removeEventListener: () => undefined,
    } as unknown as Document;
    const win = {
      addEventListener: (type: string, fn: () => void) => (listeners[type] = fn),
      removeEventListener: () => undefined,
    } as unknown as Window;
    trackAmbient(doc, win);
    expect(html.dataset.ambient).toBe('running');
    state.focus = false;
    listeners.blur!();
    expect(html.dataset.ambient).toBe('paused');
    state.focus = true;
    listeners.focus!();
    expect(html.dataset.ambient).toBe('running');
    state.hidden = true;
    listeners.visibilitychange!();
    expect(html.dataset.ambient).toBe('paused');
  });
});
