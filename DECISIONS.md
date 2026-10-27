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

## 2026-10-20: M1f, Codex pelo app-server

- **Um `codex app-server` por sessão**, JSON-RPC por stdio (sem o campo `jsonrpc`). Arranque:
  `initialize` (com `experimentalApi: false`, fica na superfície estável) → `account/read` (sem
  sessão, não arranca e diz porquê) → `model/list` (só os visíveis; effort por modelo) →
  `windowsSandbox/readiness` → `thread/start` ou `thread/resume`.
- **Modos:** Ler (`on-request` + `read-only`), Ask (`untrusted` + `workspace-write`, por omissão) e
  Auto (`on-request` + `workspace-write`). Acesso total não existe. Sem o sandbox do Windows pronto
  só fica o Ask (Ler e Auto dependem dele) e aparece um aviso. Modelo, effort e modo valem a partir
  do turno seguinte (`turn/start`).
- **Aprovações:** comandos e edições viram cartões com o comando (tirado de dentro do
  `powershell -Command`) ou o patch; "Permitir sempre" é o `acceptForSession` do Codex (só nesta
  sessão); um `serverRequest/resolved` fecha o cartão. Perguntas (`requestUserInput`, experimental)
  e elicitações MCP são recusadas com um aviso, por agora.
- **Uso:** tokens totais e contexto (último pedido sobre a janela do modelo); sem custo.
- **Só em projetos de confiança** (o Codex lê o `AGENTS.md` e a config do projeto) e só com as
  chaves da OpenAI no ambiente.
- **Achados da gravação:** as sessões carregam os servidores MCP do `~/.codex/config.toml` do Duarte
  (paridade com o CLI); a conta é do plano gratuito e ia em 78% do limite de 30 dias, por isso os
  testes reais do Codex só correm com `SOLLINE_AGENTS=codex`. As gravações tiram ids da conta, nome
  do PC, limites e nomes dos servidores MCP.
- **Fica para depois:** "Entrar com ChatGPT" dentro da app (`account/login/start`); hoje, sem sessão,
  a mensagem manda fazer `codex login`. (Feito: ver "login, painel de agentes e MCP no Codex".)

## 2026-10-20: M1g, adaptador ACP genérico

- **ACP v1 por stdio com o nosso `JsonRpcPeer`** (com `"jsonrpc": "2.0"`); o
  `@agentclientprotocol/sdk` 2.0.0 entra só para tipos (revisto: Apache-2.0, sem dependências nem
  scripts de instalação). O SDK 2.0 saiu ontem e trocou a API do cliente; assim não nos afeta.
- **A Solline não anuncia `fs` nem `terminal`:** o agente faz o trabalho e a Solline mostra e aprova.
  Modelos, modos e effort vêm das config options (`model`, `mode`, `thought_level`), com recurso aos
  modos e modelos à moda antiga. Modos de acesso total (yolo, bypass…) ficam escondidos e, se o
  agente arrancar num, a Solline passa-o para o modo mais fechado. "Permitir/Negar sempre" usam os
  nomes que o agente dá (o âmbito é dele). Retomar só se o agente souber (`resume` ou `load`).
- **Catálogo no código** (`agents/catalog.ts`), uma entrada por commit depois de revista. Primeira:
  **OpenCode 1.19.3** (MIT; o `postinstall` só copia o binário da plataforma; sem proveniência no
  npm; lê `opencode.json` e plugins do projeto, por isso só com confiança). Corre `opencode acp`
  com `OPENCODE_CONFIG_CONTENT` a pôr edições, comandos e web em "ask". Procura-se o `npm -g` no
  PATH (só pastas absolutas); versão diferente da revista fica "por rever".
- **Sem corrida real:** não há nenhum agente ACP instalado nesta máquina. O adaptador está testado
  contra um agente ACP falso, também como processo de verdade, e na suite de contrato.
- **Fica para depois:** escolher que chaves cada agente ACP recebe (`agents.setKeys`) e um painel
  de agentes; hoje o seletor já diz o estado e como instalar ou entrar. (Feito: ver abaixo.)

## 2026-10-20: M1h, servidores MCP por sessão e REA

- **Catálogo MCP no código** (`mcp/catalog.ts`), como os agentes: cada servidor é revisto e vai só
  na sessão que o pede (Claude em `options.mcpServers`, ACP no `session/new`). Nunca se escreve nas
  configs globais dos agentes. O Codex ainda não recebe servidores por sessão (falta ver como pela
  config do thread). (Feito: ver abaixo.)
- **Correm no `node.exe` do PATH**, não no executável da app (os fuses tiraram o `runAsNode`).
- **Servidores que correm programas** (`executesCode`) tiram o Auto (e qualquer modo de acesso
  total) da sessão e as ferramentas deles nunca têm "Permitir sempre".
- **REA 6.7.0 entra como servidor MCP opcional**, instalado numa pasta da app com
  `npm install --prefix <dados>/mcp/rea --ignore-scripts rea-agents@6.7.0` (o `--ignore-scripts`
  evita o download do Frida). Não o instalei: fica para o Duarte decidir. Nunca `rea setup`.
- **Provado a sério** com um servidor de eco feito à mão: o Claude chama a ferramenta atrás de um
  cartão sem "Permitir sempre" e o resultado volta.

## 2026-10-20: revisão final (M1g e M1h)

