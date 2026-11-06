# Estado do projeto

**Em uma frase:** app pessoal de Windows para trabalhar com agentes de código (Claude Code, Codex, ACP) no mesmo espaço.

**Estado:** M6 e M7 no `main` (`ca95a44`). M8.0 feito: verdade, matriz, corpus e harness. Sem medição com clientes reais. M8.1 não começou.

**Última atualização:** 2026-11-06, por Duarte

## Onde está

- `main` inclui o M6 (`9a85f61`) e o M7 (`ca95a44`). O M8.0 está no plano `docs/M8-plano.md`.
- Regras nativas, fora da pasta. A Solline não lê `CLAUDE.md` nem `AGENTS.md`.
- Consulta do Claude sem Bash. Uma consulta não passa o testemunho. Memórias externas não se aprovam em lote.
- Do pedido ao PR: issue do GitHub, commit sem push, confirmação nativa antes do push, CI só de leitura, sessão arquivada quando o PR entra. Linear não está ligado.
- Matriz em `docs/M8-matriz.md`. Corpus de 42 tarefas e harness em `packages/engine/src/pilot`. Sem cliente de modelo, a linha de base fica por medir.

## Próximo passo

M8.1: hierarquia da sessão, controlos raros recolhidos, texto sem cortes essenciais, contraste e resumo do turno. Plano em `docs/M8-plano.md`, ainda por escrever nessa fatia.

## Comandos

```bash
corepack pnpm@10.34.6 install --frozen-lockfile
pnpm typecheck
pnpm lint
cd packages/engine && SOLLINE_SKIP_SDK=1 ../../node_modules/.bin/vitest run
cd apps/desktop && ../../node_modules/.bin/vitest run
```

O `pnpm test` do desktop também constrói o Electron e corre o Playwright. Nesta máquina Linux isso não substitui o smoke de Windows.

## Pronto quando

- Typecheck, lint e os testes unitários do motor e do desktop passam. Os números desta fatia ficam no PR, não aqui.

## Bloqueios

- GitHub Actions desta conta está bloqueado por faturação. A prova é local.
- Sem cliente de modelo aqui: a linha de base do M8.0 não mediu aceitação, atenção nem tokens.
- Por decidir, sem data: o ramo `dc/trusting-swirles-47651a` (5 commits do Gemini CLI).

## Decisões

- 2026-10-29: `STATUS.md` é o ponto de retoma. O git do motor passa por `resolveGit()`.
- 2026-11-06: regras nativas, consulta sem Bash, consulta sem testemunho, memórias externas uma a uma. O M7 segue só com o GitHub.
- 2026-11-06: no M8, a métrica é trabalho aceite por hora de atenção; o juiz fica em sombra; o modelo por omissão mantém-se; intenção e plano são objetos locais.
- Decisões mais antigas: `DECISIONS.md`.
