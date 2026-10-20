# Solline

App de desktop para trabalhar com agentes de código com login por subscrição (Claude Code, Codex e agentes ACP): o poder do terminal com a facilidade de uma app.
Por agora é para uso pessoal, no Windows.

## Estado

M1 (conversa a andar) mais o plano multi-agente (`docs/plano.md`), de M1b a M1h:

- **Agentes:** Claude Code (Agent SDK), Codex (`codex app-server`, com "Entrar com ChatGPT" na
  app) e qualquer agente ACP do catálogo (OpenCode primeiro). Só entram agentes com login por
  subscrição; os que vivem só de uma chave de API ficam de fora. Escolhe-se na nova sessão;
  o painel de agentes mostra o estado e as variáveis que cada agente ACP recebe.
- **Confiança:** a interface só manda ids; projetos sem confiança não leem a config da pasta;
  cada agente recebe só os segredos que declara; modos de acesso total nunca aparecem.
- **Servidores MCP por sessão** de um catálogo revisto (REA opcional), sem tocar nas configs
  globais dos agentes.

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
login do Claude Code desta máquina. Para os saltar: `SOLLINE_SKIP_SDK=1 pnpm test`.
`SOLLINE_AGENTS=claude,codex` escolhe que agentes correm a sério (o Codex gasta quota do
ChatGPT). `SOLLINE_E2E_CODEX=1` abre uma sessão Codex no smoke. O smoke
da app só faz a sessão real com `SOLLINE_E2E_SDK=1`; `SOLLINE_EXE=<caminho>` corre-o na app
instalada e `SOLLINE_SHOTS=<pasta>` guarda capturas.

Para gravar de novo as mensagens reais que os testes do normalizador usam:
`pnpm --filter @solline/engine record <cenário>` (os cenários estão no próprio script).
