import { afterEach, expect, it, vi } from 'vitest';
import { createMorphQueue, observeTransition } from './morph.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function environment() {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: false, hasFocus: (): boolean => true });
  const media = Object.assign(new EventTarget(), { matches: false });
  const captures: { update: () => void; finish: () => void; skip: ReturnType<typeof vi.fn> }[] = [];
  const startViewTransition = vi.fn((update: () => void) => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const skip = vi.fn();
    captures.push({ update, finish, skip });
    return { ready: Promise.resolve(), finished, skipTransition: skip };
  });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', Object.assign(doc, { startViewTransition }));
  vi.stubGlobal('matchMedia', () => media);
  const capture = () => {
    const first = captures[0];
    if (!first) throw new Error('No view transition was started');
    return first;
  };
  return { win, doc, media, capture, startViewTransition };
}

it('uma atualização nova aplica a captura pendente na ordem certa sem esperar pelo browser', async () => {
  const { capture, startViewTransition } = environment();
  const updates: number[] = [];
  const cleanup = vi.fn();
  const enqueue = createMorphQueue();
  enqueue(() => updates.push(1), true, { prepare: vi.fn(), cleanup });
  expect(updates).toEqual([]);
  enqueue(() => updates.push(2), true);
  expect(updates).toEqual([1, 2]);
  expect(startViewTransition).toHaveBeenCalledTimes(1);
  expect(capture().skip).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
  capture().update();
  capture().finish();
  await Promise.resolve();
  expect(updates).toEqual([1, 2]);
  expect(cleanup).toHaveBeenCalledOnce();
});

it('streaming interrompe o efeito visual sem esperar nem duplicar eventos', () => {
  const { capture } = environment();
  const enqueue = createMorphQueue();
  const updates: string[] = [];
  enqueue(() => updates.push('running'), true);
  capture().update();
  enqueue(() => updates.push('text'), false);
  expect(updates).toEqual(['running', 'text']);
  expect(capture().skip).toHaveBeenCalledOnce();
  capture().finish();
});

it.each(['blur', 'hidden', 'reduced'] as const)(
  '%s suspende a captura e conserva o estado final',
  (reason) => {
    const { win, doc, media, capture } = environment();
    const update = vi.fn();
    const cleanup = vi.fn();
    createMorphQueue()(update, true, { prepare: vi.fn(), cleanup });
    if (reason === 'blur') win.dispatchEvent(new Event('blur'));
    if (reason === 'hidden') {
      doc.hidden = true;
      doc.dispatchEvent(new Event('visibilitychange'));
    }
    if (reason === 'reduced') {
      media.matches = true;
      media.dispatchEvent(new Event('change'));
    }
    expect(update).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(capture().skip).toHaveBeenCalledOnce();
    capture().update();
    capture().finish();
    expect(update).toHaveBeenCalledOnce();
  },
);

it('não inicia capturas numa janela visível sem foco', () => {
  const { doc, startViewTransition } = environment();
  doc.hasFocus = () => false;
  const update = vi.fn();
  createMorphQueue()(update, true);
  expect(update).toHaveBeenCalledOnce();
  expect(startViewTransition).not.toHaveBeenCalled();
});

it('uma falha síncrona de captura não perde a ação nem os nomes temporários', () => {
  const { startViewTransition } = environment();
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  startViewTransition.mockImplementation(() => {
    throw new Error('Unavailable');
  });
  const update = vi.fn(),
    cleanup = vi.fn();
  createMorphQueue()(update, true, { prepare: vi.fn(), cleanup });
  expect(update).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(error).toHaveBeenCalledOnce();
});

it('skip esperado fica silencioso mas erros de configuração continuam visíveis ao QA', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  observeTransition({
    ready: Promise.reject(new DOMException('Superseded', 'AbortError')),
  } as ViewTransition);
  const failure = new DOMException('Duplicate names', 'InvalidStateError');
  observeTransition({ ready: Promise.reject(failure) } as ViewTransition);
  await Promise.resolve();
  expect(error).toHaveBeenCalledExactlyOnceWith(failure);
});
