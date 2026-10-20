# Solline

Cliente de desktop pessoal para agentes de código (Claude Code, Codex, DeepSeek e agentes ACP). Projeto pessoal: nada de trabalho entra aqui.
A visão e os próximos marcos estão em `docs/visao.md`; o plano multi-agente (feito) em `docs/plano.md`. As decisões estão em
`DECISIONS.md`.

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
- Cada subida do Agent SDK corre também `SOLLINE_AGENTS=claude,claude:deepseek pnpm test`: o
  perfil DeepSeek usa o Claude Code com outra API e pode partir sem aviso.

## Antes de dar por feito

`pnpm typecheck`, `pnpm lint` e `pnpm test` limpos. Commits em pt-PT, Conventional Commits.
