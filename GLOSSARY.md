# Glossário

Os nomes do domínio da Solline, como o código os usa.

- **Agente**: o programa que faz o trabalho (Claude Code, Codex, um agente ACP). Entra na Solline
  com o login da subscrição, feito por ele próprio.
- **Adapter**: a peça do motor que fala o transporte de um agente (SDK, app-server, ACP) e o traduz
  para o modelo neutro da conversa. Um por transporte, em `packages/engine/src/adapters`.
- **Sessão**: uma conversa com um agente numa pasta de projeto. Tem um estado: `starting`, `idle`,
  `running`, `needs-you` ou `error`.
- **Turno**: uma mensagem do utilizador e tudo o que o agente faz até responder.
- **Pedido**: o agente pára e espera pelo utilizador, para autorizar uma ferramenta (permissão) ou
  para responder a uma pergunta. Fica na conversa como um bloco com estado final.
- **SessionShell**: a casca comum a todos os adapters. Guarda os pedidos abertos, valida a resposta
  pelo próprio bloco, trata as quedas e é a única que muda o estado da sessão. O adapter só lhe diz
  o que aconteceu.
- **Queda**: o agente morreu ou o canal fechou sem aviso. Cancela os pedidos e deixa a sessão em
  erro; fechar a sessão de propósito não conta como queda.
- **Revisor**: o agente que lê o diff de um turno e aponta problemas (erro, risco, ruído). Só lê. Na
  segunda opinião é de outro fabricante quando dá, senão é do mesmo.
- **Fila**: o que escreves enquanto o agente trabalha. Cada mensagem segue sozinha quando o turno
  acaba, como um turno seu (com checkpoint). Interromper pausa a fila.
- **Guiar**: mandar uma mensagem a meio do turno ("Agora", Ctrl+Enter), que o agente lê na próxima
  pausa sem abrir outro turno. Só nos agentes que aceitam; se já for tarde, vai para a fila.
- **Lida (absorvida)**: a mensagem guiada já chegou ao agente.
- **SessionTurns**: o dono do turno de uma sessão: um de cada vez, a fila, guiar e as ações que
  não podem coincidir com um turno (rebobinar, desfazer, trazer).
- **Verificador**: corre as verificações do projeto numa pasta de trabalho e, para as que falham,
  volta a corrê-las na base, para separar o que a mudança partiu do que já estava partido. É o
  sinal objetivo antes de qualquer opinião (corridas, segunda opinião, CI, objetivos).
- **Juiz cego**: desempata tentativas que a execução não separou. Vê o pedido, os diffs e as
  verificações, com as tentativas por letra; nunca o agente nem o que ele disse. Julga nas duas
  ordens; se discordarem, é empate e decide o Duarte.
- **Corrida**: o mesmo pedido em 2 a 4 pistas ao mesmo tempo. Acaba quando todas param e é então
  ordenada.
- **Pista**: uma sessão de uma corrida, sempre na sua worktree, com o agente e o modelo que escolheste.
- **Veredicto**: a ordem das pistas (execução, depois consenso, depois o juiz só nos empates), com o
  melhor e o pior de cada uma. Um empate que ninguém desfez fica para ti: "escolhe tu".
- **Consenso**: pistas que chegaram ao mesmo patch (sem contar espaços nem ordem dos ficheiros)
  formam um grupo; o grupo maior ganha entre pistas igualmente verdes.
- **Espaço**: onde vivem as tarefas, memórias e sugestões de um projeto, ou do "Geral" quando não
  pertencem a nenhum. Cada espaço tem as suas definições de análise e aprendizagem.
- **Tarefa**: o que queres ver feito (`todo`, `active`, `review`, `done`). Guarda as tentativas e
  pode vir de uma memória ou de uma sugestão.
- **Tentativa**: uma delegação concreta de uma tarefa a uma sessão, com o resultado e as mudanças.
- **Delegação**: passar uma tarefa a uma sessão existente ou nova. É sempre um gesto teu: nada
  arranca agentes sozinho, nem ao navegar nem ao retomar.
- **Memória**: algo que os agentes (ou a análise da Solline) propõem e só chega aos agentes depois de
  a aprovares. Estados: `pending` (proposta), `active`, `disabled` e `toConfirm` ("a confirmar").
  Um agente propõe sempre com uma prova (citações) e um motivo; só tu a tornas geral.
- **Prova**: as citações de uma memória (`{path, line?, endLine?}` dentro do projeto, ou um commit) e o
  hash do que diziam quando aprovaste. Se mudou, a memória passa a "a confirmar".
- **A confirmar** (`toConfirm`): memória aprovada cuja prova mudou, ou que um agente propôs e ficou 28
  dias sem uso. Não entra no índice; `read_memory` ainda a devolve, com o aviso. Confirmar renova tudo.
- **Índice da memória**: as linhas "id · texto curto" (até 30, ~3k caracteres) que seguem no arranque,
  ao lado das regras. O texto inteiro vai por `read_memory`; `search_memory` procura por termos.
- **Origem externa** (`external`): a proposta saiu de um turno que leu a web ou usou servidores MCP de
  terceiros. Aparece ao aprovar; nunca se aprova sozinha.
