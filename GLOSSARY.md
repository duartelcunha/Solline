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
- **Revisor**: o segundo agente que lê o diff de um turno e aponta problemas (bug, risco, ruído).
- **Fila**: o que escreves enquanto o agente trabalha. Cada mensagem segue sozinha quando o turno
  acaba, como um turno seu (com checkpoint). Interromper pausa a fila.
- **Guiar**: mandar uma mensagem a meio do turno ("Agora", Ctrl+Enter), que o agente lê na próxima
  pausa sem abrir outro turno. Só nos agentes que aceitam; se já for tarde, vai para a fila.
- **Lida (absorvida)**: a mensagem guiada já chegou ao agente.
- **SessionTurns**: o dono do turno de uma sessão: um de cada vez, a fila, guiar e as ações que
  não podem coincidir com um turno (rebobinar, desfazer, trazer).
