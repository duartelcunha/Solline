import { useEffect, useState, type ReactNode } from 'react';

/**
 * Troca de ícone no mesmo sítio, como um morph: o antigo sai desfocado e a encolher, o novo
 * entra a partir desse desfoque, ao mesmo tempo (CSS em motion.css, .sl-swap). Só anima quando
 * `swapKey` muda; ao montar e em repouso fica parado. `instant` troca sem animar (uma mudança
 * pedida pelo teclado). Com movimento reduzido, o CSS deixa só a opacidade.
 */

const OUT_MS = 140;

interface Layer {
  key: string;
  node: ReactNode;
}

export function IconSwap({
  swapKey,
  children,
  instant = false,
  className,
}: {
  swapKey: string;
  children: ReactNode;
  instant?: boolean;
  className?: string;
}) {
  const [leaving, setLeaving] = useState<Layer | null>(null);
  // O ícone de cada estado: quando o estado muda, o que estava passa a ser a camada que sai
  // (padrão "estado anterior no estado", sem um frame com os dois sobrepostos sem animação).
  const [shown, setShown] = useState<Layer>({ key: swapKey, node: children });
  if (shown.key !== swapKey) {
    setShown({ key: swapKey, node: children });
    setLeaving(instant ? null : shown);
  }

  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(null), OUT_MS + 80);
    return () => clearTimeout(timer);
  }, [leaving]);

  return (
    <span className={`sl-swap ${className ?? ''}`} data-swap={swapKey}>
      {leaving ? (
        <span key={`out-${leaving.key}`} className="sl-swap-out" aria-hidden>
          {leaving.node}
        </span>
      ) : null}
      <span key={swapKey} className={leaving ? 'sl-swap-in' : undefined}>
        {children}
      </span>
    </span>
  );
}