- No ACP, com um servidor MCP que corre programas, nenhum pedido tem "Permitir sempre" (as
  ferramentas ACP não dizem de que servidor vêm) e o agente sai de Auto e de acesso total, no
  arranque e sempre que mudar os modos sozinho. O risco de um modo lê-se pelo id e pelo nome.
- Os segredos do agente (nomes de segredo e tudo o que começa por `ANTHROPIC_`) vão vazios para os
  servidores MCP, que o agente arranca com o ambiente dele por baixo.
- Sem modo por omissão (ACP), um modo que deixou de ser visível passa para o mais fechado.
- A escolha de servidores MCP só segue para agentes que os aceitam (o Codex ainda não).

## 2026-10-20: M2, rever e desfazer

- **Checkpoints num git sombra**, um repositório por pasta de projeto na pasta de dados
  (`checkpoints/run-…/<hash>.git`), partilhado pelas sessões dessa pasta, com um índice por
  sessão. Corre só canalização (`add`, `write-tree`, `diff`, `apply`, `read-tree`) com a config
  global e de sistema desligadas e `info/attributes` a guardar os bytes exatos (sem CRLF, LFS nem
  filtros). O `.git`, o índice e os hooks do utilizador nunca entram. Respeita o `.gitignore` do
  projeto; links simbólicos e submódulos ficam de fora.
- **Cada chamada ao git custa ~130 ms nesta máquina.** Antes de enviar, o motor só espera pelo
  `git add` (o `write-tree` corre a seguir); o resto vai por trás. Sem refs nem gc: os objetos
  vivem enquanto a pasta desta execução existir e as de execuções antigas saem ao fim de 24 h.
  Quando houver histórico de sessões (M3), passam a refs por sessão.
- **Pastas recusadas:** a raiz do disco, a pasta pessoal, a temporária e qualquer uma com mais de
  20 000 ficheiros (contados com o `.gitignore`). A sessão continua; a linha do tempo diz porquê.
- **Rever = base de revisão contra o disco.** Aceitar move a base (o hunk passa pelo
  `git apply --cached` num índice à parte); rejeitar aplica o hunk ao contrário no disco
  (`git apply -R`, que recusa se o ficheiro mudou entretanto). Cada ação e cada rebobinar de
  ficheiros deixa um passo de "Desfazer" (até 50). O id de um hunk é o hash do conteúdo: uma ação
  sobre um diff velho é recusada em vez de mexer na linha errada.
- **Rebobinar a conversa** no Claude usa `resume` + `resumeSessionAt` + `forkSession` (o ponto é a
  última entrada da conversa antes do turno, guardada no envio); no Codex, `thread/fork` com
  `lastTurnId`. O id da sessão na Solline não muda. Nos agentes ACP abre-se uma sessão nova e um
  resumo das mensagens que ficaram (até 12 000 caracteres, as mais recentes) segue com a mensagem
  seguinte, sem aparecer na conversa. A mensagem do turno rebobinado volta à caixa de texto.
- **Desfazer nunca apaga o que mudou depois.** Desfazer um aceitar só mexe na base de revisão;
  desfazer um rejeitar ou um rebobinar só escreve se os ficheiros ainda estiverem como a ação os
  deixou (se não, o passo sai e o disco fica). Todos os destinos são verificados antes da primeira
  escrita, e uma falha a meio deixa o passo de desfazer para o que já foi escrito.
- **Com o agente a trabalhar** só se aceita (mexe na base, não no disco). Rejeitar, desfazer,
  rebobinar e mandar outra mensagem ficam para quando ele parar.
- **Ficheiros acima de 20 MB** ficam fora dos checkpoints (um exclude por sessão, revisto no
  arranque e no fim de cada turno), e com eles fora do rever e do rebobinar.
- **Limite conhecido:** rever e rebobinar comparam com o disco inteiro, por isso também apanham o
  que tu mudaste à mão ou uma troca de branch no teu repositório. Fica à vista no diff antes de
  rejeitar; limitar aos ficheiros que o agente tocou fica para o M5 (passagem de testemunho).
- **Comentários em linha** seguem como uma mensagem normal, com a linha citada do diff.
- **Motion system em `packages/ui`** (`motion.css`, `motion.ts`, `react.ts`): curvas
  `cubic-bezier(0.23, 1, 0.32, 1)` e `cubic-bezier(0.77, 0, 0.175, 1)`, durações de 120 a 260 ms
  com a saída (140 ms) mais rápida do que a entrada, molas à maneira da Apple (amortecimento e
  resposta) para a pega da linha do tempo, que parte sempre do valor e da velocidade atuais.
  Ações de teclado não animam (`data-input` no `<html>` e `detail === 0` nos clicks). O movimento
  reduzido zera distâncias e escalas e deixa a opacidade; saiu a regra antiga que punha todas as
  transições a 0 ms.
## 2026-10-20: modelos GLM e Kimi pelo Claude Code (experimental)

- **Como o DeepSeek:** `claude:glm` (Z.ai, `https://api.z.ai/api/anthropic`) e `claude:kimi`
  (Moonshot, `https://api.moonshot.ai/anthropic`), o mesmo `claude.exe` com outra API, pasta de
  config própria, sem segredos do anfitrião e sem Auto. Chave no Gestor de Credenciais
  (`solline/glm`, `solline/kimi`) ou em `ZAI_API_KEY` / `MOONSHOT_API_KEY`.
