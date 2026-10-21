"""
Gera o ícone da app (build/icon.ico e icon.png) a partir da geometria do Solline Pin.

Uso: python scripts/brand-icons.py

O Pin: uma linha atravessa um meio sol, com a pega da linha do tempo no corte. Os tamanhos
grandes desenham-se a 1024 px e reduzem-se; os 16 px seguem uma grelha própria (reduzir o
desenho grande dá uma mancha).
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'apps/desktop/build'
GROUND = (43, 40, 36, 255)  # #2b2824, surface-0 escuro
PIN = (255, 208, 113, 255)  # #ffd071, âmbar do Pin


def large(size: int) -> Image.Image:
    """O ícone na grelha de 256 (a do SVG), desenhado a 4x e reduzido."""
    s = 1024 / 256
    im = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, 1023, 1023), radius=int(56 * s), fill=GROUND)
    stroke = int(16 * s)
    # Linha do tempo, com pontas redondas.
    y = 150 * s
    d.line((38 * s, y, 218 * s, y), fill=PIN, width=stroke)
    for x in (38 * s, 218 * s):
        d.ellipse((x - stroke / 2, y - stroke / 2, x + stroke / 2, y + stroke / 2), fill=PIN)
    # Meio sol: arco de raio 48 centrado na linha.
    r = 48 * s
    cx = 128 * s
    d.arc((cx - r - stroke / 2, y - r - stroke / 2, cx + r + stroke / 2, y + r + stroke / 2),
          start=180, end=360, fill=PIN, width=stroke)
    for x in (cx - r, cx + r):
        d.ellipse((x - stroke / 2, y - stroke / 2, x + stroke / 2, y + stroke / 2), fill=PIN)
    # A pega no corte.
    d.rectangle((120 * s, 130 * s, 136 * s, 150 * s), fill=PIN)
    return im.resize((size, size), Image.LANCZOS)


def tiny() -> Image.Image:
    """16 px desenhado à mão: linha de 2 px, meio sol de 1 px e a pega de 2x2 no corte."""
    im = Image.new('RGBA', (16, 16), GROUND)
    px = im.load()
    for x in range(1, 15):
        for y in (10, 11):
            px[x, y] = PIN
    # Meio sol de raio 4 à volta de (7.5, 10).
    for x, y in [(6, 5), (7, 5), (8, 5), (9, 5), (5, 6), (10, 6), (4, 7), (11, 7),
                 (4, 8), (11, 8), (4, 9), (11, 9)]:
        px[x, y] = PIN
    for x in (7, 8):
        for y in (8, 9):
            px[x, y] = PIN
    return im


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    big = large(256)
    big.save(OUT / 'icon.png')
    sizes = [large(n) for n in (256, 64, 48, 32)] + [tiny()]
    sizes[0].save(OUT / 'icon.ico', format='ICO', append_images=sizes[1:],
                  sizes=[(i.width, i.height) for i in sizes])
    print(f'icon.ico e icon.png em {OUT}')


if __name__ == '__main__':
    main()
