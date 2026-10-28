import { createHash } from 'node:crypto';
import { hasHiddenChars, type McpServerSpec } from '@solline/protocol';

/** Um argumento com espaços ou aspas vai entre aspas, só para se ler (nunca se corre por shell). */
function shown(arg: string): string {
  return /^[A-Za-z0-9@._:/=+,~%-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

/** O comando como será arrancado, para mostrar e aprovar. */
export function commandLine(spec: Pick<McpServerSpec, 'command' | 'args'>): string {
  return [spec.command, ...spec.args].map(shown).join(' ');
}

/** JSON com as chaves por ordem, para a mesma coisa dar sempre a mesma impressão. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * A impressão do que se aprova: comando, argumentos e variáveis (nome, se é secreta e, nas que
 * não são, o valor, que é público). O rótulo e a origem não contam: mudá-los não muda o que corre.
 */
export function fingerprint(spec: McpServerSpec): string {
  return sha256(
    canonical({
      command: spec.command,
      args: spec.args,
      env: [...spec.env]
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((e) => ({
          name: e.name,
          secret: e.secret,
          required: e.required,
          ...(e.secret ? {} : { value: e.value ?? null }),
        })),
    }),
  );
}

/** Texto de um servidor (nome, descrição): uma linha, sem controlo nem invisíveis, com limite. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const char of value.normalize('NFC')) {
    if (hasHiddenChars(char)) {
      if (!out.endsWith(' ')) out += ' ';
      continue;
    }
    out += char;
  }
  const trimmed = out.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Uma ferramenta como se guarda: o que se mostra e a impressão dela inteira (com o esquema). */
export interface ToolPrint {
  name: string;
  description: string;
  hash: string;
}

/** A impressão de uma ferramenta tal como o servidor a anunciou (nome, descrição, esquema, anotações). */
export function toolPrint(tool: {
  name: string;
  description?: unknown;
  inputSchema?: unknown;
  annotations?: unknown;
}): ToolPrint {
  return {
    name: cleanText(tool.name, 128),
    description: cleanText(tool.description, 300),
    hash: sha256(
      canonical({
        name: tool.name,
        description: tool.description ?? null,
        inputSchema: tool.inputSchema ?? null,
        annotations: tool.annotations ?? null,
      }),
    ),
  };
}

/** A impressão do conjunto: muda se uma ferramenta aparece, some ou muda de qualquer maneira. */
export function toolsFingerprint(tools: readonly ToolPrint[]): string {
  return sha256(
    canonical(
      [...tools]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((t) => ({ name: t.name, hash: t.hash })),
    ),
  );
}

/** O que mudou entre duas listas de ferramentas. */
export function diffTools(
  before: readonly ToolPrint[],
  after: readonly ToolPrint[],
): { added: string[]; removed: string[]; altered: string[] } {
  const was = new Map(before.map((t) => [t.name, t.hash]));
  const is = new Map(after.map((t) => [t.name, t.hash]));
  return {
    added: [...is.keys()].filter((n) => !was.has(n)),
    removed: [...was.keys()].filter((n) => !is.has(n)),
    altered: [...is.keys()].filter((n) => was.has(n) && was.get(n) !== is.get(n)),
  };
}

/**
 * Tira dos textos (erros, saída do servidor) os valores dos segredos, para nunca irem a eventos,
 * ficheiros nem mensagens. Valores com menos de 3 caracteres não se procuram (apanhariam tudo).
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length < 3) continue;
    out = out.split(secret).join('***');
  }
  return out;
}