- **Modelos dos guias oficiais** (docs.z.ai/devpack/tool/claude e
  platform.kimi.ai/docs/guide/claude-code-kimi, lidos hoje): GLM-5.3 (`glm-5.3[1m]`, haiku e
  subagentes em `glm-5.3-flash[1m]`, `API_TIMEOUT_MS` de 50 min como no guia) e Kimi K3
  (`kimi-k3[1m]`). Desvio ao guia da Moonshot: o haiku fica no K3 e não no `kimi-k2.7-code`,
  que obriga a pensar e dá 400 aos pedidos curtos do Claude Code sem thinking.
- **Sem corrida real:** não há chaves nesta máquina. Os nomes dos modelos mudam depressa: rever
  nos guias em cada subida.
- **O Gemini fica de fora por agora:** entraria pelo ACP (`gemini --experimental-acp`), mas o
  pacote `@google/gemini-cli` tem de ser revisto em quarentena antes de ir para o catálogo.

## 2026-10-20: login, painel de agentes e MCP no Codex

- **"Entrar com ChatGPT" dentro da app.** A interface manda `agents.login` ao main; o main pede
  ao motor `agents.loginStart` (comando interno), que arranca um `codex app-server` auxiliar na
  pasta pessoal e chama `account/login/start {type: chatgpt}`. O main só abre o `authUrl` com
  `shell.openExternal` se for https em `auth.openai.com` (lista por agente em
  `main/agent-policy.ts`, sem porta nem credenciais); senão cancela. O processo fica vivo até ao
  `account/login/completed` (o Codex tem o servidor local do regresso do browser), no máximo 10
  min; um segundo pedido cancela o primeiro. O fim emite `agents.changed` e a interface volta a
  pedir a lista. A Solline nunca lê as credenciais: o Codex guarda-as onde costuma.
- **Saber se o Codex tem sessão** custa arrancar um app-server e um `account/read` com
  `refreshToken: false` (sem rede nem quota). A resposta vale 60 s; "Verificar de novo" manda
  `agents.list {refresh: true}`. Se a pergunta falhar, o Codex aparece pronto e a sessão diz porquê.
- **O seletor** mostra um agente sem sessão como "Entrar com ChatGPT" (ou "à espera do browser…",
  que desiste ao carregar) e tem "Gerir agentes…".
- **Painel de agentes** (Radix Dialog), aberto pelo seletor e pelo rodapé da barra lateral:
  estado, versão instalada e revista, "Verificar de novo", login e, nos agentes ACP, as
  variáveis que recebem. São só nomes (`^[A-Za-z_][A-Za-z0-9_]{0,63}$`, até 32, sem repetidos),
  guardados em `<userData>/agent-settings.json` pelo motor (`agents.saveKeys`, interno) depois de
  uma confirmação nativa no main para os nomes novos (tirar não pergunta). Juntam-se ao
  `envPolicy.keys` no arranque de cada sessão ou retoma. O painel sugere os nomes do ambiente
  que parecem segredos (`agents.keyCandidates`, só nomes, nunca valores).
- **Servidores MCP por sessão no Codex:** vão na config do thread (`mcp_servers.<nome>` em
  `thread/start` e `thread/resume`, como o `-c` do CLI), nunca no `config.toml`. Provado no
  0.163.0 real com um thread efémero e `mcpServerStatus/list` (o servidor de eco ligou e mostrou a
  ferramenta), sem nenhum turno. Todas as ferramentas pedem (`default_tools_approval_mode =
"prompt"`). O Codex pede-o por elicitação com `_meta.codex_approval_kind = "mcp_tool_call"`
  (formato tirado do binário, testado só com o servidor falso: falta um turno real, que gasta
  quota): vira cartão; "Permitir sempre" responde `_meta.persist = "session"` e nunca existe num
  servidor que corre programas. As outras elicitações continuam recusadas com um aviso.

## 2026-10-20: só agentes com login por subscrição

- **Saem os perfis só com chave de API:** `claude:deepseek`, `claude:glm` e `claude:kimi` (o
  Claude Code a falar com a API de outro fornecedor), com o leitor do Gestor de Credenciais e o
  gancho `secrets` do registo, que só eles usavam. Substituem as entradas do M1d e dos modelos
  GLM e Kimi acima.
- **Regra:** um agente entra se tiver login por subscrição feito pelo próprio binário do
  fabricante, arrancado de dentro da Solline (browser ou código de dispositivo). A Solline nunca
  lê, copia nem guarda tokens, e nunca se faz passar pelo cliente de outro fabricante (é isso que
  o jcode faz, contra os termos, e dá contas banidas).
- **O Gemini CLI fica de fora:** o login de consumidor acabou a 18/06/2026. O Antigravity entra
  pelo ACP com o login dele.


## 2026-10-21: qualidade, polimento e morph

- **Regras de ofício** no prompt de sistema do Claude (append) e do Codex
  (`developerInstructions`), em `packages/engine/src/quality/craft.ts`: código igual ao que está à
  volta, a mudança mais pequena, nada de enfraquecer testes, correr as verificações antes de dizer
  que está feito, respostas curtas.
