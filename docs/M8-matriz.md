# Matriz de capacidades

O que o código faz, por marco. Atualiza-se quando um marco muda o estado. Não é uma medição com agentes.

| id | marco | estado | prova |
| --- | --- | --- | --- |
| bridge-zod | M0 | presente | `packages/protocol/src/bridge.ts` |
| utility-process | M0 | presente | `apps/desktop/src/main/engine-host.ts` |
| renderer-preload | M0 | presente | `apps/desktop/src/preload/index.ts` |
| claude-sdk | M1 | presente | `packages/engine/src/adapters/claude/sdk.ts` |
| codex-app-server | M1 | presente | `packages/engine/src/adapters/codex/adapter.ts` |
| acp-opencode | M1 | presente | `packages/engine/src/agents/catalog.ts` |
| subscription-login | M1 | presente | `packages/engine/src/agents/registry.ts` |
| neutral-conversation | M1 | presente | `packages/protocol/src/conversation.ts` |
| untrusted-settings | M1 | presente | `packages/engine/src/adapters/claude/sdk.ts` |
| capabilities | M1 | presente | `packages/protocol/src/conversation.ts` |
| checkpoint | M2 | presente | `packages/engine/src/checkpoints/store.ts` |
| hunk-review | M2 | presente | `apps/desktop/src/renderer/src/features/review/review-panel.tsx` |
| rewind | M2 | parcial | `packages/engine/src/session-manager.ts` |
| absolute-git | M2 | presente | `packages/engine/src/checkpoints/git.ts` |
| worktree | M3 | presente | `packages/engine/src/worktrees/worktrees.ts` |
| desk | M3 | presente | `apps/desktop/src/renderer/src/features/desk/desk.tsx` |
| queue-steer | M3 | parcial | `apps/desktop/src/renderer/src/features/conversation/queue.tsx` |
| setup-ports | M3 | presente | `packages/engine/src/workspace/setup.ts` |
| project-checks | M3 | presente | `packages/engine/src/checks/project-checks.ts` |
| race-lanes | M4 | presente | `packages/engine/src/races/race-manager.ts` |
| race-rank | M4 | presente | `packages/engine/src/races/rank.ts` |
| race-judge-vendor | M4 | parcial | `packages/engine/src/verify/judge.ts` |
| race-assemble | M4 | presente | `packages/engine/src/races/assembler.ts` |
| race-view | M4 | presente | `apps/desktop/src/renderer/src/features/race/race.tsx` |
| split-planner | M4.5 | presente | `packages/engine/src/races/planner.ts` |
| split-launch | M4.5 | presente | `packages/engine/src/races/split-manager.ts` |
| split-integrate | M4.5 | presente | `packages/engine/src/races/integration.ts` |
| split-gaps | M4.5 | ausente | `packages/engine/src/races/split-manager.ts` |
| second-opinion | M5 | presente | `packages/engine/src/quality/routing.ts` |
| handoff | M5 | presente | `packages/engine/src/handoff/drafter.ts` |
| fork | M5 | presente | `packages/engine/src/session-manager.ts` |
| lineage | M5 | presente | `apps/desktop/src/renderer/src/features/map/map-dialog.tsx` |
| handoff-draft-to-reviewer | M5 | ausente | `packages/engine/src/handoff/drafter.ts` |
| native-rules | M6 | presente | `packages/engine/src/rules/manager.ts` |
| no-md-autoload | M6 | presente | `packages/engine/src/adapters/claude/sdk.ts` |
| consult-no-bash | M6 | presente | `packages/engine/src/adapters/claude/sdk.ts` |
| consult-no-handoff | M6 | presente | `packages/engine/src/session-manager.ts` |
| memory-proof | M6 | presente | `packages/engine/src/memory/evidence.ts` |
| memory-one | M6 | presente | `packages/engine/src/memory/manager.ts` |
| ask-delegate | M6 | presente | `packages/engine/src/consult/manager.ts` |
| mcp-catalog | M6 | presente | `packages/engine/src/mcp/catalog.ts` |
| solline-mcp | M6 | presente | `packages/engine/src/brain/brain.ts` |
| github-issue | M7 | presente | `packages/engine/src/pull/issues.ts` |
| linear | M7 | parcial | `packages/protocol/src/pull.ts` |
| commit-no-push | M7 | presente | `packages/engine/src/session-manager.ts` |
| push-confirmed | M7 | presente | `apps/desktop/src/main/pull-confirm.ts` |
| ci-and-archive | M7 | presente | `packages/engine/src/engine.ts` |
| check-once | M7 | presente | `packages/protocol/src/checks.ts` |
| check-fix-loop | M8 | ausente | `packages/protocol/src/checks.ts` |
| usage-ledger | M8 | ausente | `packages/protocol/src/conversation.ts` |
| session-cost-display | M1 | parcial | `apps/desktop/src/renderer/src/features/composer/composer.tsx` |
| approval-judge | M8 | ausente | `packages/engine/src/verify/judge.ts` |
| model-routing | M8 | ausente | `packages/protocol/src/conversation.ts` |

## Notas

