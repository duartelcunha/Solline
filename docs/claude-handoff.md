# Solline — porcelana e recuperação

## Estado e autoridade

Esta implementação parte da estável f35c02aa94933d558b50c88153b12e1350816d23, no ramo codex/solline-porcelain-recovery. Worktree: C:/Users/duart/.codex/worktrees/solline-redesign/Solline. O checkout original, o Claude e a estável não são áreas de implementação.

Ler [DESIGN.md](../DESIGN.md), [pesquisa e decisões](redesign.md) e [mapa de cobertura](redesign-coverage.md). A direção com menta foi substituída por porcelana/carvão neutros. Os relatórios qa-evidence/delivery e final-4/final-5 aprovam apenas a entrega anterior f35. Consultar apps/desktop/qa-evidence/delivery-recovery/index.html para os resultados atuais e a correspondência exata entre fonte e evidência; ausência de índice ou manifesto completo significa gate pendente.

## Design e janelas próprias

Interface sem verde nem cor de marca. Ações inversas, foco com contorno, seleção com marcador, conclusão com visto. Vidro quase opaco apenas no compositor/controlos; conversa, código e decisões sólidos. Reflexo iridescente estático localizado. Radix, fontes locais, CSS/WAAPI e SVG originais; nenhuma dependência nova.

Figuras gráficas de papel com googly eyes e silhuetas próprias: ocre, coral, azul, mauve, pêssego e violeta. Gaze partilhado, limitado à órbita, sem render React por frame; suspende em blur, invisibilidade, coarse pointer e movimento reduzido. Rótulos complementam poses pequenas. Fila, pedidos e checkpoints têm movimento localizado/interrompível; texto em streaming não anima.

Diffs conservam +/− durante hover/foco/seleção; comentários têm espaço próprio. Scrollbars discretas. Pedidos novos durante leitura preservam scroll, seleção e foco; “Precisa de ti” salta só por ação explícita. Preferir ícones para controlos familiares e remover texto repetido, mantendo nomes acessíveis/ajuda e rótulos claros nas decisões de confiança, erros e ações destrutivas.

Controlos Windows recolhidos por defeito: aproximação de 152 × 56 px, botões de 32 px, entrada de 160 ms, saída de 140 ms após 240 ms; ponteiro coarse com alvos de 44 px visível. Alvos fixos/inertes quando ocultos; Escape não reabre pelo foco; modais têm prioridade. Estado vem do main. Não prometer equivalência com Snap nativo.

Confiança, variáveis, comandos, descarte e escolha de pastas usam janelas Solline independentes. Nonce, sender, top frame e página exata protegem respostas; cancelamento focado por defeito. Picker lista apenas diretórios, revalida realpath/stat ao confirmar e não dá FS ao renderer principal. Menus/notificações nativos removidos; avisos próprios abrem sem roubar foco. Recuperação tem outro renderer/partition/preload mínimo e IPC dedicado; nunca recarrega automaticamente.

A prova de bloqueio real encontrou uma lacuna do watchdog nativo: renderer visível e focado, sem debugger, bloqueado num input real, sem aviso dentro de 15 s. A Solline acrescenta uma ronda de saúde privada entre main/preload: token único, intervalo de 2 s, prazo de 8 s e apenas uma ronda pendente. Respostas antigas/forjadas não renovam o prazo; esconder, minimizar, navegar ou destruir suspende e limpa. Um main atrasado por suspensão do sistema começa uma ronda nova. A falha abre o mesmo aviso independente, sem recarregar ou repetir ações. O teste real e os testes de relógio validam mecanismos distintos. Esta ronda começa após did-finish-load; um bloqueio antes de terminar o carregamento inicial não está coberto por ela.

## Recuperação e política

