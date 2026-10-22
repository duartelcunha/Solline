/**
 * A marca da Solline: um sol a nascer no horizonte, com o reflexo em duas linhas, num
 * quadrado de carvão. O carvão é igual nos dois temas; no escuro ganha um contorno para não
 * se perder no fundo.
 */
export function Logo({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 44 44"
      className={className}
      data-testid="logo"
    >
      <rect
        x="0.5"
        y="0.5"
        width="43"
        height="43"
        rx="11"
        fill="#213c35"
        stroke="var(--sl-border)"
        strokeOpacity="0.6"
      />
      <path d="M10 23a12 12 0 0 1 24 0z" fill="#b0e5c7" />
      <path d="M12 28.5h20M16.5 33.5h11" stroke="#b0e5c7" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
