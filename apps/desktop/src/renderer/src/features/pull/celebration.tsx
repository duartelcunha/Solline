import { useEffect } from 'react';
import { actions, useApp } from '../../stores/app.ts';

/** Uma linha, uma vez, quando o PR entra. O movimento usa os tokens; reduzido, só a opacidade. */
export function Celebration() {
  const sessionId = useApp((s) => s.celebrate);
  if (!sessionId) return null;
  return <Mark key={sessionId} />;
}

function Mark() {
  useEffect(() => {
    const timer = setTimeout(() => actions.clearCelebration(), 1600);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-32 z-50 flex justify-center">
      <p
        role="status"
        data-testid="celebration"
        className="sl-celebrate rounded-lg border border-line bg-surface px-4 py-2 text-[13px] text-fg shadow-raised"
      >
        O PR entrou.
      </p>
    </div>
  );
}
