import type { FileDiff, ReviewComment, Turn } from '@solline/protocol';

/** O texto de um turno do utilizador (o primeiro bloco de texto). */
export function textOf(turn: Turn): string {
  for (const block of turn.blocks) if (block.kind === 'text') return block.text;
  return '';
}

/** Só o que o agente disse ao utilizador: sem thinking, ferramentas nem subagentes. */
export function assistantText(turn: Turn): string {
  return turn.blocks
    .flatMap((b) => (b.kind === 'text' && b.parentToolId === null ? [b.text] : []))
    .join('\n')
    .trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const PER_TURN = 1_500;
const TOTAL = 12_000;

/**
 * O resumo que uma sessão nova recebe quando o agente não sabe rebobinar a conversa: as
 * mensagens que ficaram, pela ordem, cortadas para caber. Se não couber tudo, ficam as mais
 * recentes. Devolve undefined quando não ficou nada para trás.
 */
export function summaryOf(
  turns: readonly Turn[],
  intro = 'Esta conversa continua uma sessão anterior que foi rebobinada. O que ficou dela, por ordem:',
): string | undefined {
  const lines: string[] = [];
  for (const turn of turns) {
    const text = turn.role === 'user' ? textOf(turn).trim() : assistantText(turn);
    if (!text) continue;
    lines.push(`${turn.role === 'user' ? 'Utilizador' : 'Agente'}: ${clip(text, PER_TURN)}`);
  }
  if (lines.length === 0) return undefined;
  const kept: string[] = [];
  let size = 0;
  for (const line of [...lines].reverse()) {
    if (size + line.length > TOTAL) break;
    kept.unshift(line);
    size += line.length;
  }
  const skipped = lines.length - kept.length;
  return [
    intro,
    ...(skipped > 0 ? [`(${skipped} mensagens mais antigas ficaram de fora)`] : []),
    '',
    kept.join('\n\n'),
  ].join('\n');
}

/** A linha citada de um comentário, tirada do diff de rever. */
function quoteFor(comment: ReviewComment, files: readonly FileDiff[]): string | undefined {
  const file = files.find((f) => f.path === comment.path);
  for (const hunk of file?.hunks ?? []) {
    for (const line of hunk.lines) {
      const no = comment.side === 'new' ? line.newNo : line.oldNo;
      if (
        no === comment.line &&
        (comment.side === 'new' ? line.kind !== 'del' : line.kind !== 'add')
      ) {
        return line.text;
      }
    }
  }
  return undefined;
}

/** Junta os comentários em linha numa mensagem para o agente, ficheiro a ficheiro. */
export function commentsMessage(
  comments: readonly ReviewComment[],
  files: readonly FileDiff[],
  note?: string,
): string {
  const parts = ['Revi as alterações e deixei comentários em linhas concretas:'];
  for (const comment of comments) {
    const where = `${comment.path}, linha ${comment.line}${comment.side === 'old' ? ' (versão antiga)' : ''}`;
    const quote = quoteFor(comment, files);
    parts.push(
      [`**${where}**`, ...(quote !== undefined ? [`> ${quote}`] : []), comment.text.trim()].join(
        '\n',
      ),
    );
  }
  if (note?.trim()) parts.push(note.trim());
  return parts.join('\n\n');
}
