/**
 * O Solline Pin: um meio sol atravessado pela linha do tempo, com a pega no corte. Herda a
 * cor do texto (currentColor); a geometria é a do ícone da app (scripts/brand-icons.py).
 */
export function Pin({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={(size * 72) / 196}
      viewBox="30 86 196 72"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={16}
      strokeLinecap="round"
    >
      <path d="M38 150h180" />
      <path d="M80 150a48 48 0 0 1 96 0" />
      <path d="M120 150v-20h16v20z" fill="currentColor" stroke="none" />
    </svg>
  );
}
