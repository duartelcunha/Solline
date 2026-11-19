# Estado do projeto

**Em uma frase:** app pessoal de Windows para trabalhar com agentes de código (Claude Code, Codex, ACP) no mesmo espaço.

**Estado:** M9, pipeline contínuo de QA em 3 camadas, automação de updates (Dependabot + `agent-watch.yml` + release NSIS/SHA-256) e verificador seguro de atualizações na app integrados em `main`.

**Última atualização:** 2026-11-19, por Duarte

## Onde está

- `main` inclui `omp acp` (`19.0.0`), M9 (microkernel interno, `CanonicalTaskState`, circuit breakers e decomposição), pipeline QA em 3 camadas (`ci.yml` `qa-fast`, `qa-full.yml`, `release.yml`), vigilância de dependências/agentes (`dependabot.yml`, `dependabot-automerge.yml`, `agent-watch.yml` + `scripts/check-updates.mjs`), harness QA reparado (`recovery-canary.mjs`, `verify.mjs`, `performance.mjs`) e verificador seguro de atualizações (`app.checkUpdate` / `app.installUpdate` em `Definições` com verificação SHA-256 e `PromptWindows`).
- Regras nativas, fora da pasta. A Solline não lê `CLAUDE.md` nem `AGENTS.md`. Memórias externas não se aprovam em lote.
- Do pedido ao PR: issue do GitHub, commit sem push, confirmação nativa antes do push, CI só de leitura, sessão arquivada quando o PR entra. Linear não está ligado.
- Roadmap e gates em `docs/ADR-roadmap-m9-m11.md` (M10 e M11 continuam bloqueados pelo gate empírico M8.5).

## Próximo passo

1. Correr o dry-run de 2 tarefas descartáveis e depois as 10 tarefas congeladas do piloto M8.5 (`omp` terminal vs. `omp acp` na Solline com o mesmo modelo) para fechar `evaluatePilotGate` antes de abrir o M10.

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

- Gate do M8.5 aprovado nas 10 tarefas congeladas para autorizar a entrada no M10 (`SurfaceBlock` + modo Foco/Código).

## Bloqueios

- Para o M10–M11: falta correr o piloto M8.5 (2 tarefas de dry-run + 10 tarefas congeladas) com conta ativa.

## Decisões

- 2026-10-29: `STATUS.md` é o ponto de retoma. O git do motor passa por `resolveGit()`.
- 2026-11-06: regras nativas, consulta sem Bash, consulta sem testemunho, memórias externas uma a uma. O M7 segue só com o GitHub.
- 2026-11-06: no M8, a métrica é trabalho aceite por hora de atenção; o modelo por omissão mantém-se; intenção e plano são objetos locais.
- 2026-11-19: `omp acp` com overlay `always-ask`; M9 (`c97099a`), pipeline QA em 3 camadas, Dependabot/`agent-watch.yml` e verificador SHA-256 na app integrados em `main`. Detalhe em `DECISIONS.md`.
