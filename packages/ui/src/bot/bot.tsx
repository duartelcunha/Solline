import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useReducedMotion } from '../react.ts';
import { DURATION, EASE, cssEase, isForeground } from '../motion.ts';
import { watchGaze } from './gaze.ts';
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

const finePointer = () =>
  typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;
function subscribePointer(changed: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => undefined;
  const query = matchMedia('(hover: hover) and (pointer: fine)');
  query.addEventListener('change', changed);
  return () => query.removeEventListener('change', changed);
}

/** Original Solline companion. State remains legible when all motion is stopped. */
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
  title?: string;
  alive?: boolean;
}) {
  const root = useRef<SVGSVGElement>(null);
  const eyes = useRef<SVGGElement>(null);
  const pupils = useRef<SVGGElement>(null);
  const animation = useRef<Animation | null>(null);
  const previous = useRef(mood);
  const reduced = useReducedMotion();
  const fine = useSyncExternalStore(subscribePointer, finePointer, () => false);
  const [visible, setVisible] = useState(false);
  const [foreground, setForeground] = useState(() => isForeground());
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry?.isIntersecting ?? false),
    );
    if (root.current) observer.observe(root.current);
    const changed = () => setForeground(isForeground());
    const blurred = () => setForeground(false);
    document.addEventListener('visibilitychange', changed);
    window.addEventListener('blur', blurred);
    window.addEventListener('focus', changed);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', changed);
      window.removeEventListener('blur', blurred);
      window.removeEventListener('focus', changed);
    };
  }, []);
  const live = alive && visible && foreground && !reduced;
  const gazeActive =
    fine && visible && foreground && !reduced && !['sleeping', 'done', 'crashed'].includes(mood);
  useEffect(() => {
    const target = pupils.current;
    if (!target) return;
    target.style.transform = 'translate(0px, 0px)';
    if (!gazeActive) return;
    let rect: DOMRect | undefined;
    return watchGaze(
      (x, y) => {
        if (!rect || x === null || y === null) {
          target.style.transform = 'translate(0px, 0px)';
          return;
        }
        const dx = x - (rect.left + rect.width / 2),
          dy = y - (rect.top + rect.height / 2);
        const length = Math.hypot(dx, dy);
        const radius = mood === 'reading' ? 3 : 6;
        const scale = length ? Math.min(radius, length / 20) / length : 0;
        target.style.transform = `translate(${(dx * scale).toFixed(2)}px, ${(dy * scale).toFixed(2)}px)`;
      },
      () => {
        rect = root.current?.getBoundingClientRect();
      },
    );
  }, [gazeActive, mood]);
  useEffect(() => {
    animation.current?.cancel();
    if (live && previous.current !== mood) {
      animation.current =
        eyes.current?.animate([{ transform: 'scaleY(.92)' }, { transform: 'scaleY(1)' }], {
          duration: DURATION.fast,
          easing: cssEase(EASE.out),
        }) ?? null;
    }
    previous.current = mood;
    return () => {
      animation.current?.cancel();
      animation.current = null;
    };
  }, [live, mood]);
  const blink = () => {
    if (!live || !fine || !['waiting', 'needs-you'].includes(mood)) return;
    animation.current?.cancel();
    animation.current =
      eyes.current?.animate(
        [
          { transform: 'scaleY(1)' },
          { transform: 'scaleY(.12)', offset: 0.4 },
          { transform: 'scaleY(1)' },
        ],
        { duration: DURATION.fast, easing: cssEase(EASE.out) },
      ) ?? null;
  };
  const frame = botFrame(mood, hood);
  const colours = palette(hood, frame.tone);
  const bodyStyle: CSSProperties = {
    transform: frame.hoodCss,
    transformOrigin: HOOD_ORIGIN,
    transformBox: 'view-box',
  };
  return (
    <svg
      ref={root}
      viewBox={VIEWBOX}
      width={size}
      height={size}
      className={className}
      onPointerEnter={blink}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      data-testid="bot"
      data-hood={hood}
      data-mood={mood}
      data-live={live}
      data-gaze-active={gazeActive}
    >
      {title ? <title>{title}</title> : null}
      {size >= 64 ? (
        <path
          d={frame.hem}
          fill="none"
          stroke={colours.hem}
          strokeOpacity=".13"
          strokeWidth={HEM_WIDTH}
          strokeLinecap="round"
        />
      ) : null}
      <g className="bot-hood" style={bodyStyle}>
        <path d={frame.hood} fill={colours.hood} />
        <g ref={eyes} style={{ transformOrigin: '128px 116px', transformBox: 'view-box' }}>
          {frame.eyes
            .filter((eye) => eye.layer !== 'pupil')
            .map((eye, i) => (
              <path
                key={i}
                d={eye.d}
                fill={eye.paint === 'fill' ? colours.eyes : 'none'}
                stroke={eye.paint === 'stroke' ? colours.face : undefined}
                strokeWidth={EYE_STROKE}
                strokeLinecap="round"
              />
            ))}
          <g ref={pupils} className="bot-pupils" data-testid="bot-pupils">
            {frame.eyes
              .filter((eye) => eye.layer === 'pupil')
              .map((eye, i) => (
                <path key={i} d={eye.d} fill={colours.face} />
              ))}
          </g>
        </g>
        {mood === 'working' ? (
          <g aria-hidden>
            {[116, 128, 140].map((x, i) => (
              <circle
                key={x}
                cx={x}
                cy={158}
                r={3}
                fill={colours.face}
                className="bot-dot"
                style={{ animationDelay: `${i * 160}ms` }}
              />
            ))}
          </g>
        ) : null}
      </g>
    </svg>
  );
}
