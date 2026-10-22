# Solline — continuação do overhaul

## Ler primeiro

O trabalho parte de `9fb1cb047e06e0d613cc2ec5f1edf32b65971425` (última versão do Claude), no ramo `codex/solline-redesign`. A direção definitiva está em [DESIGN.md](../DESIGN.md), a justificação e fontes em [redesign.md](redesign.md), e os cenários/limites em [redesign-coverage.md](redesign-coverage.md). As referências mais recentes do Duarte substituem os robôs de visor: vidro suave, menta/grafite, figuras de papel colorido com olhos que seguem o cursor. Não regressar à proposta anterior.

O contrato público do protocolo mantém-se. Radix, fontes locais, CSS/WAAPI e SVG originais resolvem o design sem dependências novas. As figuras comunicam sete estados; movimento reduzido, invisibilidade e perda de foco interrompem animação e gaze. O observador de ponteiro é partilhado e não renderiza React por frame.

## Alterações funcionais relevantes

- O seguimento inativo das pupilas cancela a transição CSS de forma síncrona através de `data-gaze-active`, evitando que uma janela oculta conserve uma transformação intermédia. A condição deriva do seguimento real, incluindo foco, visibilidade e estado; figuras visíveis sem animação ambiente continuam com gaze suave. Não foi necessário trocar `useEffect` por `useLayoutEffect`. Provas: `native-blur` (falha), `native-blur-effects` (diagnóstico), `native-blur-fixed` (primeira correção) e `gaze-active-fixed` (correção precisa). Hide/blur nativo está demonstrado; `visibilitychange` para hidden continua limitado pela automação.

- Rascunhos e envios pendentes pertencem à sessão. Falhas tardias preservam o texto enviado e o texto entretanto escrito; fecho durante envio fica bloqueado.
- O consentimento de descartar fila mantém-se durante a decisão de worktree. Drafts de fila/rewind são consumidos atomicamente, incluindo StrictMode.
- Respostas a permissões/perguntas bloqueiam cliques repetidos, permitem retry e limpam erros antigos. O atalho de orientação respeita capacidades do agente.
- Perguntas usam ponto/visto além da cor; grupos de seleção simples têm foco único, setas, Home/End. A navegação ativa tem um marcador físico, e a segunda opinião sem achados tem um visto distinto do estado inativo.
- Revisão e painel de agentes recebem/devolvem foco; Escape e navegação de cartões por teclado têm cobertura.
- View Transitions interrompidas tratam o `AbortError` esperado de `ready`, sem esconder outros erros.
- Empates mostram duas pistas equivalentes; uma pista terminada não continua com “A pensar…”. Uma falha do motor não oferece “Retomar”, que só se aplica ao agente com o motor disponível.
- **Correção de preservação no motor:** duas contagens Git concorrentes partilhavam um índice temporário. Uma podia repor o índice da outra, reportar zero alterações e permitir remover trabalho ainda não trazido. Cada contagem usa agora um índice próprio com limpeza em `finally`. O teste com Git real força exatamente esse interleaving: falhou antes da correção e passou depois. Não remover essa regressão nem substituir a asserção de ficheiro final por uma mensagem da UI.
- Renomear o branch após a primeira mensagem termina antes de trazer ou fechar a worktree. O teste `worktree-rename-lifecycle.test.ts` retém a entrega do resultado de um rename Git real: antes, descartar deixava a ref nova e trazer tentava a ref antiga; depois, ambos aguardam e usam a identidade correta. Prova red/green em `qa-evidence/rename-race/`. Os testes Electron identificam branches pelo sufixo estável da worktree, não por um rótulo da UI capturado antes da renomeação.

## Repetir a validação

Usar Node e `corepack pnpm` com o lockfile existente. O `pnpm` global deste PC é uma versão diferente e pode tentar reinstalar dependências. Não alterar o lockfile para resolver isso.

A partir de `apps/desktop`, definir `SOLLINE_QA_BROWSER` para o Chromium instalado e correr `node qa/verify.mjs <nome-novo>`. Cada nome cria uma pasta imutável em `qa-evidence/`; não aceita sobrescrever. O runner faz tipos, testes unitários offline, lint, renderer compilado, integração Electron com Git real, build normal, inspeção de distribuição e smoke normal. SDKs pagos não são ativados. Os dois manifestos completos, com o mesmo `sourceHash`, e a revisão independente são o critério de aprovação automática; uma execução interrompida ou falhada não conta.

O renderer usa ponte estrita e schemas reais; comandos inesperados falham. O Electron substitui apenas a fábrica de opções do motor e fixa respostas de diálogos nativos. Main/preload/IPC/motor/Git continuam reais. O marcador do agente programado é verificado antes do arranque. O ambiente do Electron de teste só recebe variáveis do sistema necessárias; não copiar credenciais para traces.

`node qa/canary.mjs <nome-novo>` introduz defeitos de permissão e foco numa cópia descartável e verifica falhas correspondentes. O runner completo também o executa, guardando a prova em `<nome>-canary`. `SOLLINE_PERF_EXCLUSIVE=1 node qa/performance.mjs` compara snapshots isolados com ordem AB/BA, carga fixa e limiares escritos antes de medir. Não executar benchmark ao mesmo tempo que outras suites.

As provas locais estão em `apps/desktop/qa-evidence/`: manifestos e índices por execução; `canary/proof.json`; benchmark em `performance/`. As capturas/clips/traces pertencem ao hash indicado no manifesto. Esses artefactos são ignorados pelo Git e devem ser preservados no handoff local. A ausência de uma pasta/manifesto completo significa que esse gate não foi demonstrado.

## Limites e próxima tarefa

Login externo, juiz/revisor por modelo real, DPI nativo e executável instalado endurecido precisam de uma sessão própria. Simulação, CSS zoom e Electron de desenvolvimento não os certificam. Não desligar fuses, sandbox, CSP ou Smart App Control para obter um resultado verde.

As comparações iniciais de desempenho foram invalidadas: faltava descoberta explícita de utilitários CSS na cópia antiga e, depois de corrigida, a conversa longa ainda excedia a janela por falta de contenção de altura. As provas e falhas permanecem em `qa-evidence/`, identificadas por `INVALIDATED.md`. O benchmark atual aplica as mesmas fontes CSS e a mesma contenção mínima apenas às duas cópias descartáveis, verifica layout/fontes/scroll antes de medir e mantém a política original. A execução normalizada final, após a correção precisa da suspensão das pupilas, teve layout válido e limpeza completa, com frames/heap/DOM dentro dos limites; as diferenças de latência ficaram inconclusivas por ruído. A anterior permanece em `performance-before-native-fix`. Nenhum gate de regressão disparou, mas isto não demonstra equivalência nem ganho. Não mede a renderização histórica intacta, desempenho nativo Electron ou SDKs reais.

A montagem de soluções entre pistas continua fora deste overhaul. Antes de continuar funcionalidades, rever o bundle final e os limites do mapa; depois validar os percursos externos com as contas do Duarte e o pacote normal. Manter a versão anterior da cópia estável acessível para rollback. Não limpar worktrees do Claude nem processos de outras tarefas.
