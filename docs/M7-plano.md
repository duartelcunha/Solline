# M7: do pedido ao PR

Plano para implementar. Este documento não escreve código. Parte do `main` em `9a85f61` (M6 fechado).

O marco, em `docs/visao.md`: uma sessão nasce de uma issue, com o branch e o contexto já preenchidos. Dá para gravar, abrir o PR e ver a CI. Um check falhado segue para o agente da sessão, uma vez, como mensagem tua. Um PR que entra arquiva a sessão, com a celebração curta que a visão reserva a esse momento.

## O que já existe

- Worktree e branch `solline/…` (M3). `worktree: 'always'` já existe. O nome do branch sai do título.
- «Trazer» grava a worktree num commit (hooks do projeto) e faz `merge --no-ff` no branch atual (`bring`, `commitAll` em `packages/engine/src/worktrees/worktrees.ts`). Não faz push nem abre PR. Sem `user.email`, esse commit sai como `Solline <solline@localhost>`.
- Verificações do projeto, por pasta, no fim do turno.
- Git do projeto só por `resolveGit()`; se devolver `null`, a worktree não corre um `git` solto.
- Não há GitHub, Linear, PR nem CI no código.

`gh`, se entrar, segue a mesma regra: caminho absoluto, só em pastas absolutas do PATH, sem shell. A Solline não lê nem guarda tokens. A sessão é a que o `gh` já tem.

## Primeiro

O M7 está feito: contrato, commit, issue, PR com CI, e a sessão arquivada quando o PR entra. O M8 não começou.

## Marcos

**M1. Contrato** (`packages/protocol/src/pull.ts`). Ids e estado, zod estrito: issue, PR, resultado de CI. Comandos: `issues.list`, `issues.open`, `commit.save`, `pr.open`, `ci.read`. A interface manda ids e o texto que escreveu. Não manda URL, dono do repositório, nem comando. O motor recusa estes comandos até ao marco que os faz.

**M2. Commit com a tua mensagem.** Feito. Grava a worktree, com a mensagem escrita na app, pelos hooks do projeto. Não faz merge nem push. Segundo clique, como Trazer. Sem `user.email`, falha e pede a identidade: não copia o `Solline <solline@localhost>`. Git só por `resolveGit()`.

**M3. Issue do GitHub.** Feito. O motor lista com o `gh` absoluto. Escolher uma abre uma sessão com `worktree: 'always'`, título da issue e primeira mensagem com número, título e corpo cortado. Sem `gh`, a lista diz porquê e a sessão normal continua. Linear usa o mesmo contrato e só entra com login local, sem chave na Solline. A API pede chave: uma linha no `DECISIONS.md`, e o M7 segue só com o GitHub.

**M4. PR e CI.** Feito. Push do branch da worktree e `gh pr create`, título e corpo editáveis. Confirmação nativa no main, com o repositório e o branch, antes do push. Não faz merge. «Trazer» mantém-se: é o merge local. Ler os checks é só leitura. Um botão manda o texto do check que falhou para a fila da sessão, como mensagem tua, uma vez por clique. Não é um ciclo e não troca de agente.

**M5. PR entrado.** Feito. Com o PR em `merged`, a sessão fica arquivada: lê-se, não se escreve, e a mesa trata-a como fechada. A celebração é uma, curta, nesse momento, com os tokens de `packages/ui`. Movimento reduzido troca o movimento por opacidade.

```
M1 → M2, M3
M2 → M4
M4 → M5
```

A leitura da CI pode começar com M1, em paralelo com M2. O botão que manda o check à fila espera por essa leitura e liga-se ao PR quando M4 existir.

## Riscos

- Sem `gh` ou sem sessão, não há issues nem PR. A sessão normal e o commit local continuam.
- O push sai da máquina. A confirmação é nativa, com o repositório e o branch à vista.
- Os hooks do commit podem falar com a rede. O segundo clique é o mesmo cuidado do Trazer.
- Um teste não chama a rede. `git` e `gh` entram pelo executável injetado, como `resolveGit` em `packages/engine/test/git-resolution.test.ts`.

## Fora

- Fundir o PR na app, ou empurrar para o branch principal sem PR.
- Corrigir checks em ciclo, juiz, ou mudar de modelo. Isso é o M8.
- Contador de uso e de custo (M8).
- Vários repositórios, forks, ou issues de outro projeto.
- Guardar `GH_TOKEN`, chaves do Linear, ou qualquer token.
- Terminal, browser, editor, agendador.
- Mexer em Trazer, worktrees, verificações ou no cérebro, fora do commit novo e do `resolveGit()` que ele já usa.
