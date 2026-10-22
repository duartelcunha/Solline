# Solline — porcelana, vidro e personagens de papel

Direção aprovada pelo Duarte em 22/10/2026. Substitui a proposta com menta e qualquer aprovação visual anterior à recuperação em porcelana. A aplicação é uma ferramenta de trabalho: hierarquia, leitura e controlo vêm antes dos efeitos.

## Gramática visual

- Porcelana clara e carvão escuro, ambos neutros. Sem verde nem cor de marca nas superfícies, ações, foco, código, diffs, logótipo ou sombras.
- Superfícies sólidas para conversa, código, revisão e decisões. Vidro quase opaco no compositor e enquadramento; luz nas bordas, sombra curta e direção de luz consistente. Nada animado por trás do texto.
- Uma borda iridescente estática, muito discreta, no compositor: reflexos frios e pêssego, sem espectro verde. Nunca texto iridescente, brilho a seguir ao cursor, halo permanente ou gradiente em movimento.
- Botão principal em tom neutro inverso. Seleção usa marcador ou check; foco usa contorno próprio; conclusão usa check e rótulo. Estes estados não dependem apenas de luminosidade ou cor.
- Âmbar é uma exceção semântica para decisão pendente; coral para erro ou ação destrutiva. A cor de uma personagem não indica gravidade. Conclusão, execução e diffs permanecem neutros.
- Geist e Geist Mono locais. Hierarquia por tamanho, peso e espaço. Sintaxe distingue-se por peso, itálico e luminosidade; o conteúdo do utilizador não é reescrito. Sem texto decorativo técnico.
- Componentes e primitivas Radix existentes; nenhuma dependência por aparência. Um plano de navegação, um plano de trabalho; sem cartões decorativos aninhados.

## Direção e estados

Cada linha alterada conserva o sinal +/− durante hover, foco e comentário. O sinal tem contorno contínuo para adição e tracejado para remoção; o comentário ocupa uma coluna separada. O código continua selecionável sem incluir a numeração auxiliar. Contagens são neutras; rejeitar ou descartar trabalho conserva a semântica destrutiva.

Barras de scroll finas continuam visíveis e arrastáveis. Transparência reduzida torna o vidro opaco e remove blur; forced colors usa cores de sistema, conserva contornos, seleção e sinais dos diffs. As camadas de leitura não dependem do suporte a blur.

## Personagens

SVG original, recortes distintos e olhos grandes. Ocre para Solline/familiar, coral para Claude, azul para Codex, mauve para revisor, pêssego para ACP e violeta para outros. A silhueta continua a identificar o agente sem cor. Não copiar figuras das referências.

Gaze limitado à órbita, sem render React por frame. Listener partilhado; suspensão em movimento reduzido, ausência de foco, invisibilidade ou estados que não acompanham o cursor. Espera, trabalho, atenção, conclusão, erro, sono e leitura devem ser legíveis sem animação. A família mantém coerência a 24/40 px e na entrada ampliada. Os rótulos complementam as expressões pequenas.

Movimento curto, localizado, interrompível e subordinado à leitura. Nenhum gesto celebratório sobrevive a uma transição para erro; voltar à janela não repete eventos antigos. Não animar o texto em streaming nem deslocar a leitura para mostrar um pedido sem ação explícita.

## Gates de aceitação

Primeiro rever uma sessão representativa com compositor, conversa, pergunta selecionada, permissão, erro e revisão. Claro/escuro; janela estreita e larga. Só depois expandir a linguagem para superfícies restantes.

- Texto normal e placeholder com contraste mínimo 4.5:1; texto grande e contornos funcionais com 3:1. Medir fundos compostos reais, não apenas tokens isolados.
- Distinguir seleção, foco, conclusão, erro e direção do diff em escala de cinzentos, inclusive hover, disabled e seleção de texto.
- Verificar temas, zoom, texto longo, teclado, coarse pointer, forced colors, movimento e transparência reduzidos. Nada depende exclusivamente de hover.
- Rever todas as personagens/poses em tamanhos reais e clips naturais das transições interrompidas. Testar suspensão e ausência de recursos órfãos.
- Confirmar desempenho com o mesmo workload e ambiente; efeitos não justificam regressões nem relaxamento dos critérios.
- Vincular novas capturas, clips e resultados à versão que os produziu. Evidência da direção anterior é apenas histórico funcional, nunca aprovação da nova aparência.

Rejeitar gradientes arbitrários, excesso de brilho, hierarquia uniforme, texto ilegível sobre vidro, olhos fora da órbita e personagens indistinguíveis. Capturas verificam aparência; frames/clips verificam movimento; testes verificam comportamento. Este documento define a intenção, não certifica a implementação.
