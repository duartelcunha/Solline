# Decisões

## 2026-10-11: versões do M0

- **electron-vite 5.0.0 com Vite 7.3.7 fixo**, em vez do electron-vite 6 (ainda beta e com
  beta nova a 10/10). O 5 é estável e aceita Vite 5 a 7; o 6 só faz falta para o Vite 8.
  Por isso `@vitejs/plugin-react` fica no 5.2 (o 6 exige Vite 8).
- **TypeScript 5.9.3**: o typescript-eslint 8 só aceita TS abaixo de 6.1.
- **pnpm 10.34.6** (via corepack) em vez do 12, publicado há dois dias.
- **node_modules plano** (`nodeLinker: hoisted`): o electron-builder empacota melhor assim.
- **Electron 44.7.0**, **electron-builder 26.15.3** (NSIS por utilizador, sem assinatura,
  sem auto-update), **Agent SDK 0.3.296** (traz o claude.exe 2.1.296).
- Revisão: 2026-11-11, ou antes se o electron-vite 6 sair estável (subir para Vite 8 e
  plugin-react 6).

## 2026-10-11: M1 "Conversa a andar"

- **Contrato neutro:** blocos normalizados (texto, thinking, ferramenta, permissão, plano,
  pergunta, aviso) e deltas pequenos e idempotentes; o reducer vive no protocol e serve a
  interface e os testes do motor.
- **Um store zustand por sessão** (mais um para a app): o streaming de uma sessão não volta a
  desenhar as outras.
- **Markdown com react-markdown 10 + remark-gfm + rehype-highlight** (highlight.js por
  lowlight) em vez de shiki: corre offline sem WASM, cabe na CSP sem `wasm-unsafe-eval` e as
  cores seguem os tokens do tema.
- **Radix (dropdown-menu 2.1.24, dialog 1.1.23)** para menus e a vista detalhada: foco,
  teclado e aria certos sem os escrever à mão. Ficam uma versão atrás da última (de 05/10).
- **Thinking em `display: summarized`**: sem isto o SDK manda o thinking vazio.
- **`settingSources` do utilizador e do projeto ligados na app** (paridade com o CLI); os
  testes e o smoke correm isolados (`SOLLINE_ISOLATED=1`) para não correr hooks pessoais.
- **"Permitir sempre" devolve as `suggestions` tal como o CLI as manda** (o destino vem do
  CLI; numa edição é `setMode acceptEdits` na sessão). Escondido com
  `suppressAlwaysAllowRule`.
- Revisão: no fecho do M1b (adaptador ACP), para ver se o contrato aguentou o segundo agente.

## 2026-10-20: plano multi-agente

- **Plano em `docs/plano.md`** (o de `~/.claude/plans` perdeu-se; o plano passa a viver no repo).
- **Ordem:** S0 → M1b Confiança → M1c Agentes como dados → M1d DeepSeek → M1e Ferramentas ricas →
  M1f Codex → M1g ACP → M1h MCP + REA. O antigo "M1b = segundo agente por ACP" fica retirado; a
  revisão do contrato passa para o fecho do M1f (e volta a ver-se no M1g).
- **REA (morluto/rea) não serve para engenharia reversa dos harnesses.** Todos têm interface pública
  (Agent SDK, `codex app-server`, ACP, endpoint Anthropic da DeepSeek); os termos da Anthropic
  (Consumer §3(3), Commercial D.4(b)) e do Cursor proíbem descompilar e o art. 6 da Diretiva 2009/24
  não se aplica quando a interface é pública; o `claude.exe` é um executável Bun que o REA não abre.
  Fica opcional: servidor MCP por sessão (M1h) e auditoria estática do nosso `app.asar`. Nunca
  `rea setup`.
- **Um caminho por harness:** Claude pelo SDK (nativo); Codex pelo `codex app-server` (nativo, tipos
  gerados e fixados); modelos DeepSeek por um perfil do adaptador do Claude e pelo OpenCode; o resto
  por um adaptador ACP genérico com entradas revistas no código. O DeepSeek Harness (dsh) fica de
  fora: o ACP dele (`@deepseek-ai/dsh-acp` 0.0.1-rc.1) é só para automação.
- **Agent SDK 0.3.304** (claude.exe 2.1.304). A 0.3.300 valida o `updatedInput` dos hooks (usamos
  `canUseTool`, não nos afeta); a 0.3.302 liga os subagentes fork por omissão (mais blocos
  `parentToolId` planos até ao M2) e põe fornecedores de terceiros em `default` (passamos sempre
  `permissionMode`). Fixtures regravadas; o normalizador não mudou.

## 2026-10-20: M1b, confiança

- **A interface só manda ids.** `session.create` é do main: troca o projeto pela pasta guardada e
  chama o motor com `session.start`, que a IPC não consegue nomear. Modo, modelo e effort são
  validados no motor contra as capacidades; o adaptador do Claude nunca deixa passar
  `bypassPermissions` nem `dontAsk`.
- **IPC só da janela principal**, no frame de topo e na página carregada (origem exata em dev,
  `index.html` em `file://` no build). Permissões do browser todas negadas; webviews e janelas novas
  bloqueadas; links externos só `https:` sem credenciais no URL.
- **CSP na meta do `index.html`** (um `file://` não tem cabeçalhos), agora com `object-src`,
  `base-uri`, `form-action` e `frame-src` a `'none'`.
- **Fuses no build** (lidos no `Solline.exe` com `@electron/fuses` 1.8.0): RunAsNode, NODE_OPTIONS e
  `--inspect` desligados; cookies cifrados; integridade do asar e só carregar do asar ligados;
  `GrantFileProtocolExtraPrivileges` ligado porque a interface carrega módulos de `file://`. A
  integridade não cobre o `app.asar.unpacked` (onde vive o `claude.exe`) e a pasta de instalação
  por utilizador é gravável pelo próprio utilizador: o ganho principal é fechar o runAsNode, o
  NODE_OPTIONS e o inspect.
- **Smart App Control:** neste PC o Windows bloqueia o `Solline.exe` sem assinatura ("An Application
  Control policy has blocked this file"), por isso a app empacotada não arranca aqui. O smoke corre
  sobre o Electron de `node_modules`. Para usar a app instalada é preciso assinar o build ou desligar
  o Smart App Control (decisão do Duarte; não se volta a ligar sem reinstalar o Windows).

