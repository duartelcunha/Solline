import { createContext, useContext, useState } from 'react';
import { flushSync } from 'react-dom';
import type { EngineEvent } from '@solline/protocol';
import { isForeground, prefersReducedMotion } from '@solline/ui/motion';

/** Superseding an animation rejects ready, even when its DOM update succeeded. */
export function observeTransition(transition: ViewTransition): void {
  void transition.ready.catch((error: unknown) => {
    if (!(error instanceof DOMException && error.name === 'AbortError')) console.error(error);
  });
}

interface MorphLifecycle {
  prepare: () => void;
  cleanup: () => void;
}

/** A newer update wins immediately, without overtaking an older deferred DOM update. */
export function createMorphQueue(): (
  update: () => void,
  transform: boolean,
  lifecycle?: MorphLifecycle,
) => void {
  interface Active {
    transition?: ViewTransition;
    pending: (() => void) | null;
    cleanup: () => void;
  }
  let active: Active | null = null;
  const apply = (entry: Active) => {
    const pending = entry.pending;
    entry.pending = null;
    if (pending) flushSync(pending);
  };
  const finish = (entry: Active) => {
    if (active === entry) active = null;
    entry.cleanup();
  };
  const interrupt = () => {
    const previous = active;
    if (!previous) return;
    active = null;
    previous.transition?.skipTransition();
    try {
      apply(previous);
    } finally {
      finish(previous);
    }
  };
  return (update, transform, lifecycle) => {
    const supersedes = active !== null;
    interrupt();
    if (
      supersedes ||
      !transform ||
      typeof document.startViewTransition !== 'function' ||
      prefersReducedMotion() ||
      !isForeground()
    ) {
      update();
      return;
    }
    const media =
      typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const suspend = () => {
      if (!isForeground() || media?.matches) interrupt();
    };
    let cleaned = false;
    const entry: Active = {
      pending: update,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        window.removeEventListener('blur', interrupt);
        document.removeEventListener('visibilitychange', suspend);
        media?.removeEventListener('change', suspend);
        lifecycle?.cleanup();
      },
    };
    active = entry;
    window.addEventListener('blur', interrupt);
    document.addEventListener('visibilitychange', suspend);
    media?.addEventListener('change', suspend);
    try {
      lifecycle?.prepare();
      const transition = document.startViewTransition(() => apply(entry));
      entry.transition = transition;
      observeTransition(transition);
      void transition.finished.finally(() => finish(entry)).catch(console.error);
    } catch (error) {
      try {
        apply(entry);
      } finally {
        finish(entry);
      }
      console.error(error);
    }
  };
}

/** Engine updates and navigation share this coordinator so their captures cannot compete. */
export const morphUpdate = createMorphQueue();

/**
 * Se o valor já mudou desde o primeiro desenho: o que se transforma ao mudar fica quieto ao
 * abrir (abrir uma sessão ou o histórico não anima tudo de uma vez).
 */
export function useChangedSinceMount<T>(value: T): boolean {
  const [first] = useState(value);
  const [changed, setChanged] = useState(false);
  if (!changed && value !== first) setChanged(true);
  return changed;
}

const ASK_KINDS = new Set(['permission', 'plan', 'question']);

/**
 * Os eventos que merecem transformação: raros e com uma forma que muda. O streaming de
 * texto e de ferramentas fica de fora (dezenas por segundo, e a transição bloqueia cliques).
 */
export function morphs(event: EngineEvent): boolean {
  if (event.type === 'session.state') return true;
  if (event.type !== 'session.event' || event.delta.type !== 'block.upsert') return false;
  const { block } = event.delta;
  return ASK_KINDS.has(block.kind) && 'status' in block && block.status !== 'pending';
}

/**
 * Só os pedidos do último turno se transformam: cada nome é uma fotografia que o browser tira
 * em cada mudança de estado, e os do histórico já não mudam.
 */
export const MorphScope = createContext(false);

/** O nome de transformação, só dentro do último turno. */
export function useMorphName(id: string): React.CSSProperties | undefined {
  return useContext(MorphScope) ? morphName(id) : undefined;
}

/** O nome que liga o antes e o depois de um elemento que se transforma. */
export function morphName(id: string): React.CSSProperties {
  return {
    viewTransitionName: `m-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    viewTransitionClass: 'sl-morph',
  } as React.CSSProperties;
}
