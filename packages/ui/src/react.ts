import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import {
  DURATION,
  Spring,
  prefersReducedMotion,
  shouldAnimate,
  type SpringParams,
} from './motion.ts';

/** Segue o prefers-reduced-motion do sistema (muda ao vivo). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
}

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => undefined;
  const query = matchMedia('(prefers-reduced-motion: reduce)');
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * Uma mola que escreve direto no DOM (onUpdate), sem re-render por frame. Nasce depois de
 * montar: usa-se em handlers e efeitos (ref.current?.to(x)), nunca a desenhar.
 */
export function useSpring(
  initial: number,
  onUpdate: (value: number) => void,
  params?: SpringParams,
): RefObject<Spring | null> {
  const spring = useRef<Spring | null>(null);
  const update = useRef(onUpdate);
  useEffect(() => {
    update.current = onUpdate;
  });
  const [start] = useState(initial);
  const [config] = useState(params);
  useEffect(() => {
    const created = new Spring({
      value: start,
      params: config,
      onUpdate: (v) => update.current(v),
    });
    spring.current = created;
    return () => {
      created.stop();
      spring.current = null;
    };
  }, [start, config]);
  return spring;
}

/**
 * Montar com entrada e desmontar depois da saída. state passa a "closed" logo ao fechar
 * (o CSS faz a saída) e o elemento sai do DOM ao fim de exitMs. Sem animação (teclado),
 * sai logo.
 */
export function usePresence(
  open: boolean,
  exitMs: number = DURATION.exit,
): { mounted: boolean; state: 'open' | 'closed' } {
  const [mounted, setMounted] = useState(open);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setMounted(true);
    else if (!shouldAnimate()) setMounted(false);
  }
  useEffect(() => {
    if (open || !mounted) return;
    const timer = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(timer);
  }, [open, mounted, exitMs]);
  return { mounted: open || mounted, state: open ? 'open' : 'closed' };
}
