# Estado do projeto

**Em uma frase:** app pessoal de Windows para trabalhar com agentes de código (Claude Code, Codex, ACP) no mesmo espaço.

**Estado:** `main` atualizado com M6, M7, M8.0–M8.3 e PRs #9, #11, #12 (`c7a3489`) e #13 (`ca2b5b4`). Fase 1 (`feat/m8-5-omp-acp`) pronta para ensaio: `omp acp` v18.22.2 ligado com overlay de isolamento e `_session/steering`, harness M8.5 alargado com gate de entrada e ADR M9–M11 fechado.

**Última atualização:** 2026-11-19, por Duarte

## Onde está

- `main` em `ca2b5b4` (PRs #12 de Windows/git/gh e #13 de tokens do marco 5 fundidos após CI verde; PR #8 arquivado em `archive/m8-4-juiz`).
- Regras nativas, fora da pasta. A Solline não lê `CLAUDE.md` nem `AGENTS.md`.
- Consulta do Claude sem Bash. Uma consulta não passa o testemunho. Memórias externas não se aprovam em lote.
- Do pedido ao PR: issue do GitHub, commit sem push, confirmação nativa antes do push, CI só de leitura, sessão arquivada quando o PR entra. Linear não está ligado.
- Catálogo ACP suporta binários nativos (`omp acp` 18.22.2 com overlay `always-ask` e `_session/steering`) ao lado do OpenCode.
- Harness M8.5 em `packages/engine/src/pilot/harness.ts` inclui `wallMinutes`, `manualRecoveries`, `peakRssMb`, `coldStartMs` e `evaluatePilotGate`. Roadmap pós-M8.5 em `docs/ADR-roadmap-m9-m11.md`.

## Próximo passo

Correr o dry-run de 2 tarefas descartáveis com `omp acp` na Solline (permissões, `Ctrl+Enter` steer, Parar + Rebobinar, livro M8.2 e ciclo M8.3) e depois medir o piloto M8.5 nas 10 tarefas congeladas (`omp` terminal puro vs. `omp acp` na Solline com o mesmo modelo) para avaliar a entrada no M9.

## Comandos

```bash
corepack pnpm@10.34.6 install --frozen-lockfile
pnpm typecheck
pnpm lint
cd packages/engine && SOLLINE_SKIP_SDK=1 ../../node_modules/.bin/vitest run
cd apps/desktop && ../../node_modules/.bin/vitest run src/main
```

Os scripts da raiz chamam `corepack pnpm`, para funcionarem quando o pnpm só existe pelo Corepack. O `pnpm test` do desktop também constrói o Electron e corre o Playwright.

## Pronto quando

- Typecheck, lint e testes unitários do protocolo, motor e desktop passam; o smoke local `SOLLINE_AGENTS=omp` valida o handshake/overlay do `omp acp`; os números das 10 tarefas fecham o `evaluatePilotGate`.

## Bloqueios

- Falta apenas a corrida humana das 2 tarefas de dry-run e das 10 tarefas do corpus M8.5 com conta ativa no `omp`.

## Decisões

- 2026-10-29: `STATUS.md` é o ponto de retoma. O git do motor passa por `resolveGit()`.
- 2026-11-06: regras nativas, consulta sem Bash, consulta sem testemunho, memórias externas uma a uma. O M7 segue só com o GitHub.
- 2026-11-06: no M8, a métrica é trabalho aceite por hora de atenção; o modelo por omissão mantém-se; intenção e plano são objetos locais.
- 2026-11-19: `omp acp` entra com overlay `always-ask`; M9–M11 ficam em ADR (`docs/ADR-roadmap-m9-m11.md`) condicionados ao gate do M8.5 e ao orçamento de RAM/arranque. Detalhe em `DECISIONS.md`.
