import {
  MCP_PROJECT_MAX,
  McpManualSpec,
  type McpCatalogServer,
  type McpRegistryResult,
  type McpSource,
  type McpToolChange,
  type McpValues,
  type SessionInfo,
} from '@solline/protocol';

export type StatusTone = 'ok' | 'wait' | 'bad';

export interface StatusInfo {
  label: string;
  tone: StatusTone;
  hint: string | null;
}

/** O estado de um servidor do catálogo em palavras: o que é, e o que falta fazer. */
export function statusInfo(server: McpCatalogServer): StatusInfo {
  switch (server.status) {
    case 'ready':
      return { label: 'Pronto', tone: 'ok', hint: null };
    case 'needs-approval':
      return {
        label: 'Por aprovar',
        tone: 'wait',
        hint: 'A Solline só arranca este programa depois de o aprovares.',
      };
    case 'changed':
      return {
        label: 'Precisa de nova aprovação',
        tone: 'wait',
        hint: 'As ferramentas mudaram desde que o aprovaste. Vê o que mudou antes de aprovar.',
      };
    case 'error':
      return {
        label: 'Com erro',
        tone: 'bad',
        hint: server.error ?? 'A última tentativa de o arrancar falhou.',
      };
  }
}

/** Precisa de um clique em «Aprovar»? */
export function needsApproval(server: McpCatalogServer): boolean {
  return server.status === 'needs-approval' || server.status === 'changed' || !server.approved;
}

export interface SourceInfo {
  kind: 'registry' | 'manual';
  /** O espaço de nomes no registo (`io.github.x/y`), ou «Acrescentado à mão». */
  title: string;
  version: string | null;
  /** Quem verificou o dono, em palavras; null se foi à mão. */
  verified: string | null;
}

export function verifiedLabel(verified: 'github' | 'dns' | null): string {
  if (verified === 'github') return 'Dono verificado pelo GitHub';
  if (verified === 'dns') return 'Dono verificado por DNS';
  return 'Dono não verificado';
}

export function sourceInfo(source: McpSource): SourceInfo {
  if (source.kind === 'manual')
    return { kind: 'manual', title: 'Acrescentado à mão', version: null, verified: null };
  return {
    kind: 'registry',
    title: source.name,
    version: source.version,
    verified: verifiedLabel(source.verified),
  };
}

/** O que mudou nas ferramentas, uma linha por grupo; vazio se nada mudou. */
export function changeLines(change: McpToolChange): { label: string; names: string[] }[] {
  return [
    { label: 'Novas', names: change.added },
    { label: 'Tiradas', names: change.removed },
    { label: 'Alteradas', names: change.altered },
  ].filter((group) => group.names.length > 0);
}

/** Argumentos escritos uma linha por argumento, sem linhas vazias. */
export function parseArgs(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export interface ManualEnvRow {
  name: string;
  secret: boolean;
  required: boolean;
  value: string;
}

export interface ManualForm {
  label: string;
  command: string;
  args: string;
  env: ManualEnvRow[];
}

export const emptyManual: ManualForm = { label: '', command: '', args: '', env: [] };

/** Valida o formulário «à mão» como o protocolo o faz; devolve o que enviar ou a primeira falha. */
export function buildManual(
  form: ManualForm,
): { ok: true; spec: McpManualSpec; values: McpValues } | { ok: false; error: string | null } {
  const env = form.env.filter((row) => row.name.trim() !== '');
  const parsed = McpManualSpec.safeParse({
    label: form.label.trim(),
    command: form.command.trim(),
    args: parseArgs(form.args),
    env: env.map((row) => ({
      name: row.name.trim(),
      secret: row.secret,
      required: row.required,
    })),
  });
  // Sem nome nem comando ainda não há nada a reclamar: o botão fica desligado em silêncio.
  if (!form.label.trim() || !form.command.trim()) return { ok: false, error: null };
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Inválido' };
  const values: McpValues = {};
  for (const row of env) if (row.value !== '') values[row.name.trim()] = row.value;
  const missing = env.find((row) => row.required && row.value === '');
  if (missing) return { ok: false, error: `Falta o valor de ${missing.name.trim()}.` };
  return { ok: true, spec: parsed.data, values };
}

/** As variáveis que o registo pede, prontas para preencher. */
export function registryRows(result: McpRegistryResult): ManualEnvRow[] {
  return result.env.map((env) => ({
    name: env.name,
    secret: env.secret,
    required: env.required,
    value: '',
  }));
}

/** Os valores preenchidos (e só esses) e se falta alguma obrigatória. */
export function filledValues(rows: readonly ManualEnvRow[]): {
  values: McpValues;
  missing: string | null;
} {
  const values: McpValues = {};
  for (const row of rows) if (row.value !== '') values[row.name] = row.value;
  return { values, missing: rows.find((row) => row.required && row.value === '')?.name ?? null };
}

/** O servidor do registo já está no catálogo? (mesmo nome do registo, qualquer versão) */
export function alreadyAdded(
  servers: readonly McpCatalogServer[],
  result: McpRegistryResult,
): McpCatalogServer | undefined {
  return servers.find(
    (server) => server.spec.source.kind === 'registry' && server.spec.source.name === result.name,
  );
}

export function projectSelection(
  projects: Record<string, string[]>,
  projectId: string,
  servers: readonly McpCatalogServer[],
): string[] {
  // Só contam os que ainda existem no catálogo.
  return (projects[projectId] ?? []).filter((id) => servers.some((s) => s.id === id));
}

/** Liga ou desliga um servidor na escolha do projeto, sem passar do limite. */
export function toggleSelection(current: readonly string[], id: string): string[] {
  if (current.includes(id)) return current.filter((value) => value !== id);
  return current.length >= MCP_PROJECT_MAX ? [...current] : [...current, id];
}

export function atLimit(selection: readonly string[]): boolean {
  return selection.length >= MCP_PROJECT_MAX;
}

type Skipped = NonNullable<SessionInfo['mcpSkipped']>[number]['reason'];

export const SKIP_REASON: Record<Skipped, string> = {
  'needs-approval': 'precisa de aprovação',
  changed: 'as ferramentas mudaram e precisa de nova aprovação',
  error: 'não arrancou',
  unavailable: 'não está disponível',
  'restricted-mode': 'este modo não deixa correr programas externos',
  limit: 'passa do limite de 8 servidores',
};

/** A linha discreta de uma sessão com servidores do projeto de fora. */
export function skippedLine(
  skipped: NonNullable<SessionInfo['mcpSkipped']>,
  labelOf: (id: string) => string,
): string {
  const items = skipped.map((s) => `${labelOf(s.id)} (${SKIP_REASON[s.reason]})`);
  return `${skipped.length === 1 ? '1 servidor MCP do projeto ficou' : `${skipped.length} servidores MCP do projeto ficaram`} de fora: ${items.join(', ')}.`;
}
