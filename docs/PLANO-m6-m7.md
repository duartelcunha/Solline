# Plano: decisões do M6 e plano do M7

O que este trabalho entrega, por que ordem, e como se verifica. Não implementa o M7 e não fecha as decisões: essas são do Duarte. O código de hoje fica como está.

## Ordem

1. Este plano, commitado antes do resto.
2. `docs/M6-decisoes.md`. Os quatro pontos que o `STATUS.md` e o `DECISIONS.md` deixam em aberto: importação de regras, Bash nas consultas do Claude, testemunho e bifurcação de consultas, aprovação em lote de memórias externas. Cada um numa página: uma frase do que é hoje, duas ou três opções, um por omissão com a razão, e o efeito em segurança ou em desfazer. A recomendação não entra no código.
3. `docs/M7-plano.md`. O M7 de `docs/visao.md` (do pedido ao PR) em tarefas pequenas, com o que já existe, o que pode correr em paralelo, as dependências e o que fica de fora.

## Como se verifica

Cada frase sobre o comportamento atual aponta para o código (regras, consultas, memória, worktrees). Depois, a linha de base do `STATUS.md`: `corepack pnpm@10.34.6 install --frozen-lockfile`, typecheck, testes do motor, testes de `apps/desktop/src/main`, `tsc` do desktop e eslint do desktop. Uma falha fica escrita no PR.

O git do motor continua a passar por `resolveGit()`. Este trabalho não acrescenta chamadas.

## O que não entra

Implementação do M7, escolha fechada dos quatro pontos, reescrita de história, merge do PR.
