# Marca da Solline

Direção "Meridiano": carvão e âmbar quente, Geist como voz única, cor só para estado.

## Marca

- **Marca:** um sol a nascer no horizonte com o reflexo em duas linhas, num quadrado de carvão
  (igual nos dois temas). Fica ao lado do wordmark (`apps/desktop/src/renderer/src/components/logo.tsx`).
- **O bot é o Pin de olhos abertos:** a linha do tempo é a bainha do capuz, o meio sol é o
  capuz, a abertura escura é outro meio sol e os olhos são meios sóis pequenos. Geometria em
  `packages/ui/src/bot/geometry.ts`, numa grelha de 256.
- **Ícone da app:** o bot âmbar da Solline num quadrado de carvão. Gerado por
  `node scripts/brand-icons.mjs` a partir da mesma geometria; os 24, 20 e 16 px são pixel art
  desenhada à mão (grelhas no script). O `.ico` traz 256, 64, 48, 40, 36, 32, 30, 24, 20 e 16 px.
- **Wordmark:** "Solline" em Geist SemiBold, tracking −0,035em.
- **Âmbar:** `oklch(0.79 0.145 82)`. É da Solline e do estado "precisa de ti", de mais ninguém.

## Bots

Cada sessão é um bot: a cor do capuz diz o agente (mesma luminosidade e pouca saturação), a
cara e a bainha dizem o estado.

**Um bot no ecrã de cada vez:** o bot inteiro só aparece no cabeçalho da sessão aberta. A
lista de sessões mostra só o capuz (cor do agente, âmbar se precisa de ti, vermelho se caiu,
a pulsar enquanto trabalha) e o revisor usa ícones.

| Agente | Capuz |
|---|---|
| Claude | barro, `oklch(0.7 0.09 45)` |
| Codex | ciano, `oklch(0.7 0.09 210)` |
| Revisor | verde, `oklch(0.7 0.09 150)` |
| Agentes ACP | rosa, `oklch(0.7 0.09 350)` |
| Outros | azul, `oklch(0.7 0.09 265)` |
| Familiar | cinzento, `oklch(0.62 0.012 80)` |

Humores: à espera (olhos em meio sol), a trabalhar (três pontos), precisa de ti (olhos âmbar
a olhar para cima e bainha âmbar), feito (olhos em arco, 1,4 s), caiu (olhos em X, capuz
descaído, bainha vermelha), a dormir (parado há 10 min), a ler (uma fenda, só o revisor).

**A regra da bainha:** a cor do agente quando está tudo bem, âmbar quando precisa de ti,
vermelha quando cai. Os humores sem urgência não mexem na bainha.

O **familiar** é o bot cinzento: recebe-te no primeiro arranque e nos projetos vazios.

**Movimento (depois do M3):** só o bot da sessão aberta está vivo (respira, pisca, olha para a
ação, nunca para o rato); os outros ficam na pose do estado. Um só relógio para todos, em
pausa com a janela escondida. Motor de animação baseado no do
[bloub](https://github.com/jeremy-prt/bloub) (MIT), com formas e estados nossos.

## Gravidade dos achados

Cor e forma, para se ler sem distinguir cores: erro em octógono (vermelho), risco em triângulo
(âmbar), ruído em círculo (cinzento).

## Voz (pt-PT, AO90)

1. Dizer o que aconteceu antes de explicar porquê.
2. Verbos concretos, no presente.
3. Uma ação por frase; os botões começam por verbo.
4. Não personificar o sistema nem prometer certezas.
5. Ser breve: o contexto está na linha do tempo, não no texto.
