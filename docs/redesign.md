# Solline — vidro suave, personagens de papel

## Contrato aprovado, 22 de outubro de 2026

Base: `feat/design-qualidade`, M4 até à classificação das corridas. O checkout antigo e a cópia estável não são áreas de implementação. A montagem entre pistas não faz parte deste trabalho.

A app deve tornar evidentes o projeto, o trabalho em curso e a próxima decisão. Pouco texto, calma, identidade própria e funções acessíveis por rato e teclado. A liberdade visual inclui marca e personagens; preservar comportamento e as capacidades de cada agente. Não esconder contexto de segurança para encurtar a interface.

A direção visual autoritativa é [DESIGN.md](../DESIGN.md), atualizada pelo Duarte a partir das referências visuais fornecidas em 22/10/2026. **Substitui a proposta inicial porcelana/jade com robôs de visor.** A aprovação visual anterior não vale para esta versão.

Claro: papel quente, vidro quase branco e menta nas ações. Escuro: grafite e vidro fumado. Bordas de luz e sombras suaves dão profundidade ao chrome; o texto permanece numa superfície estável. Blur contido no compositor, sem animação atrás da leitura. Geist e Geist Mono locais. Âmbar para decisões pendentes e vermelho para erro, sempre com nome ou forma além da cor.

As personagens são SVG originais de papel recortado, com silhuetas distintas por agente, olhos brancos e pupilas escuras que acompanham o cursor dentro da órbita. O seguimento usa um observador partilhado e escreve transformações no DOM, sem renderização React por frame. Movimento reduzido, perda de foco, invisibilidade e estados de sono/erro/conclusão suspendem o seguimento. Verificar espera, trabalho, atenção, conclusão, erro, sono e leitura a tamanhos reais; as marcas da lista permanecem estáticas. A composição e o material devem seguir as referências sem copiar figuras ou layouts de marketing.

## Investigação aplicada

- [Radix](https://www.radix-ui.com/primitives/docs/overview/introduction): manter primitivas acessíveis existentes, estilizadas com os tokens Solline.
- [shadcn](https://ui.shadcn.com/docs): referência de composição; não é necessário instalar outro sistema.
- [Nielsen Norman Group](https://www.nngroup.com/articles/ten-usability-heuristics/): estado visível, controlo, prevenção de erro e reconhecimento.
- [Playwright Clock](https://playwright.dev/docs/clock) e [comparações visuais](https://playwright.dev/docs/test-snapshots): dados e ambiente fixos; imagem estática não valida animação.
- [Electron testing](https://playwright.dev/docs/api/class-electron): smoke em Electron não equivale a validar executável endurecido, cujo fuse de inspeção está desligado.

As referências visuais do Duarte orientam material, luz e personagens; não constituem uma biblioteca instalada. A pesquisa sustenta manter Radix e a stack existente, criar a identidade SVG própria e usar CSS/WAAPI onde o benefício é verificável. Não foi adicionada uma biblioteca de UI ou motion apenas por aparência. A revisão deve rejeitar cartões sem função, gradientes arbitrários, brilho excessivo, hierarquia uniforme, texto pouco legível sobre vidro, figuras indistinguíveis e pupilas que saem da órbita.

## Regras de evidência

Cada cenário liga intenção, estado, ação, resultado e evidência. A ponte de QA valida payload e resposta e rejeita comandos desconhecidos. Nunca escrever diretamente nos stores para preparar estados. Dados fictícios, fontes locais, sem modelos nem contas reais. O índice da execução identifica código, ambiente, cenários, capturas e limitações; não atualizar goldens para esconder falhas.

O [mapa de cobertura](redesign-coverage.md) regista testes existentes, evidência intermédia e lacunas sem transformar implementação em aprovação. A execução final usa um build QA compilado e preview, evitando que a compilação a frio/HMR se confunda com o comportamento testado. Timeouts de arranque anteriores continuam registados; não são resultados verdes nem são escondidos por retries.

Revisão independente recebe este contrato, o diff e capturas da mesma versão. Verifica hierarquia, legibilidade, funcionalidade, estados, caráter e movimento; o verde automático não certifica beleza. Uma alteração invalida a evidência afetada.

Distribuição: preservar fuses, sandbox, CSP e isolamento. Recursos de QA são entradas de build separadas e não podem entrar no pacote normal. Login externo, juiz real, DPI nativo e instalação assinada precisam de evidência própria.

O benchmark compara cópias compiladas com descoberta explícita e idêntica de fontes Tailwind. A baseline histórica não contém a conversa longa dentro da janela; por isso a comparação é explicitamente normalizada, aplicando apenas no harness a regra `min-height: 0` a `#root > div > main` e `#root > div > main > div > div`, em ambas as versões. A descoberta CSS inicial incompleta e o overflow subsequente ficam registados como provas negativas. Grid/flex, largura e limites do painel, scroll e fontes carregadas são condições obrigatórias antes de medir. Não interpretar execuções invalidadas como regressões ou melhorias de produto; manter os limites originais e consultar o relatório da execução válida.

Na integração Electron, a configuração de teste substitui a fábrica de opções por um registo de agentes programados. Main, preload, comunicação, motor e Git continuam reais em pastas temporárias. Os testes também fixam as respostas dos diálogos nativos de seleção/confirmação para apontar às fixtures: isso não valida a experiência desses diálogos nem login externo. A nova cobertura de worktrees, revisão e corridas só se considera executada depois de existir relatório da versão correspondente.

## Ordem de execução

1. Harness, contrato e referência inicial.
2. Sessão representativa com permissão, figura, conversa e revisão; revisão visual independente.
3. Mesa, agentes, fila, worktrees e corridas.
4. Regressões, testes negativos do próprio QA, desempenho e duas corridas finais.
5. Handoff com resultados reais e limitações, atualização reversível da cópia estável.
