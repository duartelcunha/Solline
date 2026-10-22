import { afterEach, expect, it, vi } from 'vitest';
import { createMorphQueue, observeTransition } from './morph.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('uma transição substituída conserva a ordem e não perde a atualização', async () => {
  const updates: number[] = [];
  const transitions: Promise<void>[] = [];
  vi.stubGlobal('document', {
    hidden: false,
    startViewTransition(update: () => void) {
      const updateCallbackDone = Promise.resolve().then(update);
      transitions.push(updateCallbackDone);
      return {
        ready: Promise.reject(new DOMException('Transition was skipped', 'AbortError')),
        updateCallbackDone,
      };
    },
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const enqueue = createMorphQueue();
  enqueue(() => {
    updates.push(1);
  }, true);
  enqueue(() => {
    updates.push(2);
  }, true);
  await Promise.all(transitions);
  await vi.waitFor(() => expect(updates).toEqual([1, 2]));
  expect(error).not.toHaveBeenCalled();
});
it('erros de configuração da animação continuam visíveis ao QA', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const failure = new DOMException('Duplicate names', 'InvalidStateError');
  observeTransition({ ready: Promise.reject(failure) } as ViewTransition);
  await Promise.resolve();
  expect(error).toHaveBeenCalledWith(failure);
});
