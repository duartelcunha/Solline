# Marca da Solline

Direção atual: **porcelana, vidro e personagens de papel**, aprovada em 22/10/2026. O contrato visual é `DESIGN.md`. Substitui Meridiano, robôs de visor e a proposta com menta. Nenhuma aprovação visual dessas direções se transfere para esta.

## Material e cor

A interface usa porcelana clara e carvão escuro. Botões principais invertem o tom neutro; leitura, código e diffs têm fundos estáveis. O compositor e o enquadramento recebem vidro quase opaco, luz na borda e sombras neutras. Uma iridescência estática discreta no bordo do compositor usa reflexos frios e pêssego. Não há verde, hue de marca ou efeitos animados atrás do texto.

Geist e Geist Mono são locais. Tokens em `packages/ui/src/tokens.css`. Âmbar indica decisão pendente; coral indica erro ou ação destrutiva. Conclusão é um check neutro. Seleção, foco e direção de diff têm sinais próprios, não apenas cor. Os sinais +/− permanecem visíveis ao comentar. Sintaxe usa peso, itálico e luminosidade.

A marca conserva o sol e o reflexo, em porcelana sobre carvão. `Logo` e `scripts/brand-icons.mjs` partilham geometria e cores. Ícones até 24 px conservam desenho por pixel; os restantes usam amostragem da geometria original. A cor das personagens não entra no ícone da aplicação.

## Personagens

SVG originais na grelha 256 × 224. Silhueta e cor identificam o agente: estrela coral Claude, flor azul Codex, recorte mauve revisor, figura pêssego ACP, nuvem violeta outros e familiar ocre. As referências inspiram material e expressão, sem cópia de figuras.

Olhos brancos e pupilas escuras; gaze limitado à órbita. Listener partilhado e frames agrupados, sem renders React por movimento. Estados: espera, trabalho, atenção, conclusão, erro, sono e leitura. Rótulos e expressão permanecem legíveis sem animação; a cor do corpo não significa erro ou sucesso. A família deve funcionar em claro/escuro e nos tamanhos reais da lista, mesa, sessão e entrada.

Motion é curto, interrompível e subordinado à leitura. Movimento reduzido, ausência de foco e invisibilidade suspendem os efeitos; desmontar liberta recursos. A galeria e os clips da versão atual precisam de revisão independente. Não apresentar intenções do contrato como testes já aprovados.

## Voz e comportamento

- Verbos concretos e ações curtas, em pt-PT; sem marketing inventado ou urgência artificial.
- Contexto suficiente para permitir, recusar, trazer ou descartar trabalho.
- Feedback imediato; animação não bloqueia a ação nem rouba a posição de leitura.
- Barras de scroll finas disponíveis; teclado, toque e ausência de hover mantêm as ações acessíveis.
- Redução de transparência usa superfícies opacas. Forced colors preserva sinais, seleção e foco com cores de sistema.

A aprovação exige capturas da nova direção, clips naturais e comportamento verificado, ligados à mesma versão. Testes verdes, por si, não certificam composição ou personalidade.
