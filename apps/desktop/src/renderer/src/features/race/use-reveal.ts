import { useEffect, useRef, type RefObject } from 'react';
import { scrollIntoViewSmooth } from '@solline/ui/scroll';

/**
 * Traz um painel à vista quando a vista o vê mudar de passo (abrir uma corrida que já estava
 * nesse passo não mexe em nada). `step` é o passo atual; `reveal` diz quais merecem deslizar.
 */
export function useReveal(
  area: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  step: string,
  reveal: (step: string) => boolean,
): void {
  const last = useRef(step);
  useEffect(() => {
    const before = last.current;
    last.current = step;
    if (before === step || !reveal(step)) return;
    const frame = requestAnimationFrame(() => {
      if (area.current && panel.current)
        scrollIntoViewSmooth(area.current, panel.current, 'nearest');
    });
    return () => cancelAnimationFrame(frame);
  }, [step, area, panel, reveal]);
}
