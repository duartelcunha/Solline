import type { ProjectRule, RulesWarning } from '@solline/protocol';

/**
 * As regras do projeto escritas para cada destino. Funções puras: o texto das regras é sempre do
 * utilizador, a Solline só põe a moldura à volta.
 *
 *   instructions  o agente tem um canal de instruções (Claude: prompt de sistema; Codex:
 *                 developerInstructions). O bloco vai no arranque da sessão.
 *   context       o agente só tem mensagens (ACP): o bloco segue com a primeira mensagem.
 */
export type RuleTarget = 'instructions' | 'context';

export const START_TITLE = 'Regras do projeto (Solline)';
/** O título da secção com o índice; a importação reconhece-o e não o trata como uma regra. */
export const INDEX_TITLE = 'Regras para ficheiros específicos';

/** Acima disto as regras sem padrões ficam compridas demais (os agentes seguem-nas pior). */
export const LENGTH_WARN_LINES = 150;
export const LENGTH_WARN_CHARS = 8_000;

export const READ_RULE_TOOL = 'read_rule';

export interface SplitRules {
  /** Valem sempre: vão inteiras. */
  unscoped: ProjectRule[];
  /** Com padrões: só o índice, e a regra inteira ao tocar num ficheiro que case. */
  scoped: ProjectRule[];
}

export function splitRules(rules: readonly ProjectRule[]): SplitRules {
  const enabled = rules.filter((rule) => rule.enabled);
  return {
    unscoped: enabled.filter((rule) => rule.globs.length === 0),
    scoped: enabled.filter((rule) => rule.globs.length > 0),
  };
}

function section(rule: ProjectRule): string {
  return `## ${rule.title}\n\n${rule.text.trim()}`;
}

function indexLine(rule: ProjectRule, how: string): string {
  const patterns = rule.globs.map((glob) => `\`${glob}\``).join(', ');
  return `- ${rule.title} (id ${rule.id}): ${patterns}. ${how}`;
}

const READ_HOW = 'Lê com a ferramenta read_rule quando editares estes ficheiros.';
const AUTO_HOW = 'Aplica-se quando editares estes ficheiros.';
/** Nos ficheiros exportados não se sabe se quem lê tem a ferramenta. */
const EXPORT_HOW = 'Lê com a ferramenta read_rule (se a tiveres) quando editares estes ficheiros.';

function indexOf(scoped: readonly ProjectRule[], how: string): string {
  return `## ${INDEX_TITLE}\n\n${scoped.map((rule) => indexLine(rule, how)).join('\n')}`;
}

/**
 * O bloco do arranque: as regras sem padrões inteiras e o índice das outras. `readTool` diz se o
 * agente tem a ferramenta read_rule (sem ela, o índice só avisa que a regra entra ao editar).
 */
export function renderStart(
  rules: readonly ProjectRule[],
  options: { target: RuleTarget; readTool: boolean },
): string | undefined {
  const { unscoped, scoped } = splitRules(rules);
  if (unscoped.length === 0 && scoped.length === 0) return undefined;
  const lead =
    options.target === 'instructions'
      ? 'Escritas pelo utilizador para este projeto. Segue-as.'
      : 'Contexto da Solline, não é uma mensagem do utilizador: as regras que ele escreveu para este projeto. Segue-as.';
  const parts = [`# ${START_TITLE}`, lead, ...unscoped.map(section)];
  if (scoped.length > 0) parts.push(indexOf(scoped, options.readTool ? READ_HOW : AUTO_HOW));
  return parts.join('\n\n');
}

/** As regras com padrões que o agente acabou de tocar: seguem inteiras com a próxima mensagem. */
export function renderTouched(rules: readonly ProjectRule[]): string | undefined {
  if (rules.length === 0) return undefined;
  return [
    `# ${START_TITLE}`,
    'Contexto da Solline, não é uma mensagem do utilizador: regras do projeto que se aplicam a ficheiros que acabaste de editar.',
    ...rules.map(section),
  ].join('\n\n');
}

/** O corpo do AGENTS.md exportado (o marcador com o hash é posto por quem escreve o ficheiro). */
export function renderAgentsMd(rules: readonly ProjectRule[]): string {
  const { unscoped, scoped } = splitRules(rules);
  const parts = [
    '<!-- Gerado pela Solline. Edita as regras na app; este ficheiro só é reescrito enquanto não o editares. -->',
    '# Regras do projeto',
    ...unscoped.map(section),
  ];
  if (scoped.length > 0) parts.push(indexOf(scoped, EXPORT_HOW));
  return `${parts.join('\n\n')}\n`;
}

/** O corpo do CLAUDE.md exportado: o Claude Code importa o AGENTS.md. */
export function renderClaudeMd(): string {
  return '@AGENTS.md\n';
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

/** O aviso de tamanho: só conta as regras sem padrões, que vão sempre inteiras. Nunca bloqueia. */
export function lengthWarning(rules: readonly ProjectRule[]): RulesWarning | undefined {
  const { unscoped } = splitRules(rules);
  if (unscoped.length === 0) return undefined;
  const text = unscoped.map(section).join('\n\n');
  const lines = lineCount(text);
  if (lines <= LENGTH_WARN_LINES && text.length <= LENGTH_WARN_CHARS) return undefined;
  return {
    kind: 'length',
    text:
      `As regras sem padrões somam ${lines} linhas e ${text.length} caracteres, e os agentes ` +
      `seguem melhor regras curtas (até cerca de ${LENGTH_WARN_LINES} linhas). Dá padrões de ` +
      'ficheiro às que só valem para uma parte do projeto, ou encurta.',
  };
}

/** O aviso de quem importou de um ficheiro escrito à mão que ainda pode estar na pasta. */
export function nativeWarning(importedFrom: readonly string[]): RulesWarning | undefined {
  if (importedFrom.length === 0) return undefined;
  return {
    kind: 'native',
    text:
      `Importaste regras de ${importedFrom.join(' e ')}. Se o ficheiro continuar na pasta, o ` +
      'agente pode ver as regras duas vezes.',
  };
}