- `bridge-zod`. A ponte valida comandos com zod. A interface não fala com o SDK.
- `utility-process`. O motor corre num utilityProcess e liga ao main por MessagePort.
- `renderer-preload`. O renderer fala com window.solline. Não carrega Node.
- `claude-sdk`. Claude pelo SDK, com permissionMode explícito e ambiente saneado.
- `codex-app-server`. Codex pelo app-server da versão revista.
- `acp-opencode`. OpenCode entra pelo catálogo, na versão revista. Não há UI para juntar executáveis.
- `subscription-login`. Só agentes com login por subscrição. A Solline não guarda tokens.
- `neutral-conversation`. A conversa é um contrato neutro. A interface não lê tipos do SDK.
- `untrusted-settings`. Sem confiança, o Claude só lê as definições do utilizador.
- `capabilities`. Custo, contexto e retoma só se mostram quando o agente os reporta.
- `checkpoint`. Cada turno fica com um checkpoint num git sombra.
- `hunk-review`. O painel Rever aceita, rejeita e comenta hunk a hunk.
- `rewind`. Claude e Codex rebobinam no próprio agente. No ACP abre-se uma sessão nova com resumo.
- `absolute-git`. resolveGit() devolve o executável absoluto. Sem ele, não se chama git pelo nome.
- `worktree`. A sessão a mais de um projeto git ganha worktree e branch.
- `desk`. A mesa mostra um cartão vivo por sessão.
- `queue-steer`. A fila existe para qualquer agente. Guiar a meio do turno só quando ele o declara.
- `setup-ports`. A preparação espera aprovação. As portas estão em workspace/ports.ts.
- `project-checks`. As verificações correm no fim do turno, e só num projeto de confiança.
- `race-lanes`. Uma corrida abre 2 a 4 pistas, cada uma na sua worktree.
- `race-rank`. A ordenação segue a execução. O juiz só entra no empate.
- `race-judge-vendor`. O juiz cego das corridas é Claude. Não é um fabricante independente.
- `race-assemble`. O resultado monta-se hunk a hunk, a partir de várias pistas.
- `race-view`. As pistas vêem-se lado a lado.
- `split-planner`. O planeador é só de leitura e pode responder para não partir.
- `split-launch`. As partes lançam-se por fases, com contrato e avisos de âmbito.
- `split-integrate`. A integração é em série e o verificador corre depois de cada junção.
- `split-gaps`. Ainda falta bloquear a sessão de conflito, aligeirar a prévia, cancelar o planeador a meio e ligar as partes às tarefas.
- `second-opinion`. A segunda opinião pede outro fabricante quando há um disponível.
- `handoff`. A passagem abre um rascunho editável. Não envia sozinha.
- `fork`. Bifurcar cria uma sessão a partir de um turno com checkpoint. Sem checkpoint, falha.
- `lineage`. O mapa mostra a origem das sessões. Não escreve no projeto.
- `handoff-draft-to-reviewer`. O rascunho ainda não chega ao revisor da sessão que recebeu o testemunho.
- `native-rules`. As regras vivem no estado da Solline, gerais e por projeto, fora da pasta.
- `no-md-autoload`. CLAUDE.md e AGENTS.md não entram. No Codex, project_doc_max_bytes fica a 0.
- `consult-no-bash`. Uma consulta do Claude recusa Bash, Edit e Write. Não houve smoke com o binário real nesta máquina.
- `consult-no-handoff`. Uma consulta não passa o testemunho. Para continuar, abre-se uma sessão normal.
- `memory-proof`. Uma memória nova traz prova e fica pendente até aprovação.
- `memory-one`. Um lote com uma memória externa falha antes de aprovar qualquer uma.
- `ask-delegate`. Perguntar é só leitura. Delegar espera o cartão. A profundidade é 1.
- `mcp-catalog`. O catálogo global aprova o spec exato. Os segredos ficam no cofre.
- `solline-mcp`. O servidor MCP da Solline corre no motor e só segue depois do hello.
- `github-issue`. Uma issue do GitHub abre sessão com worktree, título e primeira mensagem. O gh é o da sessão local.
- `linear`. O contrato tem o provider linear. Não há cliente. O M7 lista issues pelo GitHub.
- `commit-no-push`. commit.save grava a mensagem na worktree. Não faz merge nem push.
- `push-confirmed`. A confirmação nativa mostra repositório e branch. Sem sim, o push não é pedido.
- `ci-and-archive`. ci.read só lê. Com o PR em merged, a sessão arquiva.
- `check-once`. checks.fix manda uma falha à fila, uma vez por clique. Não repete sozinho.
- `check-fix-loop`. Não há ciclo com orçamento, nem paragem depois de falhas equivalentes.
- `usage-ledger`. Não há livro por tarefa, execução e fase. O custo da sessão é o último total reportado.
- `session-cost-display`. O último costUsd aparece quando vem. null não se mostra como 0. Não há quota oficial.
- `approval-judge`. O juiz que existe desempata corridas. Não recomenda sobre um diff nem aprova envios.
- `model-routing`. O modelo muda por pedido. Não há percurso económico automático.
