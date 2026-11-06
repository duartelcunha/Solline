# Estado do projeto

**Em uma frase:** app pessoal de Windows para trabalhar com agentes de código (Claude Code, Codex, ACP) no mesmo espaço.

**Estado:** 🟢 M6 fechado no ramo do PR #2, com as quatro decisões do Duarte; a seguir o M7, quando ele o pedir.

**Última atualização:** 2026-11-06, por Duarte

## Onde está

- O `main` tem o M6. O ramo `cursor/m6-decisoes-m7-plano-5567` (PR #2) traz as quatro decisões.
- Regras nativas, fora da pasta: gerais e por projeto, com desfazer e pré-visualização. A Solline não lê `CLAUDE.md` nem `AGENTS.md`.
- Consulta do Claude sem Bash (`disallowedTools`). Uma consulta não passa o testemunho. Memórias externas não se aprovam em lote.
- O git das worktrees só corre pelo caminho de `resolveGit()`.

## Próximo passo

O M7 (do pedido ao PR), quando o Duarte o pedir. O plano está em `docs/M7-plano.md`. As quatro decisões do M6 estão fechadas (`DECISIONS.md`, 2026-11-06).

## Comandos

O `pnpm` não está instalado no PC: instalar com `corepack pnpm@10.34.6 install --frozen-lockfile`
e correr os binários de `node_modules/.bin` da raiz.

```bash
corepack pnpm@10.34.6 install --frozen-lockfile
cd packages/engine && ../../node_modules/.bin/vitest run
cd apps/desktop && ../../node_modules/.bin/vitest run src/main
cd apps/desktop && ../../node_modules/.bin/tsc -p tsconfig.node.json --noEmit && ../../node_modules/.bin/tsc -p tsconfig.web.json --noEmit
cd apps/desktop && ../../node_modules/.bin/eslint .
```

## Pronto quando

- Os 4 comandos acima passam (a 2026-10-29: motor 773 testes, desktop 136, tsc e eslint limpos).

## Bloqueios

- Nenhum. Por fazer, sem data: CI com typecheck, lint e testes (`SOLLINE_SKIP_SDK=1`); decidir o ramo `dc/trusting-swirles-47651a` (5 commits do Gemini CLI).

## Decisões

- 2026-10-29: `STATUS.md` passa a ser o ponto de retoma; os antigos `tasks/*` e `docs/claude-handoff.md` estão em `docs/arquivo/`.
- 2026-10-29: o git do motor passa por `resolveGit()`, para um repositório aberto não poder pôr um `git.exe` seu à frente.
- 2026-11-06: regras nativas (gerais e por projeto), sem ler `CLAUDE.md` nem `AGENTS.md`. Consulta do Claude sem Bash. Uma consulta não passa o testemunho. Memórias externas não se aprovam em lote. Detalhe em `DECISIONS.md`.
- Decisões mais antigas: `DECISIONS.md`.
