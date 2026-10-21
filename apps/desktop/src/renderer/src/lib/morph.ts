import { createContext, useContext, useState } from 'react';
import { flushSync } from 'react-dom';
import type { EngineEvent } from '@solline/protocol';
import { shouldAnimate } from '@solline/ui/motion';

/**
 * Uma mudança de estado que se transforma em vez de saltar: o browser fotografa o antes,
 * aplica a mudança e transforma cada elemento com o mesmo view-transition-name no novo
 * (tamanho, posição e conteúdo). As regras de tempo vivem no motion.css.
 *
 * A mudança só se aplica no frame seguinte, por isso o que chega entretanto espera na fila:
 * a ordem dos eventos do motor nunca se troca.
 */
export function createMorphQueue(): (update: () => void, transform: boolean) => void {
  let tail: Promise<void> = Promise.resolve();
  let waiting = 0;
  const settle = () => {
    waiting -= 1;
  };
  return (update, transform) => {
    if (waiting > 0) {
      waiting += 1;
      tail = tail
        .then(update)
        .catch(() => undefined)
        .finally(settle);
      return;
    }
    if (!transform || typeof document.startViewTransition !== 'function' || !shouldAnimate()) {
      update();
      return;
    }
    waiting += 1;
    const transition = document.startViewTransition(() => flushSync(update));
    tail = transition.updateCallbackDone.catch(() => undefined).finally(settle);
  };
}

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
