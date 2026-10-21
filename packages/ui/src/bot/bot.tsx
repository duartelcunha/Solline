import {
  EYE_STROKE,
  HEM_WIDTH,
  VIEWBOX,
  botFrame,
  palette,
  type Hood,
  type Mood,
} from './geometry.ts';

/**
 * Um bot da Solline, parado no humor que lhe dão. A animação (respirar, piscar, olhar)
 * entra mais tarde por cima disto, sem mudar a geometria.
 */
export function Bot({
  hood,
  mood,
  size = 24,
  className,
  title,
}: {
  hood: Hood;
  mood: Mood;
  size?: number;
  className?: string;
  /** Nome ao passar o rato; sem ele, o bot é decorativo para os leitores de ecrã. */
  title?: string;
}) {
  const frame = botFrame(mood);
  const colours = palette(hood, frame.tone);
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
      <g transform={frame.hoodTransform || undefined}>
        <path d={frame.hood} fill={colours.hood} />
        <path d={frame.face} fill={colours.face} />
        {frame.eyes.map((eye, i) =>
          eye.paint === 'fill' ? (
            <path key={i} d={eye.d} fill={colours.eyes} />
          ) : (
            <path
              key={i}
              d={eye.d}
              fill="none"
              stroke={colours.eyes}
              strokeWidth={EYE_STROKE}
              strokeLinecap="round"
            />
          ),
        )}
      </g>
      <path d={frame.hem} stroke={colours.hem} strokeWidth={HEM_WIDTH} strokeLinecap="round" />
    </svg>
  );
}
