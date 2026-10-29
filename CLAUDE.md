# Solline

@AGENTS.md

Cliente de desktop pessoal para agentes de código (Claude Code, Codex e agentes ACP). Projeto pessoal: nada de trabalho entra aqui.
A visão e os próximos marcos estão em `docs/visao.md`; o plano multi-agente (feito) em `docs/plano.md`. As decisões estão em
`DECISIONS.md`.

## Norte (ler antes de tudo)

A Solline tem de ser melhor do que qualquer harness sozinho: tudo o que o Claude Code, o Codex, o
Cursor, o Conductor e os outros fazem bem, feito melhor, mais o que só existe quando se juntam.
Cada decisão mede-se em cinco coisas:

1. **Ver:** percebe-se de relance, sem ler paredes de texto.
2. **Trabalhar:** menos cliques e menos espera do que em qualquer outra ferramenta para o mesmo
   resultado.
3. **Qualidade do resultado:** o código final sai melhor (checkpoints, revisor, verificações), não
   só mais depressa.
4. **Sinergia:** cada peça nova usa e reforça as outras (a worktree dá ao revisor e às verificações
   uma pasta limpa; o cartão da mesa mostra as verificações e o revisor; a fila usa os checkpoints).
5. **Calma:** a Solline anda ao ritmo de quem pensa, não ao da máquina. Rápida a responder ao
   teu clique, nunca a apressar-te: nada pisca, salta ou apita sem razão, os avisos esperam até
   fazerem falta, não há contadores a correr nem "responde já". Devagar onde a pressa estraga
   (trazer, rebobinar, apagar pedem um segundo de atenção), depressa onde só poupa tempo.
   Acompanha o que sai no mundo dos agentes, mas só entra o que já provou valer, e entra bem feito.

Antes de desenhar: que harness faz isto melhor hoje, e como o fazemos melhor e ligado ao resto?
Sem resposta, não entra.

**/grilling em tudo:** arquitetura, codebase, design, marca, funcionalidades, ideias e as skills a
usar passam por uma ronda de /grilling com o Duarte antes de se fazerem. As perguntas partem de
factos (capturas, código, auditorias), cada uma com a resposta recomendada.

**/deep-research antes de mecânicas grandes:** um marco ou uma mecânica nova começa por uma
passagem de /deep-research (o que os melhores fazem, o que falha, a evidência). Só depois vêm o
grilling, com as conclusões, e o plano. O relatório fica fora do repositório.

## Regras de arquitetura

1. Três peças, um só sentido de dependência: **motor** (`packages/engine`, Node, SDK, sessões)
   · **ponte** (`packages/protocol`, IPC tipada e validada com zod) · **interface**
   (`apps/desktop/src/renderer`, React).
2. A interface nunca toca no SDK nem no Node. Só fala com `window.solline`, que o preload
   expõe (contextIsolation, sandbox, sem nodeIntegration).
3. Tudo clicável: nenhuma função existe só por comando ou atalho; o teclado é o atalho.
4. O motor corre num `utilityProcess` e liga ao main por MessagePort. Testa-se em Node puro.
   Nenhum agente corre como Electron-as-node: os fuses tiram o `runAsNode`, o `NODE_OPTIONS` e o
   `--inspect` ao executável da app.
5. O nome da app vive só em `packages/protocol/src/app.ts`.

## Regras do SDK

- Passar sempre `permissionMode` explícito e o ambiente de `sanitizedEnv()` (tira as variáveis de
  uma sessão anfitriã do Claude Code e junta `CLAUDE_AGENT_SDK_CLIENT_APP`).
- O contrato é neutro: cada agente é um `AgentAdapter` (`packages/engine/src/adapters`) que
  traduz para o modelo de `packages/protocol/src/conversation.ts`. A interface só lê isso e
  as `capabilities()` do agente.
- Custo: mostrar o último `total_cost_usd`, nunca somar. A verdade do modelo e do modo vem do
  `system/init` e do `system/status`.
- O SDK é só ESM: carregar com `import()` e manter fora do bundle do main.
- Na app instalada, `pathToClaudeCodeExecutable` aponta para `app.asar.unpacked`.
- Só entram agentes com login por subscrição, feito pelo próprio agente dentro da Solline.
  A Solline nunca lê nem guarda tokens; agentes que só aceitam chave de API ficam de fora.

## Antes de dar por feito

`pnpm typecheck`, `pnpm lint` e `pnpm test` limpos. Commits em pt-PT, Conventional Commits.
