# M6: quatro decisões

Fechadas a 2026-11-06. A 1 não seguiu estas opções: as regras passaram a ser nativas (`docs/PLANO-regras-nativas.md`). As 2, 3 e 4 ficaram na opção 1. O registo está no `DECISIONS.md`.

O M6 está no `main`. Estes quatro pontos ficaram em aberto no `DECISIONS.md` (revisão de 28/10/2026) e no `STATUS.md`. Cada secção cabe numa leitura. O por omissão é uma recomendação para decidir depressa; não está implementado.

Ficam no `DECISIONS.md` e não estão aqui: passar uma memória externa a regra (`memory.toRule`) sem segunda confirmação, a impressão das ferramentas MCP, e o cartão de consulta que no Codex se cancela aos 900 s.

## 1. Importar regras

Importar lê o `CLAUDE.md` e o `AGENTS.md` da raiz e grava uma regra por secção `##`, já ligada, sem mostrar o texto antes. O main não pergunta e não olha para a confiança do projeto (`rules.import` em `apps/desktop/src/main/index.ts`). O motor põe `enabled: true` (`importFiles` em `packages/engine/src/rules/manager.ts`). Uma regra ligada entra no arranque da sessão seguinte, também num projeto sem confiança, onde o Claude não leria o `CLAUDE.md` da pasta (`#ruleBlock` em `session-manager.ts`). O resumo que aparece é depois de gravar, e diz quantas entrou, não o texto.

1. **Entram desligadas.** O mesmo clique. Cada regra fica na lista com o interruptor desligado; ligá-la é o que a entrega aos agentes. Com confiança ou sem ela, a regra é a mesma.
2. **Pré-visualização por secção.** Antes de gravar, escolhes o título e o texto que entram. As escolhidas entram ligadas.
3. **Como hoje, e o Windows só pergunta num projeto sem confiança.** Num projeto de confiança continuam a entrar ligadas, sem leitura prévia.

**Por omissão: a 1.** O interruptor já existe e a lista já mostra «Desligada». A pré-visualização é outro ecrã no momento em que só se queria trazer o ficheiro.

**Segurança e desfazer.** A importação não escreve na pasta do projeto. Apagar a regra, ou deixá-la desligada, tira-a dos agentes. A 1 impede que o texto de um commit ou de um agente passe ao prompt no próprio gesto de importar. A 3 deixa esse caminho aberto nos projetos de confiança.

## 2. Bash nas consultas do Claude

Uma consulta (`origin.kind === 'ask'`) abre na mesma pasta de quem perguntou, sem worktree e sem checkpoints (`consult/manager.ts`, `workspace: { kind: 'shared' }`). O motor marca `readOnly` e recusa, sem cartão, o que peça permissão (`#sinkFor` em `session-manager.ts`). No Claude, `readOnly` só retira Edit, Write, MultiEdit e NotebookEdit (`READ_ONLY_DISALLOWED` em `packages/engine/src/adapters/claude/sdk.ts`). O Bash fica. Uma regra «allow» das definições do utilizador, por exemplo `Bash(git commit:*)`, é decidida pelo Claude antes do `canUseTool`, e o motor não chega a ver o pedido. O comentário no adaptador diz que `disallowedTools` ganha a essas regras. Não há smoke com o Claude real a prová-lo. As definições continuam a carregar-se: `user` sem confiança, e `user`, `project` e `local` com confiança.

1. **Tirar o Bash às consultas.** Juntar `Bash` a `disallowedTools` quando a sessão é `readOnly`. A consulta continua a ler ficheiros. Provar num smoke com uma regra «allow» de Bash.
2. **Abrir a consulta sem definições** (`settingSources: []`). Sai o Bash permitido, e também os hooks e o resto das definições do utilizador e do projeto.
3. **Deixar o Bash** e escrever no cartão «Perguntar a…» que a consulta pode correr comandos que as definições já autorizam.

**Por omissão: a 1.** É a mesma lista que já fecha o Edit e o Write, e o código trata-a como mais forte do que uma regra «allow». A 2 tira o Claude pessoal inteiro para fechar um comando. A 3 deixa o comando correr na pasta partilhada, onde a consulta não tem checkpoint.

