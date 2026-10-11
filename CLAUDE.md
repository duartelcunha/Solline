# Solline

Cliente de desktop pessoal para o Claude Code. Projeto pessoal: nada de trabalho entra aqui.
O plano aprovado está em `~/.claude/plans/can-we-change-the-sequential-horizon.md` (secção
"Núcleo: desenho detalhado"). As decisões de versões estão em `DECISIONS.md`.

## Regras de arquitetura

1. Três peças, um só sentido de dependência: **motor** (`packages/engine`, Node, SDK, sessões)
   · **ponte** (`packages/protocol`, IPC tipada e validada com zod) · **interface**
   (`apps/desktop/src/renderer`, React).
2. A interface nunca toca no SDK nem no Node. Só fala com `window.solline`, que o preload
   expõe (contextIsolation, sandbox, sem nodeIntegration).
3. Tudo clicável: nenhuma função existe só por comando ou atalho; o teclado é o atalho.
4. O motor corre num `utilityProcess` e liga ao main por MessagePort. Testa-se em Node puro.
5. O nome da app vive só em `packages/protocol/src/app.ts`.

## Regras do SDK

- Passar sempre `permissionMode` explícito e `env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP }`.
- O SDK é só ESM: carregar com `import()` e manter fora do bundle do main.
- Na app instalada, `pathToClaudeCodeExecutable` aponta para `app.asar.unpacked`.

## Antes de dar por feito

`pnpm typecheck`, `pnpm lint` e `pnpm test` limpos. Commits em pt-PT, Conventional Commits.
