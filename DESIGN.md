# Solline — vidro suave, personagens de papel

Direção atualizada pelo Duarte em 22/10/2026. Substitui a primeira proposta porcelana/jade com robôs de visor.

## Referências aprovadas

As imagens fornecidas mostram vidro fosco com bordas de luz, superfícies claras esculpidas, chips de estado translúcidos, formas coloridas com olhos grandes e luz difusa. A aplicação usa esta gramática com contenção: materiais no chrome/compositor, cor nas personagens e decisões, leitura em superfícies estáveis. Sem copiar os layouts de marketing, texto fictício ou figuras das referências.

## Sistema

- Claro: papel quente, vidro quase branco, menta nas ações; escuro: grafite, vidro fumado, mesma menta.
- Tipografia Geist local. Hierarquia por escala e espaço. Código em Geist Mono. Sem texto decorativo técnico.
- Um plano de navegação, um plano de trabalho. Bordas de luz e sombras suaves indicam profundidade. Blur apenas no compositor; nada animado por trás do texto.
- Âmbar indica decisão pendente; vermelho erro; verde conclusão. Todos têm nome/forma além da cor.
- Primitivas Radix existentes. Sem nova biblioteca de componentes por aparência.

## Personagens

SVG original, silhuetas distintas por agente. Olhos brancos, pupilas escuras com seguimento de cursor limitado à órbita; movimento sem re-render React por frame. Um observador de ponteiro partilhado, suspenso sem personagens visíveis. Sem tracking durante sono/erro/conclusão ou movimento reduzido. Estados: espera, trabalho, atenção, conclusão, erro, sono e leitura. As formas pequenas são verificadas a 24/40 px; a entrada usa a família a maior escala.

## Critério anti-slop

O revisor deve rejeitar aparência genérica: cartões sem função, gradientes arbitrários, excesso de brilho, hierarquia uniforme, marketing inventado, texto ilegível sobre vidro, olhos que escapam à órbita, animações espalhadas ou personagens indistinguíveis. A identidade deve ser reconhecível pela silhueta, material e composição, antes de ler o nome.

Revisão estética não é equivalente a testes verdes. Capturas provam aparência; frames e clips provam movimento; testes provam comportamento. Evidência anterior à mudança de direção está invalidada para aprovação visual final.