- Motor: journal AES-GCM versionado, projeções sequenciadas, snapshots atómicos e lock. Chave de 32 bytes apenas no Windows Credential Manager, enviada ao utility process por MessagePort. Chave ausente com dados existentes falha fechado sem substituta. Não persistir credenciais/ambientes de fornecedores.
- UI: journal/snapshot AES-GCM autenticados com a chave do cofre para rascunhos, envio incerto, comentários, nota e editor. fsync antes de confirmar, rollback durável em falha de append, snapshot redundante e tail em quarentena. Retry explícito revalida disco contra o último estado confirmado.
- Renderer subscreve antes do snapshot, ignora duplicados, reidrata gaps/épocas e não mistura eventos antigos. Fecho congela inputs até confirmar/cancelar. Restauro revalida readiness antes de entregar edits responsivos e mantém o motor ativo.
- Reinício do motor/app apresenta sessões interrompidas, filas pausadas e fornecedores inativos até retoma explícita. Intenções desconhecidas ficam visíveis com texto/comentários/respostas; nenhum replay automático de envio, permissão ou Git.
- Checkpoints referenciados e shadow Git persistem. Dispose/limpeza de 24 h não apagam material recuperável. Reconciliar identidade de repo/worktree/branch antes de mutações e preservar mudanças externas.
- Confiança/checks/setup são reobtidos do ProjectStore principal antes de efeitos recuperados; o journal não é autoridade de consentimento.
- Shutdown espera mutações aceites e fecha adapters abertos tarde. Ciclo running/stopping/stopped impede reiniciar fornecedores ainda a fechar. Um fornecedor que não termina mantém fecho pendente/falhado, sem sucesso fictício.

A garantia cobre estado confirmado como gravado, não teclas em trânsito nem falha física absoluta. Journal/refs duráveis conservam-se sem retenção automática. O cofre atual suporta Windows.

## Validar e continuar

Usar binários locais com Node. Nunca pnpm global neste PC: pode tentar gerir outra versão automaticamente. Para instalar o lock existente quando necessário, corepack pnpm; não alterar o lockfile para contornar erros.

Em apps/desktop, node qa/verify.mjs <nome-novo> cria evidência imutável e hash de fontes antes/depois: tipos, unidades, lint, canários, renderer, Electron/Git, build normal, distribuição e smoke. SOLLINE_QA_BROWSER aponta para C:/Users/duart/AppData/Local/ms-playwright/chromium-1247/chrome-win64/chrome.exe. SDKs desligados. Exigir duas execuções completas limpas da mesma fonte, sem retries ocultos.

Renderer usa componentes reais e ponte/schema estritos. Electron substitui só a fábrica de opções por agentes programados: main, preload, motor, Git, cofre e prompts são reais. O helper de prompts aceita títulos/botões enumerados. Verificar ficheiros/branches/checkpoints, não só mensagens.

Canários descartáveis provam decisão invertida, foco perdido, diff oculto, confirmação prematura, sequência ignorada e listener abandonado. Benchmark exclusivo compara f35 com código novo, sem patches de layout, com transporte/protocolo idênticos, carga fixa, ordem AB/BA e política prévia. Não correr com outras suites. Ruído é inconclusivo, nunca ganho.

Capturas/clips/traces têm de corresponder à versão revista. Alterações invalidam provas afetadas. Distribuição normal verifica ausência de QA/diálogos nativos, recursos locais e preloads independentes sem chunks locais incompatíveis com sandbox. ASAR/fuses é gate separado; não desligar proteções.

## Ambiente, limites e preservação

Uma chamada acidental ao pnpm global tentou reparar dependências ligadas ao Claude; foi interrompida sem alterar manifests/lockfiles. A implementação recebeu dependências físicas do mesmo lock. Babel 7.29.7 e Electron 44.7.0 do Claude foram reparados com os mesmos ficheiros/versões existentes. Confirmar novamente fonte limpa e resolução antes de entregar. Backups ignorados em qa-evidence/environment-repair contêm junctions: nunca percorrer targets durante limpeza recursiva.

A revisão automática rejeitou remover C:/Users/duart/AppData/Local/Temp/solline-recovery-qa-lJDkMx, sem motivo além de “blocked by policy”. Credencial removida e processos terminados; pasta intacta. A pasta histórica solline-redesign-qa-mzSRWU tem bloqueio anterior equivalente. Não contornar nem declarar limpeza total.

Login/cancelamento SDK real, juiz/revisor real, MCP externo, DPI nativo e aplicação instalada endurecida precisam de prova própria. Falhas de disco são injetadas nos syscalls, não um teste físico de disco cheio/power-loss. A montagem entre pistas fica fora.

Promover estável só após gates. A fonte f35 está preservada em codex/stable-before-recovery-20261022 e o build anterior em apps/desktop/qa-evidence/stable-rollback-f35, com manifesto de hashes. Não apagar trabalho Claude, provas úteis ou processos alheios. O handoff local atual deve separar resultados confirmados, histórico e limites.
