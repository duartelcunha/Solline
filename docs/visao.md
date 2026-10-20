# Solline: o melhor de cada harness, numa só ferramenta

A Solline já corre o Claude Code, o Codex, modelos DeepSeek e qualquer agente ACP no mesmo motor
(`docs/plano.md`). Isso é a base. O objetivo é outro: pegar no que cada ferramenta faz melhor, dá-lo
a todos os agentes por igual e embrulhá-lo numa experiência visual que dá gosto usar, como um jogo
bem feito mas para trabalho a sério.

Esta página junta três levantamentos de outubro de 2026 (Claude Code e Codex; Cursor, Zed, Copilot,
Antigravity e Kiro; Conductor, Amp, OpenCode, Warp, Devin e outros orquestradores) e transforma-os
em marcos.

## O que a Solline consegue fazer que mais ninguém faz

Cada fabricante só junta funcionalidades dentro do próprio harness. A Solline fala com todos, por
isso pode cruzá-los:

1. O mesmo pedido corre no Claude, no Codex e no DeepSeek ao mesmo tempo, cada um na sua worktree.
   Um quarto modelo avalia as três soluções e tu montas o resultado pedaço a pedaço, escolhendo os
   melhores hunks de cada uma. O Cursor faz best-of-N, mas só dentro do Cursor e fica com uma
   tentativa inteira.
2. Um checkpoint em cada turno, para qualquer agente, mesmo os que não os têm. Rebobinas a um turno
   e continuas dali com outro agente, que recebe um resumo editável do que ficou para trás.
3. Uma segunda opinião de outro fabricante em cada turno: o Codex revê o que o Claude fez (ou o
   contrário) antes de tu veres o diff, e os achados aparecem colados às linhas.
4. Um só cérebro: regras do projeto escritas uma vez e traduzidas para o formato de cada agente,
   memória partilhada e uma ferramenta `ask_agent` para qualquer agente consultar outro. O que o
   Codex aprende na segunda, o Claude já sabe na terça.
5. Do pedido ao PR com a CI verde, com os agentes certos em cada passo e um só contador de uso para
   todas as subscrições. Hoje isto obriga a juntar Conductor, Cursor, Happy, Jules e tokscale.

## Como tem de se sentir

O produto é para developers e builders que querem perceber o que se passa sem ler paredes de texto.
Regras que valem para todos os marcos:

- Mostrar em vez de escrever. Agentes em paralelo aparecem como pistas lado a lado, o plano como um
  mapa de tarefas, o contexto e o custo como medidores, a linha do tempo de uma sessão como uma barra
  que se arrasta para rebobinar.
- Um motion system com tokens próprios em `packages/ui`: curvas fortes (`ease-out`
  `cubic-bezier(0.23, 1, 0.32, 1)` para entradas, `cubic-bezier(0.77, 0, 0.175, 1)` para movimento
  no ecrã), animações de interface abaixo de 300 ms, molas para tudo o que se arrasta ou se
  interrompe (rebobinar, reordenar, dispensar), saída mais rápida do que a entrada, nada que entre a
  partir de `scale(0)`.
- O que se faz cem vezes por dia não anima: atalhos de teclado, paleta de comandos, trocar de sessão.
  O deleite fica para momentos raros e merecidos: um PR que entra, um best-of-N que revela o
  vencedor, a primeira sessão.
- Cada clique responde logo (`scale(0.97)` ao premir), cada estado do agente vê-se de relance (a
  trabalhar, precisa de ti, terminou) e uma tarefa concluída dá uma pequena recompensa visual, sem
  confetes em todo o lado.
- `prefers-reduced-motion` troca movimento por opacidade, nunca tira a informação.
- Antes de desenhar ou animar, carregar a skill certa (impeccable, emil-design-eng, apple-design,
  animate, animation-performance) e rever as animações em câmara lenta no dia seguinte.

## Marcos

A ordem segue o valor e as dependências: primeiro o que dá confiança para deixar os agentes
trabalhar, depois o paralelismo, depois o que só a Solline pode fazer.

### M2: rever e desfazer, com o motion system por baixo

Cada turno de qualquer agente fica com um checkpoint escondido (um git sombra da pasta), sem precisar
de apoio do agente. Depois de cada turno, um painel de diff mostra todas as alterações num só sítio,
hunk a hunk: aceitar, rejeitar, desfazer, comentar uma linha. Os comentários seguem como a próxima
mensagem para o agente. A linha do tempo da sessão arrasta-se para rebobinar ficheiros; rebobinar a
conversa usa o que o agente tiver (o SDK do Claude e o app-server do Codex sabem; nos agentes ACP
abre-se uma sessão nova com um resumo). Este marco cria também os tokens de motion e os componentes
base (diff, linha do tempo, estados), porque tudo o resto os usa.

