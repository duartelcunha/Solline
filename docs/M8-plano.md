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

O M8.4 está parado: o parecer em sombra não entra na cadeia de merge. O M8.5 só corre com estas 10 tarefas quando houver uma pergunta concreta. Sem essa pergunta, fica adiado.

## M8.1 — Clareza

Ver o estado e o próximo passo sem procurar, e tirar da frente o que não se decide agora.

**Entra.** O título da sessão e do cartão pode ocupar duas linhas. Por baixo do estado fica uma frase com o próximo passo, sempre visível. Modelo, esforço e modo ficam no mesmo grupo e o nome do esforço não desaparece. A corrida diz «Corrida», não «1×». O cartão da mesa deixa de mostrar custo, porta e medidor de contexto; ficam o estado, o pedido, a fila, as verificações que falharam e o que mudou. Junto ao compositor, uma linha diz quantos ficheiros mudaram e se as verificações passaram. O painel Rever, quando está aberto, fica mais largo. O contraste do texto atual já passa 4,5:1; não se mexe nas cores.

**Não entra.** Rebrand, livro de custo, orçamento, ciclo de correção, juiz e troca de modelo. O painel Rever não abre sozinho.

**Prova.** Capturas antes e depois, tema claro e escuro, janela larga e estreita.

## Feito no M8.1

O cabeçalho mostra o título em duas linhas e o próximo passo. Modelo, esforço e modo estão no mesmo grupo, com o nome do esforço sempre visível. A corrida diz «Corrida». A mesa deixa de mostrar custo, porta e medidor. O compositor resume ficheiros por rever e verificações. O painel Rever, aberto, ocupa mais da sessão. As cores não mudaram: o texto secundário já passa 4,5:1.

## M8.2 — Livro de custo e orçamento

Tornar o custo do resultado visível sem inventar um número.

**Entra.** Um livro local por sessão e por execução. O agente reporta totais acumulados: a diferença é o gasto, um total que desce abre outra execução, um subagente não se soma ao pai. Campo em falta fica desconhecido, nunca zero. Zero reportado continua zero. Não há estimativa em dólares. A quota oficial não é reportada. Um limite de turnos e um de minutos, opt-in. O turno que já vai a meio não é cortado; o próximo não começa. O painel só aparece quando há uma leitura.

**Não entra.** Ler credenciais, endpoints de faturação, tratar dólares estimados como fatura, e prometer um teto no meio de uma resposta.

**Prova.** Testes do livro com retoma, reset e subagente. Capturas do painel, claro e escuro, larga e estreita.

## Feito no M8.2

O livro está em `packages/engine/src/ledger`. Um total acumulado não se soma duas vezes. Um total que desce abre outra execução. Um subagente não entra na soma. Sem leitura, o painel não aparece. Um número em falta fica desconhecido, nunca zero. Não há estimativa em dólares. A quota fica por reportar. Há um limite de turnos e um de minutos. Param antes do próximo turno.

## M8.3 — Ciclo check, corrigir, check

Corrigir uma verificação falhada sem fazer de cola, e parar cedo.

**Entra.** Opt-in por sessão, desligado por omissão. Usa as verificações do projeto já aprovadas. No máximo 3 correções. Duas falhas com o mesmo texto, depois de tirar horas, caminhos, durações e ids, param o ciclo. Tempo esgotado ou comando em falta é infraestrutura e não se repete. Feito só quando a ronda passa e fica ligada ao turno. Dá para parar. Não faz push.

**Não entra.** Instalar dependências, enfraquecer testes, auto-push, e prometer CI remota verde.

## M8.4 — Juiz em sombra

Separar fazer de avaliar, sem lhe dar poder.

**Entra.** Um pacote com o pedido, o diff e as verificações. Não leva o que o autor disse de si. Duas leituras. Se falham ou discordam, é inconclusivo. Um achado sem prova sai. O resultado nunca autoriza push, merge nem apagar. Sem cliente de modelo, fica por fazer.

**Não entra.** Aprovar envios, memórias ou permissões. Tratar o parecer como prova mecânica.

## Feito no M8.3

O ciclo está em `packages/engine/src/repair`. Nasce desligado. No máximo 3 correções. A segunda falha igual, já sem horas, caminhos, durações e ids, para. Tempo esgotado ou comando em falta não se repete. Feito só com a ronda verde ligada ao turno. Não faz push.

## 2026-11-10

O Duarte retomou o M8.2 e o M8.3. O M8.4 fica parado e fora da cadeia de merge. O plano que se segue é mais curto:

- O M11 não se faz. A mesa já ordena pelo que precisa de ti.
- O M12 é uma nota de uma página, só com o gatilho.
- O M13 fica adiado.
- A verificação automática de regressão aos sete dias sai. Mais tarde há um botão «Reabrir».
- O M8.5 só corre com as 10 tarefas quando existir uma pergunta concreta. Sem isso, fica adiado.

## Escrito no M8.4, parado

O código do juiz está neste ramo e não entra na cadeia de merge. Sem cliente fica por fazer. Com um leitor de teste, um bug conhecido traz a prova e duas leituras que discordam ficam inconclusivas. `canAuthorize` é sempre falso.
