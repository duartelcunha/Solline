import {
  RULE_MAX_GLOBS,
  RuleGlob,
  type ProjectRule,
} from '@solline/protocol';

/** Os mesmos limites do motor (`packages/engine/src/rules/render.ts`): o aviso é dele, a medida é só um espelho. */
export const SIZE_WARN_LINES = 150;
export const SIZE_WARN_CHARS = 8_000;

/** Os padrões escritos numa linha (vírgulas) ou várias (uma por linha), sem repetir. */
export function parseGlobs(input: string): { globs: string[]; error: string | null } {
  const globs: string[] = [];
  for (const raw of input.split(/[\n,]/)) {
    const glob = raw.trim();
    if (glob && !globs.includes(glob)) globs.push(glob);
  }
  if (globs.length > RULE_MAX_GLOBS)
    return { globs, error: `No máximo ${RULE_MAX_GLOBS} padrões por regra.` };
  for (const glob of globs) {
    if (!RuleGlob.safeParse(glob).success)
      return {
        globs,
        error: `«${glob}» não serve: o padrão é relativo à pasta do projeto, sem .. nem caminhos absolutos.`,
      };
  }
  return { globs, error: null };
}

export function globsText(globs: readonly string[]): string {
  return globs.join(', ');
}

/** O que as regras que valem sempre pesam (as ligadas e sem padrões), como o motor as conta. */
export function alwaysOnSize(rules: readonly ProjectRule[]): { lines: number; chars: number } {
  const text = rules
    .filter((rule) => rule.enabled && rule.globs.length === 0)
    .map((rule) => `## ${rule.title}\n\n${rule.text.trim()}`)
    .join('\n\n');
  return { lines: text.length === 0 ? 0 : text.split('\n').length, chars: text.length };
}

/** A primeira linha do texto, para a linha da lista. */
export function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}
