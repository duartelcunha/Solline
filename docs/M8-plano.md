# M8: medir, ver e só depois automatizar

Plano para implementar. Cada fatia começa aqui, antes do código. Parte do `main` em `ca95a44` (M6 e M7 fechados).

O Duarte aceitou as quatro decisões como recomendadas. O registo está no `DECISIONS.md`.

1. **Métrica.** Trabalho aceite e sem regressão, por hora da atenção dele. A qualidade é condição fixa. O consumo é a segunda medida.
2. **Juiz.** Modo sombra e recomendação. As confirmações humanas atuais ficam. O juiz não aprova push, merge nem apagar.
3. **Modelo.** Mantém-se o atual. O percurso económico fica opt-in até passar o piloto.
4. **Intenção e plano.** Objetos locais, ligados a commits e PRs. Sem ficheiros de regra novos e sem autoload de `CLAUDE.md` ou `AGENTS.md`.

Ordem fechada a 2026-11-06, com o orçamento curto: M8.0 e depois M8.1. M8.2, M8.3, M8.4 e M8.5 ficam adiados. Não se começa o livro de custo, o ciclo de correção, o juiz nem a troca de modelo nesta ronda. Sem auto-push, auto-merge, ou juiz a ultrapassar uma confirmação.

## M8.0 — A verdade

Saber o que já funciona, com critérios congelados, antes de pôr autonomia por cima.

**Entra.** Alinhar README, STATUS e visão com o M6 e o M7. Matriz de capacidades por marco, com presente, parcial ou ausente, e o ficheiro que o sustenta. Corpus de 42 tarefas reais tiradas dos commits do repositório, com critérios congelados. A divisão é mecânica: na ordem cronológica, o índice módulo 3 igual a 2 é avaliação; o resto é afinação. Harness repetível do ensaio emparelhado: cliente nativo com o modelo de referência, Solline com o mesmo modelo, Solline com o modelo económico. A ordem dos dois primeiros alterna. A aceitação só conta se a revisão não viu a configuração. Uma alavanca de cada vez, numa corrida nova, com o mesmo corpus.

**Sucesso.** A linha de base corre duas vezes e dá o mesmo relatório. O que não foi medido fica `not-measured`, com motivo, e nunca entra numa soma como zero. O smoke de regras nativas, consulta sem Bash, commit sem push, push com confirmação, e CI com arquivo fica visível como prova de código. A execução contra agentes reais fica por medir quando não há cliente.

**Fica fora.** Funcionalidades novas de produto, ler credenciais, CI paga obrigatória, e tratar este corpus como amostra bastante para um ganho pequeno. Não se somam poupanças de contexto, cache e routing.

## Feito no M8.0

README, STATUS e visão dizem o que o M6 e o M7 fizeram, incluindo o que não entrou (Linear, ciclo, livro, juiz). A matriz está em `docs/M8-matriz.md` e em `packages/engine/src/pilot/matrix.ts`. O corpus tem 42 tarefas, 28 de afinação e 14 de avaliação, seladas antes de medir. O harness está em `packages/engine/src/pilot/harness.ts`.

Nesta máquina não há cliente de modelo. A corrida de 2026-11-06 deixa aceitação, atenção, duração e tokens por medir. O smoke confirma no código as regras nativas, a consulta sem Bash e sem testemunho, o commit sem push, a confirmação do push, e a CI com arquivo. Não correu contra um Claude ou um Codex reais.

## Adiado

M8.2 (livro de custo e orçamento), M8.3 (ciclo check, corrigir, check), M8.4 (juiz em sombra) e M8.5 (escolha de modelo) não se fazem nesta ronda. A decisão do Duarte é parar depois do M8.1. Cada uma, se voltar, escreve o seu plano aqui antes de se construir.

## A seguir

M8.1, clareza visual. O plano dessa fatia escreve-se aqui antes do código.
