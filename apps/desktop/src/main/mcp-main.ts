import { randomUUID } from 'node:crypto';
import type { McpCatalogServer, McpServerSpec, McpValues } from '@solline/protocol';

/** O id de um servidor novo: curto, em minúsculas, serve de nome do segredo no cofre. */
export function newServerId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

/**
 * Junta os valores que o utilizador deu aos dados do servidor: os das variáveis que não são
 * secretas ficam no catálogo (são públicos) e os secretos saem à parte, para o cofre. Uma
 * variável que o servidor não declara é recusada. `keep` guarda o valor público que já havia
 * quando se muda um servidor e não se deu outro.
 */
export function applyValues(
  spec: McpServerSpec,
  values: McpValues,
  keep: readonly McpServerSpec['env'][number][] = [],
): { spec: McpServerSpec; secrets: Record<string, string> } {
  const declared = new Set(spec.env.map((e) => e.name));
  for (const name of Object.keys(values))
    if (!declared.has(name)) throw new Error(`A variável ${name} não existe neste servidor`);
  const secrets: Record<string, string> = {};
  const env = spec.env.map((decl) => {
    const given = values[decl.name];
    if (decl.secret) {
      if (given !== undefined) secrets[decl.name] = given;
      const { value: _dropped, ...rest } = decl;
      return rest;
    }
    const kept = keep.find((old) => old.name === decl.name && !old.secret)?.value;
    const value = given ?? decl.value ?? kept;
    return value === undefined ? decl : { ...decl, value };
  });
  return { spec: { ...spec, env }, secrets };
}

/** O que a confirmação nativa mostra: exatamente o que a Solline vai arrancar. */
export function approvalPrompt(server: McpCatalogServer): {
  title: string;
  message: string;
  detail: string;
  acceptLabel: string;
  cancelLabel: string;
} {
  const names = server.spec.env.map((e) => e.name);
  const vars = names.length > 0 ? `com as variáveis ${names.join(', ')}` : 'sem variáveis';
  const source = server.spec.source;
  const origin =
    source.kind === 'registry'
      ? `Veio do registo oficial: ${source.name} ${source.version}` +
        (source.verified
          ? ` (dono verificado por ${source.verified === 'github' ? 'GitHub' : 'DNS'}).`
          : ' (dono sem verificação).')
      : 'Foi escrito por ti, à mão.';
  const common = [
    origin,
    'Corre como um programa no teu computador, com as tuas permissões, só nos projetos que o escolherem.',
    'As ferramentas nunca ficam com "Permitir sempre" e o servidor tira o Auto e o acesso total.',
    'Os valores secretos ficam no Gestor de Credenciais e só vão ao agente quando a sessão arranca.',
  ];
  if (server.changed) {
    const lines = [
      server.changed.added.length ? `Novas: ${server.changed.added.join(', ')}` : '',
      server.changed.removed.length ? `Tiradas: ${server.changed.removed.join(', ')}` : '',
      server.changed.altered.length ? `Alteradas: ${server.changed.altered.join(', ')}` : '',
    ].filter(Boolean);
    return {
      title: 'Ferramentas mudadas',
      message: `As ferramentas de ${server.spec.label} mudaram desde a última aprovação. Permitir \`${server.commandLine}\` ${vars}?`,
      detail: [...lines, '', ...common].join('\n'),
      acceptLabel: 'Permitir',
      cancelLabel: 'Não permitir',
    };
  }
  return {
    title: 'Servidor MCP',
    message: `A Solline vai arrancar \`${server.commandLine}\` ${vars}. Permitir?`,
    detail: common.join('\n'),
    acceptLabel: 'Permitir',
    cancelLabel: 'Não permitir',
  };
}