- **Segunda opinião:** no fim de cada turno que mude ficheiros, um Claude Sonnet com contexto limpo
  lê o diff do turno (só Read, Grep e Glob; sem hooks nem definições do utilizador; o CLAUDE.md e o
  AGENTS.md entram como texto, até 8 k, só com confiança; o `settingSources` continua vazio; ver M5) e devolve até 8 achados em JSON com esquema (erro, risco, ruído), em
  pt-PT, presos à linha. Revê qualquer agente: o Codex fica com um revisor de outro fabricante. Um
  turno novo cancela a revisão anterior. Liga e desliga por sessão; "Corrigir" manda os achados
  escolhidos ao agente da sessão. Gasta a subscrição do Claude (cerca de 5 s por turno).
- **Morph** com View Transitions (React 19.3 e Chromium do Electron): o cartão de permissão vira a
  linha resolvida e o enviar vira o parar. Os eventos do motor passam por uma fila para a
  transição nunca trocar a ordem. A transição só corre na sessão à vista e nunca com o teclado.
- **Git dos checkpoints por caminho absoluto**, procurado só em pastas absolutas do PATH (um
  projeto podia plantar um `git.exe`), e direto ao binário verdadeiro do Git for Windows. Cada
  chamada ao git é um processo novo e, nesta máquina com o PC Manager e o antivírus, chega a 1 s:
  rejeitar passou de 11 para 9 chamadas, com o diff e as contas em paralelo.

## 2026-10-21: marca Meridiano e tripulação

- **Marca:** a direção "Meridiano" (proposta do ChatGPT a partir de `docs/branding-prompt.md`),
  com o Solline Pin como símbolo e ícone da app. Detalhes em `docs/brand.md`.
- **Tripulação como avatares dos agentes** (Claude, Codex, revisor, ACP, outros), com a pose a
  seguir o estado da sessão, e o familiar nos momentos raros. Arte provisória cortada da folha
  gerada; os sprites finais (48×48) entram com os mesmos nomes.
- **Correções à proposta:** as cores da tripulação seguem a folha (o documento não batia certo);
  a gravidade dos achados tem forma além de cor e o ruído passa a cinzento (o violeta chocava com
  o Índigo); a cópia em pt-PT segue o AO90; a maqueta (agentes por fase, um gato como familiar)
  ficou só como inspiração.

## 2026-10-21: bots no lugar dos feiticeiros (grilling)

- **Cada sessão é um bot** (cara e personalidade) que é também o agente (o trabalho). Os
  bots são o Solline Pin de olhos abertos, desenhados em código (`packages/ui/src/bot`); a
  pixel art dos feiticeiros saiu. Inspirados nos bots do Grok; do repo `jeremy-prt/bloub`
  (MIT) só entra o motor de animação, quando houver animação.
- **Cor:** o capuz diz o agente, com tons suaves; o âmbar fica para a Solline e para "precisa
  de ti"; o ACP passou a rosa (o vermelho é "caiu"). O estado vive na bainha e, quando é
  urgente, nos olhos.
- **Ícone:** o bot âmbar num quadrado de carvão, gerado por `scripts/brand-icons.mjs` a partir
  da geometria (Node puro, sem dependências), com 24/20/16 px em pixel art à mão.
- **Movimento mínimo:** parados por agora. A animação entra depois do M3 e só no bot da
  sessão aberta; o olhar segue a ação, nunca o rato; nada anima por tecla; um turno acabado
  dá olhos contentes 1,4 s, sem explosão.
- **Esforço:** um ícone nosso (meio sol que nasce com o esforço) para todos os agentes, numa
  barra de cinco paragens com mola; o pet do Claude Code fica como opção escondida (é IP da
  Anthropic).
- **Revisor:** do outro fabricante quando possível (o Codex revê o Claude e vice-versa); se não
  estiver pronto ou sem quota, revê o mesmo; diffs pequenos não se revêem; uma revisão de cada
  vez.
- **Ordem:** bots parados e ícone → avisos do Windows ("precisa de ti", "turno acabado", só sem
  foco) → verificações do projeto depois de cada turno → M3 (a mesa) → animação dos bots.

## M3, fatia 1: uma worktree por sessão a mais (21/10/2026)

- A primeira sessão ativa de um projeto trabalha na pasta; da segunda em diante (ao mesmo tempo)
  cada uma ganha uma worktree em `<dados>/worktrees/<projeto>/<4 letras>` e o branch
  `solline/<título>-<4 letras>` (nome dado na primeira mensagem). Sem git, partilham a pasta
  e o cabeçalho diz "Mesma pasta"; a Solline nunca faz `git init`.
- "Trazer" grava as mudanças da worktree num commit (com os hooks do projeto) e faz
  `merge --no-ff` no branch atual do projeto. Com conflitos, o merge é desfeito no projeto e o
  agente pode resolvê-los no seu branch. Só exige a sessão da worktree parada.
- Fechar: sem mudanças por trazer, a worktree e o branch saem; com mudanças, pergunta.
- Cada worktree tem um `.json` ao lado (branch, base, projeto) para as que ficam por trazer
  depois de a app fechar aparecerem na mesa (fatia 2).
- As verificações passam a ser por pasta de trabalho, não por projeto.

## M3, fatia 2: a mesa (21/10/2026)

- A mesa é a vista de conjunto: um cartão por sessão, ordenados por urgência (precisa de ti →
  a trabalhar → caiu → parada → por trazer) e, dentro de cada estado, pela ordem de chegada, para
  os cartões não mudarem de lugar sem razão. Quando mudam, deslizam 250 ms (FLIP, só transform).
