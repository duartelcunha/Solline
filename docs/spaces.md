# Espaços, tarefas e aprendizagem

O Geral reúne ideias e sugestões dos projetos autorizados. Cada projeto tem uma lista de tarefas e uma memória própria. A Mesa continua a acompanhar as sessões em execução.

## Comportamento

- Uma linha cria uma tarefa, sem iniciar agentes. O painel lateral permite editar o contexto, escolher conversa nova/existente e rever o pedido e as memórias antes de delegar.
- A escolha do agente é manual. As opções de modelo ficam recolhidas. O fim de um turno coloca a tarefa para revisão; só a pessoa a conclui.
- As tentativas conservam o pedido enviado, a conversa textual, o resultado e as contas das alterações. Enquanto a sessão estiver disponível, o botão de alterações abre o turno exato no revisor.
- Geral e projetos mantêm os seus contextos separados. Uma tarefa de projeto não pode ser enviada para uma sessão de outro projeto. Memórias de projeto só passam a gerais por ação explícita.

## Análise e aprendizagem

Definições iniciais: análise a pedido, aprendizagem por aprovação, nenhum projeto autorizado e nenhum agente escolhido.

O modo proativo só trabalha com a app aberta, visível e sem interação recente, quando o motor está ocioso. Faz no máximo uma análise por dia e reutiliza o contexto já analisado. Erros, falta de login ou quota suspendem a análise; nunca troca de agente nem inicia tarefas a partir de sugestões.

O primeiro perfil de análise verificado é o Claude: sem ferramentas de ficheiros, terminal ou rede; sem MCP, definições ou hooks do projeto. O motor recolhe os excertos e valida os IDs das fontes devolvidos pelo modelo. Os agentes Claude, Codex e ACP continuam disponíveis para executar tarefas através das sessões normais.

A leitura é seletiva e limitada: até 200 ficheiros por projeto, excertos até 24 000 caracteres e até 100 000 caracteres por análise. Ficheiros já vistos não voltam a gastar contexto. Ficheiros sensíveis, diretórios de dependências e ligações para fora da raiz ficam excluídos; padrões conhecidos de segredos são omitidos. A enumeração Git desativa fsmonitor e untracked cache para não executar configurações do repositório.

Sugestões têm fontes e excertos guardados. Aceitar cria apenas uma tarefa. Sugestões dispensadas não reaparecem com o mesmo título normalizado. Memórias têm origem, âmbito e estado; podem ser aprovadas, editadas, desativadas, promovidas ou apagadas. A eliminação guarda apenas uma impressão digital para evitar reaprendizagem literal.

## Recuperação e contrato

O motor é o único escritor. A ponte valida os comandos `spaces.*`; o main resolve os projetos e a pasta interna do Geral. O renderer nunca fornece caminhos de leitura ou de execução.

O estado integra os snapshots e eventos sequenciados do journal cifrado existente. Cada delegação grava uma intenção e um identificador estável antes de criar/enviar. O mesmo identificador acompanha a mensagem pela fila até ao turno. Um restauro marca tentativas em trânsito como incertas e não reenvia nada. Tentativas ainda na fila impedem uma segunda delegação da mesma tarefa.

Resultados textuais são limitados a 20 000 caracteres por tentativa; a conversa guardada contém até 50 mensagens textuais. As ferramentas e diffs completos continuam na sessão e nos checkpoints existentes. A memória não altera permissões, confiança ou configurações dos agentes.

## Verificação

Os testes cobrem criação sem execução, gravação falhada, isolamento, associação de turnos, restauro sem duplicação, conservação do resultado após fechar a sessão, leitura limitada, redaction, fsmonitor, permissões do perfil, análise incremental e supressão de sugestões. O QA inclui os dois temas, teclado e janela estreita, além de um percurso real Electron com agente determinístico e reinício. Não é necessário consumir modelos reais para estes testes.

Usar `qa/verify.mjs` com rótulos diferentes para as duas execuções finais. A suite do renderer deve usar o build imutável (`SOLLINE_QA_FRESH=1`); o modo de desenvolvimento ativa as invocações duplicadas de efeitos do React StrictMode e não representa esse gate.
