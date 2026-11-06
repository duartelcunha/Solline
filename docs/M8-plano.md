# M8: medir, ver e só depois automatizar

Plano para implementar. Cada fatia começa aqui, antes do código. Parte do `main` em `ca95a44` (M6 e M7 fechados).

O Duarte aceitou as quatro decisões como recomendadas. O registo está no `DECISIONS.md`.

1. **Métrica.** Trabalho aceite e sem regressão, por hora da atenção dele. A qualidade é condição fixa. O consumo é a segunda medida.
2. **Juiz.** Modo sombra e recomendação. As confirmações humanas atuais ficam. O juiz não aprova push, merge nem apagar.
3. **Modelo.** Mantém-se o atual. O percurso económico fica opt-in até passar o piloto.
4. **Intenção e plano.** Objetos locais, ligados a commits e PRs. Sem ficheiros de regra novos e sem autoload de `CLAUDE.md` ou `AGENTS.md`.

Ordem de 2026-11-06: M8.0 e depois M8.1. Sem auto-push, auto-merge, ou juiz a ultrapassar uma confirmação.

## M8.0 — A verdade

Saber o que já funciona, com critérios congelados, antes de pôr autonomia por cima.

**Entra.** Alinhar README, STATUS e visão com o M6 e o M7. Matriz de capacidades por marco, num só sítio (`packages/engine/src/pilot/matrix.ts`). Dez tarefas reais, só de avaliação, com critérios congelados. Dois braços, o mesmo modelo: cliente nativo e Solline. Métricas: tarefas aceites, e minutos com a janela da Solline em foco por tarefa aceite (proxy da atenção). Tokens só quando o cliente os reporta. O que falta fica por medir.

**Sucesso.** A linha de base corre duas vezes e dá o mesmo relatório. O que não foi medido fica `not-measured`, com motivo, e nunca entra numa soma como zero. O smoke de regras nativas, consulta sem Bash, commit sem push, push com confirmação, e CI com arquivo fica visível como prova de código. A execução contra agentes reais fica por medir quando não há cliente.

**Fica fora.** Funcionalidades novas de produto, ler credenciais, CI paga obrigatória, e tratar este corpus como amostra bastante para um ganho pequeno. Não se somam poupanças de contexto, cache e routing.

## Feito no M8.0

README, STATUS e visão dizem o que o M6 e o M7 fizeram, incluindo o que não entrou (Linear, ciclo, livro, juiz). A matriz está só em `packages/engine/src/pilot/matrix.ts`. O corpus tem 10 tarefas de avaliação. O harness tem dois braços e está em `packages/engine/src/pilot/harness.ts`.

Nesta máquina não há cliente de modelo. A corrida de 2026-11-06 deixa aceitação, atenção, duração e tokens por medir. O smoke confirma no código as regras nativas, a consulta sem Bash e sem testemunho, o commit sem push, a confirmação do push, e a CI com arquivo. Não correu contra um Claude ou um Codex reais.

## Adiado

M8.2 (livro de custo e orçamento), M8.3 (ciclo check, corrigir, check), M8.4 (juiz em sombra) e M8.5 (escolha de modelo) não se fazem nesta ronda. A decisão do Duarte é parar depois do M8.1. Cada uma, se voltar, escreve o seu plano aqui antes de se construir.

## M8.1 — Clareza

Ver o estado e o próximo passo sem procurar, e tirar da frente o que não se decide agora.

**Entra.** O título da sessão e do cartão pode ocupar duas linhas. Por baixo do estado fica uma frase com o próximo passo, sempre visível. Modelo, esforço e modo ficam no mesmo grupo e o nome do esforço não desaparece. A corrida diz «Corrida», não «1×». O cartão da mesa deixa de mostrar custo, porta e medidor de contexto; ficam o estado, o pedido, a fila, as verificações que falharam e o que mudou. Junto ao compositor, uma linha diz quantos ficheiros mudaram e se as verificações passaram. O painel Rever, quando está aberto, fica mais largo. O contraste do texto atual já passa 4,5:1; não se mexe nas cores.

**Não entra.** Rebrand, livro de custo, orçamento, ciclo de correção, juiz e troca de modelo. O painel Rever não abre sozinho.

**Prova.** Capturas antes e depois, tema claro e escuro, janela larga e estreita.

## Feito no M8.1

O cabeçalho mostra o título em duas linhas e o próximo passo. Modelo, esforço e modo estão no mesmo grupo, com o nome do esforço sempre visível. A corrida diz «Corrida». A mesa deixa de mostrar custo, porta e medidor. O compositor resume ficheiros por rever e verificações. O painel Rever, aberto, ocupa mais da sessão. As cores não mudaram: o texto secundário já passa 4,5:1.

## A seguir

Nada nesta ronda. M8.2 em diante está na secção Adiado.
