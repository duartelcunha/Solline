# M8: medir, ver e só depois automatizar

Plano para implementar. Cada fatia começa aqui, antes do código. Parte do `main` em `ca95a44` (M6 e M7 fechados).

O Duarte aceitou as quatro decisões como recomendadas. O registo está no `DECISIONS.md`.

1. **Métrica.** Trabalho aceite e sem regressão, por hora da atenção dele. A qualidade é condição fixa. O consumo é a segunda medida.
2. **Juiz.** Modo sombra e recomendação. As confirmações humanas atuais ficam. O juiz não aprova push, merge nem apagar.
3. **Modelo.** Mantém-se o atual. O percurso económico fica opt-in até passar o piloto.
4. **Intenção e plano.** Objetos locais, ligados a commits e PRs. Sem ficheiros de regra novos e sem autoload de `CLAUDE.md` ou `AGENTS.md`.

Ordem: M8.0, depois M8.1 e M8.2, depois M8.3, M8.4, e M8.5 só se uma medição real o justificar. Sem auto-push, auto-merge, ou juiz a ultrapassar uma confirmação.

## M8.0 — A verdade

Saber o que já funciona, com critérios congelados, antes de pôr autonomia por cima.

**Entra.** Alinhar README, STATUS e visão com o M6 e o M7. Matriz de capacidades por marco, com presente, parcial ou ausente, e o ficheiro que o sustenta. Corpus de 42 tarefas reais tiradas dos commits do repositório, com critérios congelados. A divisão é mecânica: na ordem cronológica, o índice módulo 3 igual a 2 é avaliação; o resto é afinação. Harness repetível do ensaio emparelhado: cliente nativo com o modelo de referência, Solline com o mesmo modelo, Solline com o modelo económico. A ordem dos dois primeiros alterna. A aceitação só conta se a revisão não viu a configuração. Uma alavanca de cada vez, numa corrida nova, com o mesmo corpus.

**Sucesso.** A linha de base corre duas vezes e dá o mesmo relatório. O que não foi medido fica `not-measured`, com motivo, e nunca entra numa soma como zero. O smoke de regras nativas, consulta sem Bash, commit sem push, push com confirmação, e CI com arquivo fica visível como prova de código. A execução contra agentes reais fica por medir quando não há cliente.

**Fica fora.** Funcionalidades novas de produto, ler credenciais, CI paga obrigatória, e tratar este corpus como amostra bastante para um ganho pequeno. Não se somam poupanças de contexto, cache e routing.

## A seguir

M8.1 clareza visual. M8.2 livro de custo e orçamento. M8.3 ciclo check, corrigir, check, opt-in. M8.4 juiz em sombra. M8.5 só com medição. Cada uma escreve o seu plano nesta página antes de se construir.
