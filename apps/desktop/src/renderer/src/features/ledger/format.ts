/** Nunca mostra um valor em falta como zero. */
export function shownAmount(value: number | null, format: (value: number) => string): string {
  return value === null ? 'desconhecido' : format(value);
}
