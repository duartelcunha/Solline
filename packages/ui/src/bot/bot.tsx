import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { prefersReducedMotion } from '../motion.ts';
import {
  EYE_STROKE,
  HEM_WIDTH,
  HOOD_ORIGIN,
  VIEWBOX,
  botFrame,
  palette,
  type Hood,
  type Mood,
} from './geometry.ts';

/** Onde os olhos fecham ao piscar (a linha dos olhos), em unidades da grelha. */
const EYE_ORIGIN = '128px 118px';
const BLINKS: readonly Mood[] = ['waiting', 'needs-you'];

/**
 * Pisca de vez em quando, com um intervalo diferente por bot (nunca em uníssono) e às vezes
 * duas vezes seguidas. Pára com a janela escondida ou sem foco.
 */
function useBlink(enabled: boolean): React.RefObject<SVGGElement | null> {
  const eyes = useRef<SVGGElement>(null);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    const blinkOnce = () =>
      eyes.current?.animate(
        [
          { transform: 'scaleY(1)' },
          { transform: 'scaleY(0.1)', offset: 0.4 },
          { transform: 'scaleY(1)' },
        ],
        { duration: 160, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
      );
    const schedule = () => {
      timer = setTimeout(
        () => {
          if (!document.hidden && document.hasFocus()) {
            blinkOnce();
            if (Math.random() < 0.15) setTimeout(blinkOnce, 260);
          }
          schedule();
        },
        2_500 + Math.random() * 3_500,
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, [enabled]);
  return eyes;
}

/**
 * Um bot da Solline. Muda de humor a transformar-se: os olhos novos nascem dos antigos, o
 * capuz levanta-se ou descai, a bainha muda de cor. Os pontos de "a trabalhar" pulsam e a
 * fenda de "a ler" varre (motion.css). Só um bot vivo (alive) pisca.
 */
export function Bot({
  hood,
  mood,
  size = 24,
  className,
  title,
  alive = false,
}: {
  hood: Hood;
  mood: Mood;
  size?: number;
  className?: string;
  /** Nome ao passar o rato; sem ele, o bot é decorativo para os leitores de ecrã. */
  title?: string;
  /** O bot da sessão aberta: pisca de vez em quando. Os outros só mudam com o estado. */
  alive?: boolean;
}) {
  const frame = botFrame(mood);
  const colours = palette(hood, frame.tone);
  // A cara só se transforma depois do primeiro desenho: abrir a app não anima tudo.
  const [first] = useState(mood);
  const [changed, setChanged] = useState(false);
  if (!changed && mood !== first) setChanged(true);
  const eyes = useBlink(alive && BLINKS.includes(mood) && !prefersReducedMotion());
  const hoodStyle: CSSProperties = {
    transform: frame.hoodCss,
    transformOrigin: HOOD_ORIGIN,
    transformBox: 'view-box',
  };
  const eyeStyle: CSSProperties = { transformOrigin: EYE_ORIGIN, transformBox: 'view-box' };
  return (
    <svg
      viewBox={VIEWBOX}
      width={size}
      height={size}
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      data-testid="bot"
      data-hood={hood}
      data-mood={mood}
    >
      {title ? <title>{title}</title> : null}
      <g className="bot-hood" style={hoodStyle}>
        <path d={frame.hood} fill={colours.hood} />
        <path d={frame.face} fill={colours.face} />
        <g ref={eyes} style={eyeStyle}>
          <g key={mood} className={changed ? 'bot-eyes-in' : undefined} style={eyeStyle}>
            {frame.eyes.map((eye, i) =>
              eye.paint === 'fill' ? (
                <path
                  key={i}
                  d={eye.d}
                  fill={colours.eyes}
                  className={mood === 'working' ? 'bot-dot' : undefined}
                  style={mood === 'working' ? { animationDelay: `${i * 160}ms` } : undefined}
                />
              ) : (
                <path
                  key={i}
                  d={eye.d}
                  fill="none"
                  stroke={colours.eyes}
                  strokeWidth={EYE_STROKE}
                  strokeLinecap="round"
                  className={mood === 'reading' ? 'bot-scan' : undefined}
                />
              ),
            )}
          </g>
        </g>
      </g>
      <path
        d={frame.hem}
        className="bot-hem"
        style={{ stroke: colours.hem }}
        strokeWidth={HEM_WIDTH}
        strokeLinecap="round"
      />
    </svg>
  );
}