**Segurança e desfazer.** Hoje um Bash autorizado nas definições pode escrever ou fazer commit na pasta de quem perguntou, e a consulta não tem checkpoint para rebobinar. A 1 desfaz-se tirando o nome da lista. Se o smoke mostrar que `disallowedTools` não ganha à regra, passa-se à 2; até lá não se misturam as duas no código.

O Codex da consulta abre em modo só de leitura. Esse caminho é outra prova, já listada no `DECISIONS.md`, e não muda esta escolha.

## 3. Testemunho e bifurcação de uma consulta

A nota da revisão junta os dois gestos. No código estão separados.

**Passar o testemunho** está aberto. `handoffGate` (`handoff-model.ts`) só olha se a sessão está ocupada ou se já passou. O motor (`handoff` em `session-manager.ts`) abre uma sessão com origem `handoff` na mesma pasta. Essa origem não é consulta: não leva `readOnly` nem a recusa de permissões, e recebe os servidores MCP do projeto (a consulta em si não os recebe). A pasta da consulta é `shared`, sem worktree. A sessão nova pode escrever aí.

**Bifurcar** já não segue. `forkGate` desliga-se com pasta `shared` ou sem linha do tempo, e a consulta não cria checkpoints (`asking ? undefined` no `create`). O botão fica desligado, com a razão «Só em projetos git». Se o comando `session.fork` chegar na mesma, o motor falha em «Este turno não tem checkpoint» e não abre sessão.

1. **Recusar a passagem no motor e esconder «Passar a…» na consulta.** A bifurcação fica como está. Para continuar o trabalho, abre-se uma sessão normal.
2. **Recusar os dois no motor**, também o `session.fork`, para a recusa não depender da falta de checkpoint.
3. **Permitir a passagem numa worktree nova**, nunca na pasta partilhada. A consulta continua só de leitura; quem recebe o testemunho escreve no branch dele.

**Por omissão: a 1.** A bifurcação já não escreve a partir de uma consulta. O buraco é a passagem, que transforma a sessão só de leitura numa sessão que escreve na pasta de outra. Esconder o botão e deixar o comando `handoff.start` aberto não chega.

**Segurança e desfazer.** A 1 não apaga a consulta. Tira o gesto. A 3 é trabalho novo (worktree a partir de uma consulta) e só faz sentido depois de se querer mesmo passar o testemunho a partir daqui. A delegação não entra: já nasce com worktree e com escrita.

## 4. Aprovar memórias externas em lote

Uma memória externa foi proposta num turno que leu a web, um MCP que não é o da Solline, um comando de rede, a resposta de uma consulta, ou uma ferramenta que o motor não sabe classificar (`packages/engine/src/memory/external.ts`; na dúvida, é externa). Na lista, a caixa dessas propostas fica desligada e «Escolher todas» não as inclui (`batchSelectable` em `memory-model.ts`). Aprovar uma a uma, com o aviso no cartão, continua. O motor, em `memory.approve` (`memory/manager.ts`), não lê `external`: vários ids de uma vez são aceites. Quem chamar o motor sem a interface aprova o lote.

1. **O motor recusa a chamada se houver mais do que um id e algum for externo.** Uma de cada vez continua válida. A interface fica como está. A chamada é tudo ou nada, como já é quando um id não existe.
2. **O motor também recusa uma memória externa sozinha**, até a chamada trazer um campo explícito de que a leste.
3. **O motor continua a aceitar o lote.** A barreira fica só na interface.

**Por omissão: a 1.** É a regra que a interface já mostra, no sítio que a interface não contorna. Aprovar uma a uma, com o aviso que já está no cartão, continua a ser a leitura. A 2 pede um segundo gesto para uma proposta que já se lê isolada.

**Segurança e desfazer.** Uma memória aprovada entra no índice que os agentes recebem no arranque. Recusar o lote não apaga nada: as propostas ficam `pending`. Desfazer a 1 é tirar essa verificação do `approve`.
