import type { SplitPart } from '@solline/protocol';

/**
 * As zonas dos contratos de uma repartição: caminhos e globs, para ver se duas se tocam (a
 * revisão do plano) e se um ficheiro cai dentro de uma (os avisos de fora do âmbito). Pura.
 */

/** Um caminho ou glob em partes: os segmentos certos e o começo (se houver) do primeiro com glob. */
export interface Zone {
  segments: string[];
  /** O texto antes do primeiro `*?[{` do segmento onde o glob começa; null se não há glob. */
  partial: string | null;
  glob: boolean;
}

/** `[` não conta: é um carácter como outro qualquer (`app/[id].tsx`), aqui e no glob. */
const GLOB_CHAR = /[*?{]/;

/** A árvore toda: a zona de uma parte que não diz onde mexe (na dúvida, toca em tudo). */
export const WHOLE_TREE: Zone = { segments: [], partial: '', glob: true };

/**
 * O caminho em minúsculas e com `/`. `.`, `./`, `*`, `**`, `/` e o vazio querem todos dizer a
 * árvore toda e ficam como texto vazio.
 */
export function normalize(entry: string): string {
  const path = entry
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .toLowerCase();
  return path === '.' || path === '*' || path === '**' || path === '**/*' ? '' : path;
}

/** Parte o caminho no prefixo literal (com a direção das pastas) e no resto, que é glob. */
export function zoneOf(entry: string): Zone {
  const path = normalize(entry);
  const at = path.search(GLOB_CHAR);
  if (at === -1) return { segments: path.split('/').filter(Boolean), partial: null, glob: false };
  const literal = path.slice(0, at);
  const cut = literal.lastIndexOf('/');
  return {
    segments: literal
      .slice(0, cut + 1)
      .split('/')
      .filter(Boolean),
    partial: literal.slice(cut + 1),
    glob: true,
  };
}

/**
 * Duas zonas tocam-se se uma é prefixo da outra, pastas inteiras: `src/a` e `src/ab` não se
 * tocam, `src/a` e `src/a/b.ts` sim. Um glob que começa a meio de um nome (`src/a*`) só toca
 * nos nomes que começam assim. Na dúvida, toca (é a resposta segura).
 */
export function zonesOverlap(a: Zone, b: Zone): boolean {
  const common = Math.min(a.segments.length, b.segments.length);
  for (let i = 0; i < common; i++) if (a.segments[i] !== b.segments[i]) return false;
  if (a.segments.length === b.segments.length) {
    const [x, y] = [a.partial ?? '', b.partial ?? ''];
    return x.startsWith(y) || y.startsWith(x);
  }
  const [shorter, longer] = a.segments.length < b.segments.length ? [a, b] : [b, a];
  const next = longer.segments[shorter.segments.length] ?? '';
  return next.startsWith(shorter.partial ?? '');
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** As posições das chavetas que têm par; as outras contam como texto. */
function pairedBraces(glob: string): Set<number> {
  const open: number[] = [];
  const paired = new Set<number>();
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '{') open.push(i);
    else if (c === '}') {
      const start = open.pop();
      if (start !== undefined) {
        paired.add(start);
        paired.add(i);
      }
    }
  }
  return paired;
}

/**
 * O glob como expressão regular (sem distinguir maiúsculas): `**` atravessa pastas, `*` não. Nunca
 * falha: uma chaveta sem par é texto e, se mesmo assim a expressão não compilar, o glob vale como
 * caminho literal.
 */
export function globToRegExp(glob: string): RegExp {
  const paired = pairedBraces(glob);
  let out = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{' && paired.has(i)) {
      depth++;
      out += '(?:';
    } else if (c === '}' && paired.has(i)) {
      depth--;
      out += ')';
    } else if (c === ',' && depth > 0) out += '|';
    else out += escapeRegExp(c);
  }
  try {
    return new RegExp(`^${out}$`, 'i');
  } catch {
    return new RegExp(`^${escapeRegExp(glob)}$`, 'i');
  }
}

/**
 * Diz se um ficheiro cai numa das zonas. Uma zona é um ficheiro, uma pasta (apanha tudo o que
 * está lá dentro) ou um glob; um glob também apanha o ficheiro se apanhar uma das pastas dele.
 */
export function zoneMatcher(entries: readonly string[]): (file: string) => boolean {
  const normalized = entries.map((entry) => normalize(entry).replace(/\/+$/, ''));
  // "." e `*` querem dizer a árvore toda: apanham qualquer ficheiro.
  if (normalized.some((entry) => entry === '')) return () => true;
  const patterns = normalized.map(globToRegExp);
  return (file) => {
    const segments = normalize(file).split('/').filter(Boolean);
    const prefixes = segments.map((_, i) => segments.slice(0, i + 1).join('/'));
    return patterns.some((pattern) => prefixes.some((prefix) => pattern.test(prefix)));
  };
}

/**
 * Os ficheiros fora do que o contrato da parte permite: fora de `allowed` ou dentro de
 * `forbidden`. Sem `allowed` (o contrato não diz onde mexer) só conta o `forbidden`; com "." ou
 * `*` a parte pode mexer em tudo.
 */
export function outOfScope(
  part: Pick<SplitPart, 'allowed' | 'forbidden'>,
  files: readonly string[],
): string[] {
  const allowed = zoneMatcher(part.allowed);
  const forbidden = zoneMatcher(part.forbidden);
  return files.filter((file) => forbidden(file) || (part.allowed.length > 0 && !allowed(file)));
}
