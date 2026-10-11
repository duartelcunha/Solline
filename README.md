# Solline

App de desktop para trabalhar com o Claude Code: o poder do terminal com a facilidade de uma app.
Por agora é para uso pessoal, no Windows.

## Estado

M0 (fundação): janela com tema claro e escuro, motor num processo à parte e instalador NSIS.
A conversa chega no M1.

## Peças

- `apps/desktop`: Electron (main, preload e interface em React).
- `packages/engine`: o motor. Fala com o Agent SDK e corre em Node, sem Electron.
- `packages/protocol`: o contrato entre a interface e o motor, validado com zod.
- `packages/ui`: tokens de design (OKLCH) e as fontes Geist.

## Comandos

Precisa de Node 22.12 ou mais recente e do pnpm (vem com o `corepack`).

```sh
pnpm install
pnpm dev          # app em desenvolvimento
pnpm typecheck
pnpm lint
pnpm test         # testes do motor e smoke da app
pnpm dist         # instalador em apps/desktop/release
```

O teste do motor e o botão "Testar motor" fazem uma chamada curta a Haiku com o login do
Claude Code desta máquina. Para saltar o teste: `SOLLINE_SKIP_SDK=1 pnpm test`.
