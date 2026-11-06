/** Cabe numas três linhas a 760 px. Acima disto, a lista fica com reticências e o resto no tooltip. */
export const SESSION_TITLE_LIMIT = 120;

export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return 'Nova sessão';
  if (line.length <= SESSION_TITLE_LIMIT) return line;
  return `${line.slice(0, SESSION_TITLE_LIMIT - 1)}…`;
}
