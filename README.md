# Solline

App de desktop para trabalhar com agentes de código (Claude Code, Codex, modelos DeepSeek e qualquer agente ACP): o poder do terminal com a facilidade de uma app.
Por agora é para uso pessoal, no Windows.

## Estado

M1 (conversa a andar): projetos e sessões na barra lateral, conversa em streaming com
Markdown, thinking e ferramentas (com vista detalhada), cartões de permissão, plano e
pergunta, interromper, modelo, effort e modo por clique, custo e contexto ao vivo.
Se o Claude cair a meio, a sessão mostra "Retomar".

## Peças

- `apps/desktop`: Electron (main, preload e interface em React).
- `packages/engine`: o motor. Fala com o Agent SDK e corre em Node, sem Electron.
- `packages/protocol`: o contrato entre a interface e o motor, validado com zod.
- `packages/ui`: tokens de design (OKLCH) e as fontes Geist.

## Comandos

Precisa de Node 22.18 ou mais recente e do pnpm (vem com o `corepack`).

```sh
pnpm install
pnpm dev          # app em desenvolvimento
pnpm typecheck
pnpm lint
pnpm test         # testes do motor e smoke da app
pnpm dist         # instalador em apps/desktop/release
```

Os testes de integração do motor fazem sessões curtas e reais com Haiku (effort low) com o
login do Claude Code desta máquina. Para os saltar: `SOLLINE_SKIP_SDK=1 pnpm test`. O smoke
da app só faz a sessão real com `SOLLINE_E2E_SDK=1`; `SOLLINE_EXE=<caminho>` corre-o na app
instalada e `SOLLINE_SHOTS=<pasta>` guarda capturas.

Para gravar de novo as mensagens reais que os testes do normalizador usam:
`pnpm --filter @solline/engine record <cenário>` (os cenários estão no próprio script).
