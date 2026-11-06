import type { JsonValue } from './protocol/serde_json/JsonValue';

/**
 * O Codex 0.163 lê o AGENTS.md da pasta com `project_doc_max_bytes` (omissão 32768, visto no
 * binário). Zero e uma lista vazia de nomes fazem o thread não carregar esse ficheiro.
 * O config.toml do projeto (sandbox, MCP) não entra aqui.
 */
export const NO_PROJECT_DOC: Record<string, JsonValue> = {
  project_doc_max_bytes: 0,
  project_doc_fallback_filenames: [],
};
