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
  integridade não cobre o `app.asar.unpacked` (onde vivem o `claude.exe` e o JS do Agent SDK, que
  o motor importa de lá) e a pasta de instalação por utilizador é gravável pelo próprio utilizador
  (dá para trocar o próprio `Solline.exe`): o ganho principal é fechar o runAsNode, o NODE_OPTIONS
  e o inspect. Estreitar o `asarUnpack` ao pacote do binário fica para quando der para testar a
  app empacotada nesta máquina (ver Smart App Control).
- **Projetos com e sem confiança.** Um projeto novo pergunta (diálogo nativo, "Não confiar" por
  omissão). Sem confiança, o Claude só lê as definições do utilizador (`settingSources: ['user']`,
  sem `.claude/` nem `CLAUDE.md` da pasta) e "Permitir sempre" passa a "Permitir nesta sessão"
  (o destino das sugestões é reescrito para `session`). Os projetos que já existiam ficam de
  confiança (`projects.json` v1 → v2). Ligar a confiança pede confirmação nativa; vale para as
  sessões novas e para a próxima retoma das que já estão abertas. Modelo e effort pedidos no
  arranque também são validados contra as capacidades (antes só o modo).
- **Smart App Control:** neste PC o Windows bloqueia o `Solline.exe` sem assinatura ("An Application
  Control policy has blocked this file"), por isso a app empacotada não arranca aqui. O smoke corre
  sobre o Electron de `node_modules`. Para usar a app instalada é preciso assinar o build ou desligar
  o Smart App Control (decisão do Duarte; não se volta a ligar sem reinstalar o Windows).

## 2026-10-20: M1c, agentes como dados (contrato neutro v2)

- **Registo de agentes no motor** (`packages/engine/src/agents/registry.ts`): cada agente diz o
  nome, o transporte, a política de ambiente, os modos, se corre em projetos sem confiança, como
  se deteta e como se cria o adaptador. `agents.list` mostra-os à interface com o estado nesta
  máquina. Por agora só o Claude.
- **Ambiente por agente** (`agentEnv`): `host` (o Claude, igual a antes) ou `no-secrets` (sem os
  segredos que o agente não declarou; é uma lista de recusa por nome, por isso um segredo com um
  nome estranho passa). O herdado de uma sessão anfitriã sai sempre; o overlay ganha no fim.
- **Contrato:** `AgentId` em vez do enum; cada modo tem um risco (`read-only`, `plan`, `ask`,
  `edits`, `auto`, `full`) e a interface escolhe o ícone por aí; as capacidades trazem a ordem do
  effort e o que o agente reporta (custo, contexto, retomar); tokens da sessão ao lado do custo
  (último total, nunca somado); um delta `capabilities` para o agente mudar o que sabe fazer.
- **A interface deixa de dizer "Claude"** fora dos dados: o nome vem do registo. O botão de nova
  sessão ganha uma seta para escolher o agente quando houver mais do que um.
- **Suite de contrato** (`packages/engine/test/contract`): os mesmos cenários gravados para todos
  os agentes. `SOLLINE_AGENTS=claude,…` escolhe que agentes correm a sério; por omissão só o Claude.
- **Node 22.18+**: o gravador de fixtures importa o `env.ts` do motor diretamente.

## 2026-10-20: M1d, modelos DeepSeek pelo Claude Code (experimental)

- **São os modelos, não o DeepSeek Harness.** O agente `claude:deepseek` é o mesmo `claude.exe`
  a falar com `https://api.deepseek.com/anthropic` (configuração do guia da DeepSeek: tudo em
  `deepseek-flash[1m]`, haiku e subagentes em `deepseek-flash`). O código vai para os servidores da
  DeepSeek. A Anthropic não suporta este encaminhamento; não encontrei uma proibição.
- **A chave vem do Gestor de Credenciais do Windows** (credencial genérica `solline/deepseek`) ou
  da variável `DEEPSEEK_API_KEY`, só no arranque e só para o processo do agente. Desvio ao plano
  (que dizia só variável): as regras pessoais mandam os segredos para o Gestor de Credenciais e uma
  variável de utilizador fica em claro no registo. Lê-se com `CredRead` num PowerShell com o script
  em `-EncodedCommand` (pelo stdin o PowerShell engole a here-string do `Add-Type`); demora ~2 s.
- **Isolado:** `CLAUDE_CONFIG_DIR` próprio em `<userData>/profiles/deepseek` (o login do claude.ai
  nunca chega a um URL de terceiros), sem segredos do anfitrião (`no-secrets`, cai sempre a
  `ANTHROPIC_API_KEY`), sem definições do utilizador nem do projeto, "Permitir sempre" só na sessão,
  sem Auto, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- **Sem custo:** o `total_cost_usd` seria calculado com preços do Claude; o motor tira-o antes de
  chegar à interface e mostra tokens. A DeepSeek ignora o `cache_control`, por isso sai mais caro
  do que parece pelos tokens.
- **Falta a corrida real** (`SOLLINE_AGENTS=claude:deepseek`): sem chave nesta máquina. Por
  confirmar nela: se o `thinking` adaptativo e o effort passam, a primeira corrida com a pasta de
  config vazia e os nomes que o init devolve.

## 2026-10-20: M1e, ferramentas neutras

- **A interface desenha pelo conteúdo, não pelo nome:** cada ferramenta traz categoria (o ToolKind
  do ACP), ficheiros e conteúdo estruturado (`diff`, `patch`, `command`, `text`). O motor do Claude
  tira isto do input de cada ferramenta; o Codex e o ACP vão mandá-lo já assim. Já não há nomes de
  ferramentas do Claude na interface.
- **Lista de tarefas como bloco próprio** (`todo`), que substitui a lista inteira em cada
  atualização. Do Claude vem do `TodoWrite` ou do `TaskCreate`/`TaskUpdate` (o id da tarefa só vem
  no resultado). Numa sessão do SDK o Claude Code 2.1.304 não ofereceu ferramentas de tarefas
  (gravação real), por isso estes dois caminhos estão testados com mensagens construídas; o Codex
  (`turn/plan/updated`) e o ACP (`plan`) vão usar o mesmo bloco.
- **"Negar sempre"** existe no contrato para os agentes que o têm (ACP `reject_always`). O Claude
  pelo SDK não tem, por isso o cartão não o mostra e o motor recusa-o.
- **Achado da gravação:** as sessões do SDK carregam os conectores MCP da conta claude.ai
  (Vercel, Linear, Docs…) mesmo com `settingSources: []`. É igual ao CLI; no perfil DeepSeek não
  acontece porque a pasta de config é outra e não há login do claude.ai.

## 2026-10-20: M1f, Codex 0.163.0 (entrada)

- **Revisto em quarentena** (`npm pack` de `@openai/codex@0.163.0` e do pacote win32): o lançador
  `bin/codex.js` só procura o binário e define `CODEX_MANAGED_*`; sem scripts de instalação;
  Apache-2.0. O `codex.exe` vem **assinado pela OpenAI OpCo, LLC** (Authenticode válido) e o pacote
  tem proveniência SLSA do workflow `rust-release.yml` do `openai/codex` na tag `rust-v0.163.0`.
  sha256 do `codex.exe`: `2692C8C7BB2CF8B0AEFE638741FC90236F4B824C59578CE84994F9DE58200993`.
- **Não vai dentro do instalador** (desvio ao plano): o pacote do Windows tem 445 MB (o `codex.exe`
  sozinho 326 MB). Fica como dependência do motor, para o desenvolvimento e os testes; a app
  instalada usa o Codex que o Duarte instalar (com verificação de versão). Por ser assinado pela
  OpenAI, o Smart App Control deixa-o correr.
- **Tipos do `app-server` gerados** (`pnpm --filter @solline/engine codex:gen`) e guardados em
  `adapters/codex/protocol` (747 ficheiros, fora do ESLint e do Prettier), com `GENERATED_FROM`
  para um teste de deriva. O app-server é experimental: em cada subida, regenerar e correr os
  testes reais do Codex.
- **Login:** a app-server usa o login que o Codex já tem (`~/.codex`); a Solline nunca lê as
  credenciais. ChatGPT login é aceite pela OpenAI para clientes locais e pessoais.

