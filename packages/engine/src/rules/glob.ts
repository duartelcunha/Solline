/**
 * Padrões de ficheiro das regras do projeto, relativos à raiz. Pequeno de propósito (o repositório
 * não tem uma biblioteca de glob como dependência direta):
 *   *       qualquer coisa dentro de um nome de pasta ou de ficheiro
 *   **      qualquer número de pastas (`src/**`, `**\/x.ts`)
 *   ?       um carácter
 *   {a,b}   uma de várias alternativas
 *   [abc]   um carácter de um conjunto (`[!abc]` ou `[^abc]` para o contrário)
 * Sem barra, o padrão vale em qualquer pasta (`*.ts` apanha `src/a/b.ts`); uma barra no fim
 * (`build/`) é a pasta toda.
 */

const SPECIAL = /[\\^$.*+?()[\]{}|/]/g;

function escape(text: string): string {
  return text.replace(SPECIAL, '\\$&');
}

function balanced(glob: string): boolean {
  let depth = 0;
  for (const char of glob) {
    if (char === '{') depth++;
    if (char === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

function translate(glob: string): string {
  const braces = balanced(glob);
  let depth = 0;
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const char = glob.charAt(i);
    if (char === '*') {
      let j = i;
      while (glob.charAt(j) === '*') j++;
      const stars = j - i;
      const atSegmentStart = i === 0 || glob.charAt(i - 1) === '/';
      if (stars >= 2 && atSegmentStart && glob.charAt(j) === '/') {
        out += '(?:.*/)?';
        i = j + 1;
      } else if (stars >= 2 && atSegmentStart && j === glob.length) {
        out += '.*';
        i = j;
      } else {
        out += '[^/]*';
        i = j;
      }
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      i++;
      continue;
    }
    if (braces && char === '{') {
      depth++;
      out += '(?:';
      i++;
      continue;
    }
    if (braces && depth > 0 && char === ',') {
      out += '|';
      i++;
      continue;
    }
    if (braces && depth > 0 && char === '}') {
      depth--;
      out += ')';
      i++;
      continue;
    }
    if (char === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close > i) {
        let inner = glob.slice(i + 1, close);
        const negate = inner.startsWith('!') || inner.startsWith('^');
        if (negate) inner = inner.slice(1);
        out += `[${negate ? '^' : ''}${inner.replace(/[\\\]^]/g, '\\$&')}]`;
        i = close + 1;
        continue;
      }
    }
    out += escape(char);
    i++;
  }
  return out;
}

const cache = new Map<string, RegExp>();

/** O padrão como expressão regular, ancorada na raiz do projeto. */
export function globToRegExp(glob: string, caseInsensitive = process.platform === 'win32'): RegExp {
  const key = `${caseInsensitive ? 'i' : 's'}:${glob}`;
  const known = cache.get(key);
  if (known) return known;
  let pattern = glob.trim().replace(/\\/g, '/');
  while (pattern.startsWith('./')) pattern = pattern.slice(2);
  const anchored = pattern.startsWith('/') || pattern.replace(/\/+$/, '').includes('/');
  pattern = pattern.replace(/^\/+/, '');
  if (pattern.endsWith('/')) pattern += '**';
  const body = translate(pattern);
  const regex = new RegExp(
    `^${anchored ? '' : '(?:.*/)?'}(?:${body})$`,
    caseInsensitive ? 'i' : '',
  );
  cache.set(key, regex);
  return regex;
}

function normalize(file: string): string {
  let path = file.replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  return path.replace(/^\/+/, '');
}

export function matchesGlob(glob: string, file: string): boolean {
  return globToRegExp(glob).test(normalize(file));
}

/** O ficheiro casa com algum dos padrões (a lista vazia não casa com nada). */
export function matchesAny(globs: readonly string[], file: string): boolean {
  const path = normalize(file);
  return globs.some((glob) => globToRegExp(glob).test(path));
}
