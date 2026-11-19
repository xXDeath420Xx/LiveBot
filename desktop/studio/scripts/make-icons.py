"""Build the app and tray icons from the CertiFried logo (dashboard/public/images/CertiFried.png).

    python scripts/make-icons.py

Writes build/icon.ico (installer and exe), assets/icon.png (window), assets/tray.png and
assets/tray-off.png (16/32 px tray glyphs: the logo green when connected, grey when not).
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
# The site logo; a local copy in assets/ wins (handy outside the repo).
SRC = ROOT / 'assets' / 'logo-source.png'
if not SRC.exists():
    SRC = ROOT.parent.parent / 'dashboard' / 'public' / 'images' / 'CertiFried.png'
(ROOT / 'build').mkdir(exist_ok=True)

logo = Image.open(SRC).convert('RGBA')
w, h = logo.size
# The badge is a circle centred in the black square in the middle of the source image.
size = min(h, 800)
cx, cy = w // 2, h // 2
box = (cx - size // 2, cy - size // 2, cx + size // 2, cy + size // 2)
square = logo.crop(box).resize((512, 512), Image.LANCZOS)
mask = Image.new('L', (512, 512), 0)
ImageDraw.Draw(mask).ellipse((4, 4, 507, 507), fill=255)
badge = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
badge.paste(square, (0, 0), mask)

badge.resize((256, 256), Image.LANCZOS).save(ROOT / 'assets' / 'icon.png')
badge.save(ROOT / 'build' / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def tray(color, out):
    s = 64
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((2, 2, s - 3, s - 3), radius=14, fill=color)
    try:
        font = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 38)
    except OSError:
        font = ImageFont.load_default()
    d.text((s / 2, s / 2 + 1), 'CF', font=font, fill=(15, 20, 9, 255), anchor='mm')
    img.resize((32, 32), Image.LANCZOS).save(out)


tray((180, 224, 79, 255), ROOT / 'assets' / 'tray.png')
tray((138, 140, 149, 255), ROOT / 'assets' / 'tray-off.png')
print('icons written')
