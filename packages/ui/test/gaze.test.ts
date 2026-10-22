import { afterEach, expect, it, vi } from 'vitest';
import { watchGaze } from '../src/bot/gaze.ts';

afterEach(() => vi.unstubAllGlobals());
it('partilha um frame, ignora toque e remove listeners e trabalho pendente no último unmount', () => {
  const windowTarget = new EventTarget(),
    documentTarget = new EventTarget();
  const add = vi.spyOn(windowTarget, 'addEventListener');
  const remove = vi.spyOn(windowTarget, 'removeEventListener');
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.stubGlobal('window', windowTarget);
  vi.stubGlobal('document', documentTarget);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const a = vi.fn(),
    b = vi.fn();
  const phases: string[] = [];
  a.mockImplementation(() => phases.push('write a'));
  b.mockImplementation(() => phases.push('write b'));
  const stopA = watchGaze(a, () => phases.push('read a')),
    stopB = watchGaze(b, () => phases.push('read b'));
  const move = (pointerType: string, clientX: number) =>
    windowTarget.dispatchEvent(
      Object.assign(new Event('pointermove'), { pointerType, clientX, clientY: 20 }),
    );
  try {
    expect(add.mock.calls.filter(([name]) => name === 'pointermove')).toHaveLength(1);
    move('touch', 100);
    expect(frames.size).toBe(0);
    move('mouse', 100);
    move('mouse', 150);
    expect(frames.size).toBe(1);
    const callback = [...frames.values()][0];
    frames.clear();
    callback?.(16);
    expect(a).toHaveBeenLastCalledWith(150, 20);
    expect(b).toHaveBeenLastCalledWith(150, 20);
    expect(phases).toEqual(['read a', 'read b', 'write a', 'write b']);
    stopA();
    move('pen', 200);
    expect(frames.size).toBe(1);
    stopB();
    expect(frames.size).toBe(0);
    expect(remove.mock.calls.filter(([name]) => name === 'pointermove')).toHaveLength(1);
    move('mouse', 250);
    expect(frames.size).toBe(0);
  } finally {
    stopA();
    stopB();
  }
});
