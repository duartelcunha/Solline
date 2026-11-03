# M7: do pedido ao PR

Plano para implementar depois. Este PR não escreve código do M7. O `STATUS.md` pede as quatro decisões de `docs/M6-decisoes.md` antes de começar; o desenho abaixo não as decide e não fica à espera delas.

O marco, em `docs/visao.md`: uma sessão nasce de uma issue, com o branch e o contexto já preenchidos; dá para gravar, abrir o PR e ver a CI; um check falhado segue para o agente da sessão; um PR que entra arquiva a sessão, com a celebração curta que a visão reserva a esse momento.

## O que já existe

- A segunda sessão de um projeto git, ou uma com `worktree: 'always'`, já ganha worktree e branch `solline/…` (M3). O nome do branch sai do título.
- «Trazer» grava a worktree num commit (hooks do projeto) e faz `merge --no-ff` no branch atual (`bring` e `commitAll` em `packages/engine/src/worktrees/worktrees.ts`). Não abre PR nem faz push. Sem `user.email` no git, esse commit sai como `Solline <solline@localhost>`.
- As verificações do projeto correm por pasta, no fim do turno.
- Não há GitHub, Linear, PR nem CI no código.

Git novo passa por `resolveGit()` (`packages/engine/src/checkpoints/git.ts`) e para se ele devolver `null`, como `gitCommitExists` em `memory/evidence.ts`. O `WorktreeManager` ainda cai para o nome `git` quando a resolução falha. Uma tarefa que passe por essa classe não alarga esse fallback: a chamada nova falha fechada, com teste.

`gh` e o cliente do Linear, se entrarem, seguem o mesmo critério: caminho absoluto, só em pastas absolutas do PATH, sem shell. A Solline não lê nem guarda tokens. A sessão é a que o programa já tem.

## Tarefas

Cada uma cabe num agente. T0 primeiro. Depois, o grupo A e o grupo B ao mesmo tempo. C1 e C2 ao mesmo tempo, cada um à espera do que está escrito. D1 no fim.

**T0. Contrato** (`packages/protocol`). Ids e estado, com zod estrito: issue, PR, resultado de CI. Comandos: listar issues do projeto aberto, abrir sessão a partir de uma, gravar commit, abrir PR, ler CI. A interface manda ids. Não manda URL, dono do repositório, nem comando. Sem motor nesta tarefa.

**A1. Issues do GitHub** (depois de T0). O motor lista com o `gh` absoluto. A interface mostra número e título. Escolher uma abre uma sessão normal com `worktree: 'always'`, título da issue, e a primeira mensagem com o número, o título e o corpo cortado. É o mesmo gesto de abrir uma segunda sessão: branch local, sem diálogo nativo. Sem `gh` no PATH, a lista diz porquê e a sessão normal continua a existir.

**A2. Linear** (depois de T0, em paralelo com A1, o mesmo contrato). Só entra com login local, feito pelo cliente, sem chave na Solline. Se a única via for uma API key, a tarefa fecha com uma linha no `DECISIONS.md` e o M7 fica no GitHub. Não bloqueia A1 nem C1.

**B1. Commit com a tua mensagem** (depois de T0, em paralelo com A). Um comando grava a worktree, com a mensagem escrita na app, pelos hooks do projeto. Não faz merge nem push. Pede um segundo clique (é local, como Trazer). Sem `user.email`, falha e pede a identidade: não copia o `Solline <solline@localhost>` do `commitAll`. Git só por `resolveGit()`.

**B2. Estado da CI** (depois de T0, em paralelo com B1). Ler os checks de um PR, só leitura, para o cartão da sessão. Ainda não manda nada ao agente.

**C1. Abrir o PR** (depois de B1). Push do branch da worktree e `gh pr create`, título e corpo editáveis. Vale para uma sessão vinda de uma issue e para qualquer sessão que já tenha worktree. Confirmação nativa no main, com o repositório e o branch, antes do push. Não faz merge. «Trazer» mantém-se: é o merge local, outra ação.

**C2. Mandar um check falhado ao agente** (depois de B2). Um botão: o texto do check que falhou entra na fila da sessão, como mensagem tua. Uma vez por clique. Não é um ciclo, não relança sozinho, não troca de agente. Liga-se ao PR da sessão quando C1 existir; até lá testa-se com um estado de CI falso.

**D1. PR entrado** (depois de C1). Com o PR em `merged`, a sessão fica arquivada: lê-se, não se escreve, e a mesa trata-a como fechada. A celebração é uma, curta, nesse momento, com os tokens de `packages/ui`. Movimento reduzido troca o movimento por opacidade e deixa o facto de o PR ter entrado.

## Dependências

```
T0 → A1, A2, B1, B2
B1 → C1
B2 → C2
C1 → D1
```

A2 não bloqueia ninguém. C2 não bloqueia D1. A1 não bloqueia C1: o PR não exige que a sessão tenha nascido de uma issue.

## Fora de âmbito

- Implementar ou fechar as quatro decisões do M6.
- Fundir o PR dentro da app, ou empurrar para o branch principal sem PR.
- Corrigir checks em ciclo, juiz, ou mudar de modelo. Isso é o M8, com o contador de uso.
- Vários repositórios, forks, ou issues de outro projeto.
- Guardar `GH_TOKEN`, chaves do Linear, ou qualquer token.
- Terminal, browser, editor, agendador, pesquisa no histórico, receitas.
- Redesesenhar Trazer, worktrees, verificações ou o cérebro.

## Verificação

Em cada tarefa: `pnpm typecheck` e os testes do pacote tocado. `git` e `gh` entram nos testes pelo executável injetado, no estilo de `packages/engine/test/git-resolution.test.ts`. Sem rede nos testes por omissão.
