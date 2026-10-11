/**
 * Ícones dos modos, vindos do archive/crab-crew (hooks/card/mode-icons.ts): traço de
 * 1,5 px numa caixa de 16 px, pontas redondas, sem enchimento.
 *   plan         uma bússola
 *   auto         uma seta circular com uma faísca
 *   default      um balão com "?" (Ask)
 *   acceptEdits  um lápis com um visto (Edits)
 */
const MODE_PATHS: Record<string, readonly string[]> = {
  plan: [
    'M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 1 0 0-12.5Z',
    'M10.65 5.35L9.1 9.1L5.35 10.65L6.9 6.9Z',
  ],
  auto: ['M7.5 3.5A5 5 0 1 0 12.5 8.5', 'M10.6 10.2L12.5 8.3L14.4 10.2', 'M12.5 1.75v3M11 3.25h3'],
  default: [
    'M4 2h8a2.25 2.25 0 0 1 2.25 2.25v4.75a2.25 2.25 0 0 1-2.25 2.25H7.75L4.5 14.25v-3H4a2.25 2.25 0 0 1-2.25-2.25V4.25A2.25 2.25 0 0 1 4 2Z',
    'M6.5 5.5a1.5 1.5 0 1 1 2.2 1.33c-.42.22-.7.6-.7 1.07',
    'M8 9.6v.01',
  ],
  acceptEdits: [
    'M9 2.5a1.42 1.42 0 1 1 2 2L4.25 11.25L1.5 12l.75-2.75Z',
    'M9.25 12.25l1.75 1.75l3.5-3.5',
  ],
};

export function ModeIcon({ mode, size = 16 }: { mode: string; size?: number }) {
  const paths = MODE_PATHS[mode] ?? MODE_PATHS.default ?? [];
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
