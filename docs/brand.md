# Marca da Solline

Direção atual: **vidro suave e personagens de papel**, escolhida a partir das referências do Duarte em 22/10/2026. O contrato visual é `DESIGN.md`; substitui a direção Meridiano anterior.

## Material e cor

Claro: papel quente, superfícies quase brancas e menta. Escuro: grafite e vidro fumado. O brilho fica nas bordas e nas ações; conversa e código mantêm fundos estáveis. Sombras curtas indicam profundidade. Nada se anima atrás do texto.

Geist e Geist Mono são locais. Os tokens vivem em `packages/ui/src/tokens.css`. Âmbar indica decisão pendente, vermelho erro, verde conclusão, sempre acompanhados por texto ou forma. Contraste de leitura e decisões tem verificação automatizada.

A marca conserva o sol e o reflexo, em verde profundo com menta. `Logo` e `scripts/brand-icons.mjs` partilham a geometria e as cores. Os ícones pequenos mantêm desenho por pixel.

## Personagens

SVG originais na grelha 256 × 224. Silhueta e cor identificam o agente: estrela laranja Claude, flor azul Codex, recorte verde revisor, figura rosa ACP, nuvem violeta outros e familiar amarelo.

Olhos brancos com pupilas escuras seguem rato ou caneta, limitados à órbita. Um listener partilhado agrupa eventos num frame; não há renders React por movimento. Toque não provoca seguimento. Movimento reduzido, perda de foco e invisibilidade suspendem o movimento; a última desmontagem remove listeners e frames pendentes.

Estados: espera, trabalho, atenção, conclusão, erro, sono e leitura. A expressão e o rótulo continuam legíveis sem movimento. Conclusão e sono fecham os olhos; erro tem expressão própria. Trabalho usa três pontos; os restantes estados não têm loops decorativos. O bot ativo pisca ao receber o cursor. As marcas compactas da lista ficam estáticas.

A entrada mostra a família; a mesa usa personagens compactas; o cabeçalho acompanha a sessão. A galeria de QA verifica poses a tamanhos reais e inclui frames intermédios e vídeo.

## Voz e ritmo

- Dizer o que aconteceu, com verbos concretos e ações curtas, em pt-PT.
- Não prometer certezas, inventar marketing ou urgência.
- Dar contexto suficiente para permitir, recusar, trazer ou descartar trabalho.
- Responder ao clique de imediato; movimento curto, interrompível, sem deslocar a leitura.
- Sem brilho arbitrário, cartões sem função ou efeitos que prejudiquem contraste.

Cor e forma distinguem a gravidade dos achados: erro em octógono, risco em triângulo, ruído em círculo. A revisão independente avalia composição e personalidade; testes verdes, por si, não certificam qualidade visual.