- Um pedido de permissão responde-se no cartão (Permitir / Negar); planos e perguntas abrem a
  conversa. O cartão não tem caixa de resposta.
- As worktrees que ficaram por trazer quando a app fechou aparecem como cartões "por trazer".
- Avisos do sistema também quando uma sessão cai e quando as verificações falham, uma vez por
  ronda e só sem foco.
- Fechar uma sessão espera por um "Trazer" a meio (antes lia o estado antigo e pedia escolha).
- Calma passou a ser a quinta medida do Norte (`CLAUDE.md`); o ritmo concreto está em
  `docs/brand.md`.

## Deslocar sem barras (21/10/2026)

- Nenhuma barra de scroll na app; as bordas esbatem (`scroll-fade-y`) para dizer que há mais.
- `packages/ui/src/scroll.ts`: `scrollToSmooth` (mola que muda de alvo sem perder velocidade),
  `scrollIntoViewSmooth` e `useDragScroll` (arrastar numa zona vazia, com inércia e ponta
  elástica; nunca sobre texto, controlos ou código; a mão só aparece a arrastar). A roda ou um
  toque param a mola: o gesto do Duarte ganha sempre.
- A conversa segue o fundo com a mola; se subiste para ler, não puxa e acende "↓ Novo". Um
  pedido que precisa de ti vem sempre à vista. No rever, depois de aceitar ou rejeitar, desliza
  para o hunk que ficou no lugar; na mesa, depois de responder, para o próximo que precisa de ti.
- A navegação automática nunca troca de sessão nem de ecrã sozinha.

## M3, fatia 3: fila e guiar (21/10/2026)

- `SessionTurns` é o dono do turno de cada sessão: envio, fila, guiar, pausa e `exclusive`
  (rebobinar, trazer). Entre itens da fila a sessão não passa por "parada" (sem aviso de turno
  acabado a cada item); as verificações só correm com a fila vazia.
- Claude: a sonda com o SDK real mostrou que `priority: 'now'` aborta a ferramenta e abre outro
  turno (é interromper), e que `'next'` entra na próxima pausa no mesmo turno, com um só result.
  Guiar usa `'next'` e só com uma ferramenta a correr; sem ferramenta, a mensagem vai para a
  fila (podia cair depois do result e abrir um turno sem checkpoint).
- Codex: `turn/steer` com `expectedTurnId`; se o turno já acabou, vai para a fila.
- ACP: só fila.
- Uma mensagem guiada fica na conversa "à espera" e passa a "lida" quando o agente a lê.


## M3, fatia 4: preparar a worktree e portas (21/10/2026)

- Cada sessão recebe 10 portas livres a partir de 41000 (`SOLLINE_PORT`, `SOLLINE_PORT_COUNT`), no
  ambiente do agente, do script de preparação e das verificações; libertam-se ao fechar.
- Uma worktree nova prepara-se por trás: copia os `.env*` não versionados da raiz (sem pisar nada)
  e corre o comando do projeto (definições da Solline; sugestão: o `setup` do `conductor.json` ou
  instalar com o gestor do lock). Só em projetos de confiança; um comando novo pede confirmação
  nativa, como as verificações. Limite de 10 minutos.
- Enquanto prepara, a sessão abre e o que escreves espera na fila (`SessionTurns.hold`); falhar não
  bloqueia: vê-se o fim do erro com Repetir e Mandar ao agente.

## Fecho do M3 (21/10/2026)

- Revisão de código e de movimento ao M3; corrigido o que encontraram (ver o commit).
- A sugestão de preparação (conductor.json ou gestor de pacotes) só corre depois de aprovada uma vez
  com confirmação nativa; fica guardada e um git pull já não muda o que corre.
- Deitar fora uma worktree (fechar ou órfã) pede confirmação nativa no main.
- Trazer recusa com o projeto fora de um branch.
- O bot pisca uma vez ao mudar para à espera ou precisa de ti, e ao passar o rato; em repouso fica
  parado.

## M4, fatias 1 a 4: corridas, Verificador e ordenação (21/10/2026)

- Uma corrida abre N sessões normais (2 a 4), cada uma numa worktree obrigatória; sem git não há
  corrida. Os pedidos das pistas chegam num só sítio, com "Permitir para todas" quando coincidem.
- Ordena-se pela execução, não por opinião: pistas sem mudanças vão para o fim, depois menos
  verificações partidas pela mudança (as que já falhavam na base não contam), depois o consenso
  (pistas com o mesmo patch normalizado formam um grupo e o maior ganha).
- O juiz cego só entra num empate no topo entre soluções diferentes; vê letras, diffs e
  verificações, nunca o agente. Corre nas duas ordens; se discordarem, ou se falhar, fica
  "Empate: escolhe tu". Nunca se descartam pistas, só se ordenam.
- As pistas não correm as verificações no fim de cada turno: a corrida corre-as uma vez, com a base.
- O diff de uma worktree usa um índice temporário só seu (o das contas podia estar a correr ao
  mesmo tempo e devolvia um diff vazio).
- Adiado com nome: os testes gerados para distinguir as pistas e o juiz de outro fabricante (Codex
  em sandbox só de leitura); por agora o juiz é o Claude.

## A linha do Codex passa a ser o tronco (22 a 23/10/2026)

