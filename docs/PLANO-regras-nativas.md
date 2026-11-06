# Regras nativas, sem CLAUDE.md nem AGENTS.md

A decisão 1 não segue as opções do `docs/M6-decisoes.md`. As 2, 3 e 4 ficam para o commit a seguir, cada uma na opção 1.

## O que sai

Importar e exportar (`rules.import`, `rules.importNow`, `rules.export`, `rules.exportNow`, `importFiles`, a UI). A Solline deixa de ler `CLAUDE.md` e `AGENTS.md`: some o `nativeCoverage` e o `readProjectRules` do revisor.

## O que o agente deixa de receber sozinho

- Claude (SDK 0.3.304): o `CLAUDE.md` só entra com `settingSources` a incluir `project`. As sessões e as consultas mantêm `user`, `project` e `local` nos projetos de confiança (hooks, permissões e skills do `.claude/` ficam) e passam `settings.claudeMdExcludes` com `**/CLAUDE.md`, `**/CLAUDE.local.md`, `**/AGENTS.md` e `**/.claude/rules/**`. O `~/.claude/CLAUDE.md` também deixa de entrar: o exclude vale para a memória do utilizador. As definições (`settings.json`) não.
- Codex 0.163: o binário tem `project_doc_max_bytes = 32768`. O `thread/start`, o `resume` e o `fork` levam `project_doc_max_bytes: 0` e `project_doc_fallback_filenames: []`. O `config.toml` do projeto (sandbox, MCP) continua. O revisor é que já desliga o MCP.
- Um Read explícito do ficheiro não se bloqueia. O teste afirma as opções que o adaptador manda, nas sessões e nas consultas.

## O que fica no lugar

Regras no estado da Solline (já fora da pasta). Dois níveis: `global` e por projeto. O interruptor mantém-se. Globais primeiro, depois as do projeto, no mesmo `renderStart`. `rules.preview` devolve o texto de arranque do Claude, do Codex e do ACP. `rules.undo` repõe o estado anterior (até 30). Migração v1→v2: o texto fica; num projeto com `importedFrom`, as regras passam a desligadas, porque o estado não diz qual nasceu do ficheiro e qual foi escrita depois na app.

O revisor passa a receber esse texto, não os ficheiros.
