# Estado do projeto

**Em uma frase:** app pessoal de Windows para trabalhar com agentes de código (Claude Code, Codex, ACP) no mesmo espaço.

**Estado:** 🟢 M6 implementado e no `main`; a seguir decidir os pontos abertos do M6 e começar o M7.

**Última atualização:** 2026-10-29, por Claude

## Onde está

- Ramo principal `main` (inclui todo o antigo `feat/m6-cerebro`). Nada por enviar.
- M6: regras, memória e consulta/delegação entre agentes
  (`packages/engine/src/rules/manager.ts`, `packages/engine/src/memory/manager.ts`,
  `packages/engine/src/consult/manager.ts`). Roadmap em `docs/visao.md` (M6, M7).
- O git é sempre chamado pelo caminho de `resolveGit()`, nunca pelo nome solto
  (teste em `packages/engine/test/git-resolution.test.ts`).

## Próximo passo

Decidir os pontos do M6 em aberto no `DECISIONS.md` (importação de regras, Bash nas consultas,
testemunho e bifurcação de consultas, aprovação em lote de memórias externas) e só depois começar o M7.

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
- Decisões mais antigas: `DECISIONS.md`.