- O Codex continuou a partir do commit da fatia 4 do M4 (36 commits): redesign (porcelana e carvão,
  Geist, paper-bots), espaços e tarefas com delegação manual, memória com aprovação, pesquisa Ctrl+K,
  retoma da navegação, recuperação das sessões e corridas, controlos da janela e uma bateria de QA
  reproduzível. A versão estável está nesse ponto.
- O branch `feat/design-qualidade` é antepassado direto: o trabalho novo parte do tronco do Codex.
- Retoma: `navigation.json` guarda só identificadores e preferências, com gravação atómica; um
  destino apagado recua para um válido e um ficheiro corrompido nunca é reescrito. Por omissão
  "Retomar onde estava"; "Tarefas do Geral" e "Mesa" só valem na abertura seguinte.
- Recuperação: journal durável e cifrado; as pistas de uma corrida voltam em erro e a corrida a
  correr ou a ordenar volta a "acabaram todas". Os comandos de corrida passam por `beforeEffect`.
- Nada foi enviado para o remoto; a promoção deixou uma cópia da versão anterior para reverter.

## Investigação do Orca (23/10/2026)

- Estudado em quarentena (programa oficial e fonte). Não é cobertura de execução completa do Orca:
  contas, agentes reais, agendador, browser e terminal completos ficaram por provar. Nenhum código
  nem recurso foi copiado.
- Entrou: pesquisa global local, retoma da navegação, escolhas de arranque, voltar da sessão
  delegada à tarefa certa.
- Mantido: motor, ponte, interface; espaços, filas, revisão e verificações já existentes.
- Adiado (não proibido): terminal embutido, browser e editor completos, agendador genérico.
  Só voltam com um caso concreto e o ensaio completo das falhas.
- Descartado: onboarding promocional, mega-definições, tokens e daemon globais (DEL-286).
- As provas e a matriz completa vivem fora do repositório, na pasta de investigação do Codex.

## M4, fatia 5: montar, trazer e fechar (29/10/2026)

- Uma pista pode escrever mais de um hunk numa zona; o candidato é o que a pista escreveu na zona
  inteira, para nunca se montar meia mudança.
- A worktree da montagem é irmã das pistas (mesmo commit, dependências ligadas) e conta como em
  uso: não aparece como órfã. Ao reiniciar, a montagem por trazer volta a "ordenada" e a worktree
  fica como órfã; uma já trazida só falta fechar.
- Fechar a corrida pede uma confirmação nativa e deixa guardar o branch de uma pista.
- O redesign do Codex trazia barras de scroll finas; voltou a regra do Duarte: sem barras.

## M4.5: repartição (29/10/2026)

- Pesquisa antes do grilling (nova regra): partir só compensa quando as partes não se tocam; o
  planeador pode recusar; agentes não conversam entre si; contrato por parte; integração em série.
- Partes diferentes não se montam por zonas: integram-se por merge, uma a uma, produtor primeiro
  (parte zero, depois cada predecessor), com o Verificador depois de cada junção. Uma parte que vem
  depois de outra parte do resultado dela (`startAfter`), não da base.
- O planeador (Claude Sonnet, só leitura) propõe; quem lança é o Duarte. Checks só os do projeto
  guardado e só em projetos de confiança, também no motor. Uma parte sem verificação não lança.
- Conflito: sessão normal na worktree da ponta, com a mensagem do conflito; a resolução só é aceite
  se contiver o que já estava juntado e passar a verificação. Nunca se descarta uma ponta com
  trabalho que a nova não contém.
- Resumos entre partes: gerados pela Solline, em fila, só para partes ainda a trabalhar. Escrita fora
  do âmbito ou colisão (`git merge-tree`) é aviso, nunca interrupção; problemas de uma parte nunca
  chegam como erro do motor (abriam a janela de recuperação).
- Parar a repartição limpa as partes por lançar. Uma parte interrompida não lança as seguintes.
- Medir sem inventar: custo somado, tempo da pista mais lenta contra a soma, conflitos, falhas
  depois de integrar.
- Por fazer: bloquear mensagens à sessão que resolve, prévia de colisões mais leve (um snapshot por
  pista), cancelar o planeador a meio, partes ligadas às tarefas dos Espaços.

## M5: segunda opinião, passagem de testemunho e linhagem (27/10/2026)

- Pesquisa antes do grilling (regra nova): um revisor de outro fabricante apanha mais erros
  (Greptile, "model inversion": +6 a 12 pontos de recall); um resumo do agente engana o revisor
  (15 em 17 casos). Por isso o revisor nunca recebe o resumo do agente.
- **Segunda opinião:** revisor do fabricante oposto (o Codex revê o Claude; o Claude revê o Codex e
  o ACP), pela subscrição e só de leitura. Sem o outro fabricante, ou num projeto sem confiança (o
  Codex leria a config do projeto), revê o mesmo fabricante e o cartão diz "mesmo fabricante".
- Corre no fim do turno se o diff tiver 20 linhas ou mais, ou tocar num ficheiro sensível; também a
  pedido ("Segunda opinião", no turno ou na sessão) e antes de trazer. É informação: nunca bloqueia.
  "Trazer" passa a pedir 2 cliques.
