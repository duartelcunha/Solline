import type { ModeRisk } from '@solline/protocol';

/**
 * Ícones dos modos pelo risco (cada agente tem os seus ids), vindos do archive/crab-crew
 * (hooks/card/mode-icons.ts): traço de 1,5 px numa caixa de 16 px, pontas redondas, sem
 * enchimento.
 *   read-only  um olho
 *   plan       uma bússola
 *   ask        um balão com "?"
 *   edits      um lápis com um visto
 *   auto       uma seta circular com uma faísca
 *   full       um cadeado aberto
 */
const MODE_PATHS: Record<ModeRisk, readonly string[]> = {
  'read-only': [
    'M1.75 8S4 3.75 8 3.75S14.25 8 14.25 8S12 12.25 8 12.25S1.75 8 1.75 8Z',
    'M8 6.25a1.75 1.75 0 1 0 0 3.5a1.75 1.75 0 1 0 0-3.5Z',
  ],
  plan: [
    'M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 1 0 0-12.5Z',
    'M10.65 5.35L9.1 9.1L5.35 10.65L6.9 6.9Z',
  ],
  ask: [
    'M4 2h8a2.25 2.25 0 0 1 2.25 2.25v4.75a2.25 2.25 0 0 1-2.25 2.25H7.75L4.5 14.25v-3H4a2.25 2.25 0 0 1-2.25-2.25V4.25A2.25 2.25 0 0 1 4 2Z',
    'M6.5 5.5a1.5 1.5 0 1 1 2.2 1.33c-.42.22-.7.6-.7 1.07',
    'M8 9.6v.01',
  ],
  edits: [
    'M9 2.5a1.42 1.42 0 1 1 2 2L4.25 11.25L1.5 12l.75-2.75Z',
    'M9.25 12.25l1.75 1.75l3.5-3.5',
  ],
  auto: ['M7.5 3.5A5 5 0 1 0 12.5 8.5', 'M10.6 10.2L12.5 8.3L14.4 10.2', 'M12.5 1.75v3M11 3.25h3'],
  full: [
    'M3.75 7.25h8.5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z',
    'M5.25 7.25V5a2.75 2.75 0 0 1 5.3-1.05',
  ],
};

export function ModeIcon({ risk, size = 16 }: { risk: ModeRisk; size?: number }) {
  const paths = MODE_PATHS[risk];
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