- **Sugestão**: uma proposta da análise (`suggested`, `accepted`, `dismissed`), com as fontes.
- **Retoma**: abrir a Solline onde estavas (projeto, tarefa, painel, sessão ou corrida). Também podes
  escolher abrir nas Tarefas do Geral ou na Mesa. Guarda só identificadores, nunca conteúdo.
- **Recuperação**: o registo durável e cifrado de sessões, tarefas e corridas. Depois de um fecho
  inesperado nada se perde: as pistas voltam em erro e uma corrida que estava a correr ou a ordenar
  volta a "acabaram todas".
- **Repartição**: um pedido partido em 2 a 4 partes diferentes que correm ao mesmo tempo e se
  juntam no fim. É uma função pedida, nunca o padrão.
- **Parte**: o que uma pista de uma repartição faz, com o seu contrato.
- **Contrato**: objetivo, o que pode e não pode tocar, interfaces combinadas, resultado esperado e a
  verificação do projeto que tem de passar.
- **Parte zero**: a que fixa uma interface antes das outras arrancarem, que partem do resultado dela.
- **Integração**: juntar as partes numa worktree de integração, uma a uma, com as verificações
  depois de cada junção; num conflito, uma sessão normal resolve e as verificações confirmam.
- **Segunda opinião**: a revisão de um turno (ou de um pedido) por um revisor de outro fabricante,
  só de leitura. Corre no fim do turno, a pedido e antes de trazer. Nunca bloqueia.
- **Achado**: um erro ou risco apontado pelo revisor, com prioridade (P0 a P3) e confiança. À vista
  no máximo 5 com confiança alta; o resto fica dobrado.
- **Passagem de testemunho**: passar uma sessão a outro agente com um rascunho editável do que foi
  feito e do que falta. A sessão antiga fica só para ler.
- **Rascunho**: o resumo que um redator escreve para a passagem, com secções fixas. Se o redator
  falhar, sai um rascunho mecânico.
- **Bifurcação**: uma sessão nova a partir de um turno, numa worktree própria, no estado que tinha
  nesse turno. Só em projetos git.
- **Linhagem**: de que sessão nasceu cada uma (passagem, bifurcação, corrida, parte, tarefa, consulta ou
  delegação). Guarda só ids.
- **Mapa**: a vista em árvore da linhagem de um projeto. Opcional; a cor é a do fabricante.
- **Cérebro**: o servidor MCP `solline` que o motor dá aos agentes de cada sessão normal. Em
  processo no Claude; por um shim e um canal local nos outros. Cada chamada sabe de que sessão é.
- **Regra do projeto**: uma instrução curta, escrita pelo utilizador e guardada na Solline, que chega a
  todos os agentes do projeto no formato de cada um. Com padrões de ficheiro, entra inteira ao tocar neles.
- **Perguntar a… (`ask_agent`)**: um agente pergunta a outro, com a tua aprovação num cartão. Vai ao
  fabricante oposto (ou ao mesmo, se o outro não estiver pronto) e a resposta volta ao agente que perguntou.
- **Delegar (`delegate`)**: um agente entrega uma tarefa a uma sessão nova, com worktree e branch próprios,
  com a tua aprovação. Quando o primeiro turno acaba, quem delegou recebe na fila um resumo; trazer o
  trabalho continua a ser teu.
- **Consulta**: a sessão visível que responde a um «Perguntar a…». Só lê, na mesma pasta, e fica aberta
  para continuares. Filha de quem perguntou no Mapa.
- **Cartão de consulta**: o pedido pendente de perguntar ou delegar. Permitir, permitir nesta sessão
  (por tipo) ou recusar; fechar a sessão ou interromper o turno cancela-o.
- **Catálogo MCP**: a lista global de servidores MCP que acrescentaste à Solline (do registo oficial ou à
  mão), cada um com o comando exato, o estado de aprovação e as ferramentas. Fica no diretório de dados,
  sem segredos; os valores secretos vivem no Gestor de Credenciais do Windows.
- **Aprovação exata**: a confirmação nativa, no main, com o comando, os argumentos e os nomes das
  variáveis que a Solline vai arrancar. Mudar qualquer um deles volta a pedi-la.
- **Impressão das ferramentas**: os nomes, as descrições e um hash das ferramentas que um servidor
  anunciou quando o aprovaste. A Solline volta a sondar na primeira entrega de cada execução; se o hash
  mudou, o servidor fica a pedir nova aprovação e não é entregue.
- **Escolha por projeto**: no separador MCP de um projeto, os servidores do catálogo que ele usa (até 8).
  Chegam a cada sessão nova dele ao arrancar, sem tocar nas configs dos agentes. Pistas, partes, consultas e
  delegações ficam sem eles. O catálogo em si está no separador MCP de Geral.
- **Caixa de memórias**: no separador Memória de um Espaço, as propostas dos agentes à espera de ti e as
  «a confirmar». Aprova-se, edita-se ou recusa-se em lote; uma proposta de origem externa só se aprova
  uma a uma.