- Entrada: pedido, diff, repositório só de leitura e CLAUDE.md/AGENTS.md (até 8 k), só com confiança.
- Saída: erros e riscos, com prioridade P0 a P3 e confiança. À vista no máximo 5 com confiança de
  0,7 ou mais; o resto fica dobrado. "Sem achados" é bom resultado. Um erro do revisor nunca aparece
  como "tudo limpo". Corrigir e Dispensar, com contador. Os caminhos dos achados ficam dentro do
  projeto.
- **Passagem de testemunho ("Passar a…"):** escolhes agente, modelo e objetivo. Um redator só de
  leitura escreve o rascunho com secções fixas (objetivo, decisões e o que ficou de fora, ficheiros
  tocados, perguntas em aberto, próximos passos, verificação; "(nada)" quando vazia). Se o redator
  falhar, sai um rascunho mecânico. Editas antes de enviar.
- Abre-se uma sessão nova na mesma pasta ou worktree, com aviso visível. A antiga fica "passou o
  testemunho": lê-se, mas não se escreve, rejeita, desfaz nem traz.
- "Retomar aqui" devolve a pasta à origem e segue cadeias (A→B→C). Fechar quem recebeu devolve a
  worktree à origem, sem apagar nada.
- **Linhagem:** `SessionInfo.origin` (passagem, bifurcação, corrida, parte ou tarefa; só ids) e
  `handedTo`. "Bifurcar daqui" na linha do tempo cria uma worktree própria no estado do turno (só em
  projetos git); a conversa segue pelo fork do agente ou por um resumo. O Mapa é opcional por
  projeto: árvore, clique abre a sessão, cor do fabricante.
- Limite: o revisor e o redator foram testados só com fakes, não com os binários reais.
- Por fazer, com nome (da revisão da fase 6):
  - Média: os servidores MCP do `~/.codex/config.toml` arrancam dentro do revisor Codex, e o sandbox
    só de leitura não os limita. Correção possível: `config: { mcp_servers: {} }` no `thread/start`,
    por testar num Codex real.
  - Média-baixa: na sessão que recebeu o testemunho, o "pedido" que o revisor lê é o rascunho (escrito
    por um modelo), o que choca com a regra de não dar resumos ao revisor. Decidir.
  - Baixa: os ids dos achados repetem-se ao rever o mesmo turno; `stats.total` conta em dobro; achados
    ancorados só por caminho e linha (podem não bater com o âmbito mostrado); a palavra sensível
    `session` apanha `session-manager.ts`; "Trazer" na origem depois da passagem mostra o chip, mas o
    motor recusa; uma worktree por confirmar depois de reiniciar escapa ao `assertRecoveryReady`; o
    revisor da integração das partes ainda é só Claude e não tem `projectFindings`.
  - Ficheiros grandes: `session-manager.ts` (~2260 linhas) e `stores/app.ts` (~1580). Extrair o bloco
    de passagem e de bifurcação.
  - Não verificado: o revisor Codex e o redator contra binários reais; o Mapa com ~100 sessões.
  - Adiados do plano: verificação por segunda passagem no revisor; aprender com Corrigir e Dispensar;
    menções entre sessões; sugerir a passagem quando o contexto enche.

## M6, fase 1: o servidor MCP da Solline, o "cérebro" (27/10/2026)

- **O que é:** um servidor MCP chamado `solline`, que vive no motor (`packages/engine/src/brain`) e
  que os agentes veem como mais um servidor. Esta fase só monta o cano e uma ferramenta de prova,
  `solline_context` (projeto, pasta, título da sessão, agente; só leitura). As ferramentas de regras,
  memória e agentes vêm nas fases seguintes.
- **Identidade:** quem chama é resolvido pelo motor (a sessão que recebeu o servidor), nunca pelos
  argumentos do agente; um argumento a mais é recusado. Erros voltam como erro MCP, nunca como
  exceção no motor.
- **Dois caminhos para a mesma função:** o Claude recebe um servidor SDK em processo
  (`createSdkMcpServer`), sem canal nem token. O Codex e os agentes ACP recebem um shim stdio
  (`solline-brain-shim.cjs`, um ficheiro sem dependências) corrido com o Node do sistema (o mesmo
  `findNode` do catálogo); nunca o executável da app (os fuses tiram o `runAsNode`). Sem Node ou sem
  shim, o cérebro não existe para esses agentes: avisa-se uma vez e a sessão abre na mesma.
- **Canal local:** named pipe no Windows ou socket Unix numa pasta 0700, com nome aleatório. O shim
  diz o token (32 bytes aleatórios, um por sessão e por arranque do agente) e o motor mapeia-o para
  a sessão. Token desconhecido, fechado ou revogado recebe sempre "unauthorized"; mensagens com mais
  de 1 MiB, ligações sem hello em 5 s e mais de 8 ligações por token são cortadas. O token só existe
  no ambiente do shim (`SOLLINE_BRAIN_TOKEN`) e na config que o motor dá ao agente: nunca em eventos,
  resumo de sessão, diário de recuperação nem registos. Fechar a sessão, retomar, rebobinar ou parar
  o motor revoga-o e fecha as ligações abertas.
- **Onde está ligado:** sessões normais, de passagem, de bifurcação e de tarefa, em agentes com MCP
  por sessão. Desligado nas pistas das corridas, nas partes de uma repartição e em quem resolve uma
  integração (têm `raceId`): têm de ficar independentes. Os revisores, o juiz, o planeador e o
  redator não passam pelo gestor de sessões e continuam sem MCP. O limite de 8 servidores é dos do
  catálogo; o cérebro não conta. `features.brain` diz à interface se a sessão o tem.