Inspiração: revisão por hunks do Zed e do Cursor 3, `/rewind` do Claude Code, `/restore` do Gemini
CLI, comentários em linha do Codex e do Vibe Kanban.

Estado (20/10/2026): feito. Checkpoint por turno num git sombra para todos os agentes, painel
"Rever" hunk a hunk com comentários em linha, linha do tempo com mola que rebobina ficheiros e
conversa (no Claude e no Codex no próprio agente, no ACP com resumo) e o motion system em
`packages/ui`. Decisões e limites em `DECISIONS.md`.

### M3: vários agentes em paralelo, numa mesa

Cada sessão pode ter a sua worktree e o seu branch, criados pelo motor e passados a qualquer agente.
Um script por projeto prepara cada worktree (dependências, `.env`, uma porta própria por sessão). A
vista principal passa a ser uma mesa com um cartão vivo por agente: o que está a fazer agora, quanto
contexto gastou, se precisa de ti. Notificações do sistema quando alguém fica à espera ou termina. Uma
fila de mensagens para mandar a seguinte enquanto o agente trabalha, e conduzir a meio do turno nos
agentes que o aceitam.

Inspiração: Conductor (worktrees, scripts, portas), painel de agentes do Warp, vista de sessões do
Claude e do Codex.

### M4: best-of-N entre harnesses, com juiz

Um pedido corre em N agentes ou modelos ao mesmo tempo, em N worktrees. As pistas correm lado a lado
e, no fim, um agente juiz de outro fabricante (mais os testes, se existirem) ordena as soluções e
explica porquê. Tu comparas os diffs lado a lado e montas o resultado hunk a hunk a partir de várias
tentativas. É o primeiro marco que nenhuma outra ferramenta oferece.

Inspiração: `/best-of-n` do Cursor, tentativas múltiplas do Vibe Kanban.

### M5: segunda opinião e passagem de testemunho

No fim de cada turno (ou antes de um commit), um revisor de outro fabricante lê o diff e os achados
ficam colados às linhas no painel do M2. Uma passagem de testemunho resume uma sessão num ponto de
partida editável para outro agente (planear no Claude, executar no Codex, rever no Claude). Um mapa
mostra a linhagem: que sessão nasceu de qual, que checkpoint foi bifurcado.

Inspiração: Bugbot do Cursor, `/review` do Codex, crítico do Jules, handoff e Thread Map do Amp.

### M6: um só cérebro para todos os agentes

Regras do projeto escritas uma vez, com âmbito por tipo de ficheiro, traduzidas para `CLAUDE.md`,
`AGENTS.md` ou prompt de sistema conforme o agente. Uma memória partilhada (servidor MCP do motor),
com cada memória nova aprovada por ti. As ferramentas `ask_agent` e `delegate` deixam qualquer agente
pedir uma segunda opinião ou passar uma subtarefa a outro. O catálogo MCP passa a ser global e
sincronizado com todos.

Inspiração: steering do Kiro, regras e memórias do Cursor, Oracle do Amp, sincronização MCP do AionUi.

### M7: do pedido ao PR

Começar uma sessão a partir de uma issue (GitHub, Linear), com o branch e o contexto já preenchidos.
Commit, PR, estado da CI e correção automática de checks falhados dentro da app, com o agente certo
a corrigir. Um PR que entra arquiva a sessão (e merece a tal pequena celebração).

Inspiração: loop de PR do Claude desktop, Conductor, Emdash.

### M8: uso, custo e objetivos sem supervisão

Um só contador de uso e custo para todas as subscrições e APIs, com o limite de cada plano à vista
(o Codex desta conta ia em 78% do limite mensal). Objetivos longos ("até os testes passarem") com um
verificador neutro, aprovações tratadas por um modelo juiz de outro fabricante e passagem para um
modelo mais forte quando o progresso para.

Inspiração: `/goal` do Codex e do Claude, auto-review do Codex, tokscale e ccusage.

### Depois

Pré-visualização de browser que os agentes conseguem conduzir (como servidor MCP), pesquisa em todo o
histórico de sessões, artefactos e walkthroughs comentáveis, receitas reutilizáveis (prompt, MCP,
skills, modelo), tarefas agendadas, controlo a partir do telemóvel e execução remota por SSH.

## O que fica de fora

Autocomplete ao escrever (pede um modelo dedicado e um editor completo) e a cloud de cada fabricante
(não é neutra; a alternativa é um motor remoto por SSH).
