import { useEffect, useState } from 'react';
import type { AgentId, SessionState } from '@solline/protocol';
import { useApp, useSession } from '../../stores/app.ts';

/**
 * A tripulação: cada agente é um feiticeiro com a sua cor e o seu amuleto, e a pose diz o
 * estado de relance. Arte provisória (cortada da folha por scripts/slice-crew.py); sprites
 * desenhados a 48x48 entram com os mesmos nomes.
 */

const SPRITES = import.meta.glob<string>('../../assets/crew/*.png', {
  eager: true,
  import: 'default',
});

export type Character = 'aureo' | 'ciano' | 'vertice' | 'enlace' | 'indigo';
export type Pose = 'waiting' | 'working' | 'done' | 'needs-you' | 'permission' | 'celebrate';
export type FamiliarScene = 'laptop' | 'door' | 'merge';

const NAMES: Record<Character, string> = {
  aureo: 'Áureo',
  ciano: 'Ciano',
  vertice: 'Vértice',
  enlace: 'Enlace',
  indigo: 'Índigo',
};

function sprite(name: string): string | undefined {
  return SPRITES[`../../assets/crew/${name}.png`];
}

/** Claude é o Áureo, o Codex o Ciano, os agentes ACP o Enlace; os que vierem, o Índigo. */
export function characterOf(agent: AgentId, transport?: string): Character {
  if (agent === 'claude') return 'aureo';
  if (agent === 'codex') return 'ciano';
  return transport === 'acp' ? 'enlace' : 'indigo';
}

/** O feiticeiro de uma sessão (pelo agente e pelo transporte dele). */
export function useSessionCharacter(sessionId: string): Character {
  const agent = useSession(sessionId, (s) => s.info.agent);
  const transport = useApp((s) => s.agents.find((a) => a.id === agent)?.transport);
  return characterOf(agent, transport);
}

/** O feiticeiro e a pose de uma sessão, prontos a desenhar. */
export function SessionAvatar({ sessionId, size }: { sessionId: string; size?: number }) {
  const character = useSessionCharacter(sessionId);
  const pose = useSessionPose(useSession(sessionId, (s) => s.info.state));
  return <CrewAvatar character={character} pose={pose} size={size} />;
}

/**
 * A pose a partir do estado da sessão. Quando um turno acaba, o polegar fica levantado dois
 * segundos e depois volta à espera.
 */
export function useSessionPose(state: SessionState): Pose {
  const [previous, setPrevious] = useState(state);
  const [justDone, setJustDone] = useState(false);
  if (previous !== state) {
    setPrevious(state);
    setJustDone(previous === 'running' && state === 'idle');
  }
  useEffect(() => {
    if (!justDone) return;
    const timer = setTimeout(() => setJustDone(false), 2_000);
    return () => clearTimeout(timer);
  }, [justDone]);
  if (state === 'running' || state === 'starting') return 'working';
  if (state === 'needs-you') return 'permission';
  if (state === 'error') return 'needs-you';
  return justDone ? 'done' : 'waiting';
}

export function CrewAvatar({
  character,
  pose,
  size = 24,
  className = '',
}: {
  character: Character;
  pose: Pose;
  size?: number;
  className?: string;
}) {
  // Muda de pose a transformar-se, mas o primeiro desenho fica quieto.
  const [shown, setShown] = useState(pose);
  const [changed, setChanged] = useState(false);
  if (shown !== pose) {
    setShown(pose);
    setChanged(true);
  }
  const src = sprite(`${character}-${pose}`);
  if (!src) return null;
  return (
    <span
      className={`crew-avatar relative inline-grid shrink-0 place-items-center ${className}`}
      style={{ width: size, height: size }}
      data-testid="crew-avatar"
      data-character={character}
      data-pose={pose}
      title={NAMES[character]}
    >
      <img
        key={pose}
        src={src}
        alt=""
        width={size}
        height={size}
        draggable={false}
        className={`${pose === 'waiting' ? 'crew-idle' : ''} ${changed ? 'icon-morph' : ''}`}
      />
    </span>
  );
}

/** O familiar: o companheiro do utilizador, só nos momentos raros (início, vazio, PR). */
export function Familiar({ scene, size = 160 }: { scene: FamiliarScene; size?: number }) {
  const src = sprite(`familiar-${scene}`);
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      draggable={false}
      className="sl-enter sl-motion select-none"
      data-testid={`familiar-${scene}`}
    />
  );
}