- **Autorização:** as ferramentas só de leitura correm sem pedir (no Claude por `canUseTool`, não por
  `allowedTools`, porque o SDK avisa que isso lhe tira o callback; no Codex por
  `tools.<nome>.approval_mode = approve`). Tudo o que mude estado passa pela autorização normal do
  agente, com o nome "Solline · ferramenta".
- **Verificado em binários reais:** o Claude liga o servidor em processo (`mcpServerStatus`:
  connected, com a ferramenta); o Codex 0.163 arranca o shim por `mcp_servers.solline`, aceita o
  `approval_mode` por ferramenta e `mcpServer/tool/call` devolve a identidade da sessão.
- **Por verificar:** um agente ACP real a usar o shim (só testado com um agente falso); o Codex a
  chamar a ferramenta num turno com modelo; o shim dentro de um instalador completo (o
  `electron-builder --dir` põe-no em `app.asar.unpacked/out/main/brain-shim.cjs`).

## M6, fase 2: regras do projeto escritas uma vez, para todos os agentes (27/10/2026)

- **O que são:** regras curtas, escritas pelo utilizador, guardadas na Solline por projeto, cada uma
  com título, texto, padrões de ficheiro opcionais (`*.ts`, `src/db/**`) e um interruptor. A Solline
  nunca escreve o conteúdo de nenhuma (a pesquisa: ficheiros de contexto escritos por modelos baixam
  o sucesso e gastam ~20% mais; regras curtas escritas por pessoas ajudam ~4%).
- **Chegam sem tocar no repositório**, no formato de cada agente, quando a sessão arranca: Claude no
  prompt de sistema (depois das regras de ofício), Codex nas `developerInstructions`, ACP com a
  primeira mensagem (como o resumo de rebobinar; `memory.intro`, que segue uma vez e fica no diário).
  Regras sem padrões vão inteiras; as com padrões só como índice (título, id, padrões e "lê com a
  ferramenta read_rule quando editares estes ficheiros"; sem cérebro o índice diz só "aplica-se
  quando editares").
- **Ao tocar:** antes de cada mensagem, o motor vê (por `changedPaths` dos checkpoints) que ficheiros
  os turnos anteriores mudaram e, se casam com uma regra com padrões que ainda não seguiu, a regra
  inteira vai como contexto com essa mensagem. Uma vez por regra e sessão (`rulesDelivered` no
  diário); só conta o que o agente mudou, não o que leu. Rebobinar a conversa em resumo (agente novo
  sem histórico) volta a pôr tudo a zero; rebobinar por ponto do agente não.
- **Sem duplicar:** o Claude lê o CLAUDE.md (que importa o AGENTS.md) e o Codex lê o AGENTS.md. Se
  esses ficheiros são exportações da Solline por editar e iguais ao que sairia agora, o bloco do
  arranque não vai para esse agente (as com padrões continuam a entrar ao tocar). Exportação
  desatualizada, editada, escrita à mão ou projeto sem confiança (o Claude não lê o CLAUDE.md): o
  bloco vai. Quem importou de um ficheiro escrito à mão fica com um aviso (`native`) até exportar.
- **Importar:** o CLAUDE.md e o AGENTS.md da raiz, uma regra por `##` de topo (o que vem antes é
  mais uma, com o nome do `#`), sem repetir (título e texto, a menos de caixa e espaços). Sem
  padrões. Uma exportação da Solline por editar não se importa; editada, "adota-se" com
  `rules.import {path}`.
- **Exportar:** `AGENTS.md` (regras sem padrões e índice) e `CLAUDE.md` com `@AGENTS.md`, nunca uma
  ligação simbólica, cada um com um marcador `<!-- solline:rules v1 sha256=... -->` com o hash do
  resto. Só reescreve um ficheiro com marcador cujo hash bate (CRLF conta como LF); ficheiros sem
  marcador, editados, ligações ou pastas dão conflito e não se escreve nenhum dos dois. O main
  pede confirmação nativa ("Escrever AGENTS.md e CLAUDE.md em <pasta>?") e dá a pasta ao motor
  (`rules.exportNow`); a interface nunca manda caminhos.
- **Aviso de tamanho:** acima de ~150 linhas ou ~8000 caracteres nas regras sem padrões, o estado
  traz um aviso (`warnings`, `kind: 'length'`). Nunca bloqueia.
- **Estado:** `RulesState` viaja como os Espaços: evento `rules.changed` com tudo, no snapshot e no
  diário de recuperação. `rules.list` é só de leitura (não entra no diário); `rules.save/delete/
  import/export` entram.
- **Ferramentas do cérebro:** `read_rule {id}` e `list_rules`, só de leitura (correm sem pedir). O
  projeto é o da sessão que chama; um id de outro projeto ou de uma regra desligada dá erro.
- **Padrões:** matcher próprio e pequeno (`*`, `**`, `?`, `{a,b}`, `[abc]`; sem barra vale em
  qualquer pasta). O repositório só tem picomatch e minimatch como dependências indiretas, e o Node
  `path.matchesGlob` ainda é experimental.
- **Por verificar:** um agente real a seguir o bloco e a chamar `read_rule` num turno com modelo; a
  interface (fase 6).
