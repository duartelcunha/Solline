import {
  RULE_MAX_GLOBS,
  RuleGlob,
  type NativeRuleFile,
  type ProjectRule,
  type RulesConflict,
  type RulesImportResult,
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

const FILE_STATE: Record<RulesImportResult['files'][number]['state'], string> = {
  read: 'lido',
  missing: 'não existe',
  exported: 'é uma exportação da Solline por editar, não há nada a importar',
  unsafe: 'não é um ficheiro normal, não o li',
};

const SKIP_REASON: Record<RulesImportResult['skipped'][number]['reason'], string> = {
  duplicate: 'já existia',
  empty: 'estava vazia',
  'too-long': 'era comprida demais',
  limit: 'passava o limite de regras',
};

/** O resultado de importar, numa frase curta mais uma linha por ficheiro e por regra deixada de fora. */
export function importSummary(result: RulesImportResult): { headline: string; details: string[] } {
  const count = result.imported.length;
  const headline =
    count === 0
      ? 'Não havia regras novas para importar.'
      : count === 1
        ? 'Importei 1 regra.'
        : `Importei ${count} regras.`;
  return {
    headline,
    details: [
      ...result.files.map((file) => `${file.name}: ${FILE_STATE[file.state]}`),
      ...result.skipped.map((item) => `«${item.title}» ${SKIP_REASON[item.reason]}`),
    ],
  };
}

/** O nome do ficheiro de um conflito, se for um dos dois que a Solline sabe importar. */
export function conflictFile(conflict: RulesConflict): NativeRuleFile | null {
  const name = conflict.path.split(/[\\/]/).at(-1);
  return name === 'AGENTS.md' || name === 'CLAUDE.md' ? name : null;
}

export const CONFLICT_REASON: Record<RulesConflict['reason'], string> = {
  unmarked: 'Este ficheiro foi escrito à mão e a Solline não escreve por cima.',
  edited:
    'Alguém editou este ficheiro depois da última exportação e a Solline não escreve por cima.',
  unsafe: 'Este caminho não é um ficheiro normal (é uma ligação ou uma pasta).',
};
