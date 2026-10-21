"""
Corta a folha de sprites da tripulação em imagens soltas para a app.

Uso: python scripts/slice-crew.py <folha.png>

A folha (1536x1024, fundo transparente) tem cinco feiticeiros em colunas e seis poses em
linhas, mais o familiar em três cenas à direita. Cada pedaço opaco vai para a célula onde
está o seu centro (as mãos levantadas de uma linha entram na de cima), e cada sprite sai
alinhado ao centro e em baixo, numa tela igual para todos, para a pose não saltar.

Arte provisória: quando houver sprites desenhados a 48x48, basta pôr ficheiros com os
mesmos nomes na pasta de destino.
"""

import sys
from collections import deque
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent.parent / 'apps/desktop/src/renderer/src/assets/crew'
CHARACTERS = ['aureo', 'ciano', 'vertice', 'enlace', 'indigo']
STATES = ['waiting', 'working', 'done', 'needs-you', 'permission', 'celebrate']
FAMILIAR = ['familiar-laptop', 'familiar-door', 'familiar-merge']

# Medidas da folha (colunas e fronteiras entre linhas, onde o alfa é mínimo).
COLS = [(82, 279), (319, 513), (554, 750), (791, 991), (1027, 1228)]
ROWS = [0, 192, 368, 546, 716, 851, 1024]
FAMILIAR_X = (1240, 1536)
FAMILIAR_ROWS = [0, 370, 690, 1024]

SIZES = {'crew': 96, 'familiar': 192}
ALPHA = 24


def components(alpha):
    """Pedaços opacos ligados: (centro x, centro y, caixa)."""
    w, h = alpha.size
    px = alpha.load()
    seen = bytearray(w * h)
    found = []
    for y in range(h):
        for x in range(w):
            if seen[y * w + x] or px[x, y] <= ALPHA:
                continue
            queue = deque([(x, y)])
            seen[y * w + x] = 1
            x0, y0, x1, y1, sx, sy, n = x, y, x, y, 0, 0, 0
            while queue:
                cx, cy = queue.popleft()
                sx, sy, n = sx + cx, sy + cy, n + 1
                x0, y0, x1, y1 = min(x0, cx), min(y0, cy), max(x1, cx), max(y1, cy)
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and px[nx, ny] > ALPHA:
                        seen[ny * w + nx] = 1
                        queue.append((nx, ny))
            if n >= 12:  # poeira de compressão fica de fora
                found.append((sx / n, sy / n, (x0, y0, x1 + 1, y1 + 1), n))
    return found


def cell_of(cx, cy):
    if FAMILIAR_X[0] <= cx < FAMILIAR_X[1]:
        for i in range(3):
            if FAMILIAR_ROWS[i] <= cy < FAMILIAR_ROWS[i + 1]:
                return FAMILIAR[i]
        return None
    for c, (x0, x1) in enumerate(COLS):
        if x0 - 20 <= cx <= x1 + 20:
            for r in range(6):
                if ROWS[r] <= cy < ROWS[r + 1]:
                    return f'{CHARACTERS[c]}-{STATES[r]}'
    return None


def main(sheet_path):
    sheet = Image.open(sheet_path).convert('RGBA')
    alpha = sheet.getchannel('A')
    # As linhas tocam-se em alguns sítios: para achar os pedaços, corta-se a ligação nas
    # fronteiras (só aqui; a imagem que sai não perde nada).
    cut = alpha.copy()
    for y in ROWS[1:-1]:
        cut.paste(0, (0, y, FAMILIAR_X[0], y + 1))
    cells = {}
    for cx, cy, box, _ in components(cut):
        name = cell_of(cx, cy)
        if name:
            cells.setdefault(name, []).append(box)
    OUT.mkdir(parents=True, exist_ok=True)
    missing = [n for n in [f'{c}-{s}' for c in CHARACTERS for s in STATES] + FAMILIAR if n not in cells]
    if missing:
        raise SystemExit(f'células sem sprite: {missing}')

    # Uma tela comum por grupo: a maior caixa, para todas as poses ficarem à mesma escala.
    def union(boxes):
        return (min(b[0] for b in boxes), min(b[1] for b in boxes),
                max(b[2] for b in boxes), max(b[3] for b in boxes))

    groups = {'crew': [n for n in cells if not n.startswith('familiar')],
              'familiar': FAMILIAR}
    for group, names in groups.items():
        boxes = {n: union(cells[n]) for n in names}
        side = max(max(b[2] - b[0], b[3] - b[1]) for b in boxes.values()) + 8
        for name in names:
            x0, y0, x1, y1 = boxes[name]
            # Só os pedaços desta célula (sem restos dos vizinhos dentro da caixa).
            mask = Image.new('L', sheet.size, 0)
            for b in cells[name]:
                mask.paste(alpha.crop(b), b[:2])
            piece = Image.new('RGBA', sheet.size, (0, 0, 0, 0))
            piece.paste(sheet, (0, 0), mask)
            piece = piece.crop((x0, y0, x1, y1))
            canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
            canvas.paste(piece, ((side - piece.width) // 2, side - piece.height - 4), piece)
            size = SIZES[group]
            canvas.resize((size, size), Image.LANCZOS).save(OUT / f'{name}.png', optimize=True)
    print(f'{len(cells)} sprites em {OUT}')


if __name__ == '__main__':
    main(sys.argv[1])
