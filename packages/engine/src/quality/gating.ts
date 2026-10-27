import type { FileDiff } from '@solline/protocol';

/** Um turno que mude pelo menos tantas linhas (somadas e retiradas) merece segunda opinião. */
export const MIN_REVIEW_LINES = 20;

/**
 * Caminhos onde um erro custa caro: autenticação e sessões, segredos e tokens, ambiente,
 * base de dados, configuração, CI, o processo principal do Electron e permissões. Um turno
 * que lhes toque é revisto mesmo com uma linha.
 */
const SENSITIVE_WORD =
  /(^|[\\/._-])(oauth|auth|authn|authz|authentication|authorization|login|logout|signin|signup|session|sessions|token|tokens|secret|secrets|credential|credentials|password|passwords|permission|permissions|migration|migrations|schema|electron|preload)([\\/._-]|$)/;
const SENSITIVE_FILE: readonly RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/,
  /\.sql$/,
  /(^|\/)[^/]+\.config\.[^/]+$/,
  /(^|\/)package\.json$/,
  /(^|\/)\.github\/workflows\//,
  // O processo principal do Electron (o preload já está na lista de palavras acima). Só JS/TS:
  // em Java e Kotlin todo o código vive em src/main e não é por isso mais sensível.
  /(^|\/)src\/main\/.*\.[cm]?[jt]sx?$/,
];

/** Separa o camelCase e uniformiza as barras: userSession.ts passa a user/session.ts. */
function words(file: string): string {
  return file
    .replaceAll('\\', '/')
    .replace(/([a-z0-9])([A-Z])/g, '$1/$2')
    .toLowerCase();
}

export function isSensitivePath(file: string): boolean {
  const plain = file.replaceAll('\\', '/').toLowerCase();
  return SENSITIVE_FILE.some((re) => re.test(plain)) || SENSITIVE_WORD.test(words(file));
}

export interface ReviewWorth {
  worth: boolean;
  lines: number;
  /** Os caminhos sensíveis que o turno tocou. */
  sensitive: string[];
}

/**
 * Vale a pena rever este turno sozinho? Só se mudou 20 linhas ou mais, ou tocou num caminho
 * sensível. A pedido (ou antes de trazer o trabalho) revê-se sempre, sem passar por aqui.
 */
export function reviewWorth(diff: readonly FileDiff[]): ReviewWorth {
  const lines = diff.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  const sensitive = diff.filter((f) => isSensitivePath(f.path)).map((f) => f.path);
  return { worth: lines >= MIN_REVIEW_LINES || sensitive.length > 0, lines, sensitive };
}
