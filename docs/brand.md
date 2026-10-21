# Marca da Solline

Direção "Meridiano": carvão e âmbar quente, Geist como voz única, cor só para estado.

## Marca

- **Solline Pin:** um meio sol atravessado pela linha do tempo, com a pega no corte. Em
  `apps/desktop/src/renderer/src/components/pin.tsx` (herda a cor) e no ícone da app, gerado por
  `scripts/brand-icons.py` (`apps/desktop/build/icon.ico`, com um desenho próprio a 16 px).
- **Wordmark:** "Solline" em Geist SemiBold, tracking −0,035em.
- **Âmbar do Pin:** `oklch(0.68 0.145 78)` no claro, `oklch(0.79 0.145 82)` no escuro (`--sl-accent`).

## Tripulação

Cada agente é um feiticeiro de capuz, com a cor e o amuleto dele. A pose diz o estado.

| Agente | Personagem | Amuleto |
|---|---|---|
| Claude | Áureo (âmbar) | sol |
| Codex | Ciano | chevron duplo |
| Segunda opinião | Vértice (verde) | anel |
| Agentes ACP | Enlace (vermelho) | nó de três pontos |
| Outros | Índigo (azul) | losango |

Poses: à espera (mãos juntas, respira devagar), a trabalhar (aponta), feito (polegar, 2 s),
precisa de ti (mãos levantadas), caiu (braços cruzados), celebração (rara).

O **familiar** (cinzento) é o companheiro do utilizador: ao portátil no primeiro arranque, à porta
de um projeto vazio. A cena do merge (M7) volta quando houver PRs na app.

A tripulação vive dentro da app; nunca é o ícone nem o wordmark.

**Arte provisória:** cortada por `scripts/slice-crew.py` de uma folha gerada por IA (bordas
suaves). Os sprites finais desenham-se numa grelha de 48×48 e entram com os mesmos nomes em
`apps/desktop/src/renderer/src/assets/crew/`.

## Gravidade dos achados

Cor e forma, para se ler sem distinguir cores: erro em octógono (vermelho), risco em triângulo
(âmbar), ruído em círculo (cinzento).

## Voz (pt-PT, AO90)

1. Dizer o que aconteceu antes de explicar porquê.
2. Verbos concretos, no presente.
3. Uma ação por frase; os botões começam por verbo.
4. Não personificar o sistema nem prometer certezas.
5. Ser breve: o contexto está na linha do tempo, não no texto.
