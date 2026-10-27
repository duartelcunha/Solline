import { RULE_MAX_TITLE } from '@solline/protocol';

export interface Section {
  title: string;
  text: string;
}

const FENCE = /^ {0,3}(```+|~~~+)/;
const H1 = /^#\s+(.+?)\s*#*\s*$/;
const H2 = /^##\s+(.+?)\s*#*\s*$/;
const COMMENT = /^\s*<!--.*-->\s*$/;

function clip(title: string): string {
  return title.length > RULE_MAX_TITLE ? `${title.slice(0, RULE_MAX_TITLE - 1)}…` : title;
}

/**
 * Parte um ficheiro de instruções numa secção por cada `##` de topo (os `##` dentro de blocos de
 * código não contam). O que vem antes do primeiro `##` é mais uma secção, com o nome do `#` se
 * houver, e some se só tiver o título e comentários.
 */
export function splitSections(markdown: string, fallbackTitle: string): Section[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const sections: { title: string; lines: string[] }[] = [];
  const preamble: { line: string; fenced: boolean }[] = [];
  let current: { title: string; lines: string[] } | undefined;
  let fence: string | undefined;
  for (const line of lines) {
    const opening = FENCE.exec(line)?.[1];
    const wasFenced = fence !== undefined;
    if (opening) {
      if (!fence) fence = opening.charAt(0);
      else if (opening.charAt(0) === fence) fence = undefined;
    }
    const heading = fence || opening ? undefined : H2.exec(line)?.[1];
    if (heading) {
      current = { title: heading, lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push({ line, fenced: wasFenced || opening !== undefined });
  }
  let title = fallbackTitle;
  let seenTitle = false;
  const kept = preamble.filter(({ line, fenced }) => {
    if (fenced) return true;
    if (COMMENT.test(line)) return false;
    const h1 = seenTitle ? undefined : H1.exec(line)?.[1];
    if (h1) {
      seenTitle = true;
      title = h1;
      return false;
    }
    return true;
  });
  const result: Section[] = [];
  const intro = kept
    .map((entry) => entry.line)
    .join('\n')
    .trim();
  if (intro) result.push({ title: clip(title), text: intro });
  for (const found of sections) {
    result.push({ title: clip(found.title), text: found.lines.join('\n').trim() });
  }
  return result;
}
