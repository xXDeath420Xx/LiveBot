"""Build the Stream Deck plugin images.

    python scripts/make-icons.py [path to Studio's assets folder]

Plugin icon (256/512 px): the CertiFried badge from Studio's assets (icon.png, or logo-source.png for the sharper
512 px version). Category and action-list icons (28/56 and 20/40 px): white glyphs on transparent, as Stream Deck
asks. Key images (72/144 px): plain glyphs in the CertiFried green #b4e04f on a dark key; "off" states are dimmed.
Everything is drawn at 4x and scaled down, so no fonts or other files are needed.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'com.certifried.studio.sdPlugin' / 'imgs'
ASSETS = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent.parent / 'studio-src' / 'assets'
if not ASSETS.exists():
    ASSETS = ROOT.parent.parent / 'studio' / 'assets'       # in the repo: desktop/studio/assets

GREEN = (180, 224, 79, 255)
DIM = (96, 112, 70, 255)
GREY = (120, 124, 132, 255)
KEY_BG = (20, 22, 18, 255)
WHITE = (255, 255, 255, 255)
SS = 4  # supersampling


def badge():
    src = ASSETS / 'logo-source.png'
    if src.exists():
        logo = Image.open(src).convert('RGBA')
        w, h = logo.size
        size = min(h, 800)
        cx, cy = w // 2, h // 2
        square = logo.crop((cx - size // 2, cy - size // 2, cx + size // 2, cy + size // 2)).resize((512, 512), Image.LANCZOS)
        mask = Image.new('L', (512, 512), 0)
        ImageDraw.Draw(mask).ellipse((4, 4, 507, 507), fill=255)
        out = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
        out.paste(square, (0, 0), mask)
        return out
    return Image.open(ASSETS / 'icon.png').convert('RGBA').resize((512, 512), Image.LANCZOS)


# ---- glyphs, drawn in a 100 x 100 box ----------------------------------------------------------------------------

def g_play(d, c, s):
    d.polygon([(34 * s, 24 * s), (34 * s, 76 * s), (78 * s, 50 * s)], fill=c)


def g_scene(d, c, s, filled=False):
    d.rounded_rectangle((18 * s, 30 * s, 70 * s, 70 * s), radius=round(5 * s), outline=c, width=round(6 * s))
    d.rounded_rectangle((30 * s, 22 * s, 82 * s, 62 * s), radius=round(5 * s), outline=c, width=round(6 * s), fill=c if filled else None)


def g_eye(d, c, s, open_=True):
    d.ellipse((14 * s, 30 * s, 86 * s, 70 * s), outline=c, width=round(6 * s))
    d.ellipse((38 * s, 38 * s, 62 * s, 62 * s), fill=c)
    if not open_:
        d.line((20 * s, 80 * s, 80 * s, 20 * s), fill=c, width=round(7 * s))


def g_mic(d, c, s, muted=False):
    d.rounded_rectangle((38 * s, 14 * s, 62 * s, 58 * s), radius=round(12 * s), fill=c)
    d.arc((26 * s, 30 * s, 74 * s, 72 * s), start=0, end=180, fill=c, width=round(6 * s))
    d.line((50 * s, 72 * s, 50 * s, 84 * s), fill=c, width=round(6 * s))
    d.line((36 * s, 86 * s, 64 * s, 86 * s), fill=c, width=round(6 * s))
    if muted:
        d.line((18 * s, 84 * s, 82 * s, 16 * s), fill=c, width=round(7 * s))


def g_counter(d, c, s):
    d.rounded_rectangle((16 * s, 26 * s, 84 * s, 74 * s), radius=round(10 * s), outline=c, width=round(5 * s))


def g_counter_list(d, c, s):
    d.line((30 * s, 50 * s, 70 * s, 50 * s), fill=c, width=round(8 * s))
    d.line((50 * s, 30 * s, 50 * s, 70 * s), fill=c, width=round(8 * s))


def g_sound(d, c, s):
    d.polygon([(18 * s, 40 * s), (32 * s, 40 * s), (50 * s, 24 * s), (50 * s, 76 * s), (32 * s, 60 * s), (18 * s, 60 * s)], fill=c)
    d.arc((44 * s, 34 * s, 66 * s, 66 * s), start=-60, end=60, fill=c, width=round(6 * s))
    d.arc((44 * s, 22 * s, 82 * s, 78 * s), start=-60, end=60, fill=c, width=round(6 * s))


def g_bulb(d, c, s):
    d.ellipse((28 * s, 14 * s, 72 * s, 58 * s), fill=c)
    d.polygon([(36 * s, 50 * s), (64 * s, 50 * s), (60 * s, 68 * s), (40 * s, 68 * s)], fill=c)
    d.line((40 * s, 76 * s, 60 * s, 76 * s), fill=c, width=round(6 * s))
    d.line((43 * s, 85 * s, 57 * s, 85 * s), fill=c, width=round(6 * s))


def g_cf(d, c, s):
    d.ellipse((12 * s, 12 * s, 88 * s, 88 * s), outline=c, width=round(8 * s))
    g_play(d, c, s)


def render(size, glyph, color, bg=None, inset=0.0, **kw):
    big = size * SS
    img = Image.new('RGBA', (big, big), bg or (0, 0, 0, 0))
    inner = int(round(big * (1 - 2 * inset)))
    layer = Image.new('RGBA', (inner, inner), (0, 0, 0, 0))
    glyph(ImageDraw.Draw(layer), color, inner / 100, **kw)
    off = (big - inner) // 2
    img.alpha_composite(layer, (off, off))
    return img.resize((size, size), Image.LANCZOS)


def save_pair(name, make, small, large):
    OUT.joinpath(name).parent.mkdir(parents=True, exist_ok=True)
    make(small).save(OUT / f'{name}.png')
    make(large).save(OUT / f'{name}@2x.png')


def main():
    b = badge()
    (OUT / 'plugin').mkdir(parents=True, exist_ok=True)
    b.resize((256, 256), Image.LANCZOS).save(OUT / 'plugin' / 'icon.png')
    b.save(OUT / 'plugin' / 'icon@2x.png')
    save_pair('plugin/category', lambda n: render(n, g_cf, WHITE), 28, 56)

    actions = {
        'run-automation': [('key', g_play, GREEN, {})],
        'switch-scene': [('key', g_scene, DIM, {}), ('key-active', g_scene, GREEN, {'filled': True})],
        'toggle-source': [('key', g_eye, DIM, {'open_': False}), ('key-active', g_eye, GREEN, {'open_': True})],
        'mute-input': [('key', g_mic, GREEN, {}), ('key-active', g_mic, GREY, {'muted': True})],
        'counter': [('key', g_counter, DIM, {})],
        'play-sound': [('key', g_sound, GREEN, {})],
        'light-preset': [('key', g_bulb, GREEN, {})],
    }
    list_glyph = {
        'run-automation': (g_play, {}), 'switch-scene': (g_scene, {}), 'toggle-source': (g_eye, {}),
        'mute-input': (g_mic, {}), 'counter': (g_counter_list, {}), 'play-sound': (g_sound, {}), 'light-preset': (g_bulb, {}),
    }
    for name, states in actions.items():
        g, kw = list_glyph[name]
        save_pair(f'actions/{name}/icon', lambda n, g=g, kw=kw: render(n, g, WHITE, **kw), 20, 40)
        for file, glyph, color, kw2 in states:
            save_pair(f'actions/{name}/{file}', lambda n, glyph=glyph, color=color, kw2=kw2: render(n, glyph, color, bg=KEY_BG, inset=0.12, **kw2), 72, 144)
    print('images written to', OUT)


if __name__ == '__main__':
    main()
