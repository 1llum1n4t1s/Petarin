# icons/icon.svg と同じデザインを Pillow で描いて PNG を生成するローカル用フォールバック。
# 正規のビルドは scripts/generate-icons.js（sharp）。cairo が無い Windows でも動くようこちらを用意。
#   uv run --no-project --with pillow python scripts/_raster_icons.py
from PIL import Image, ImageDraw, ImageFilter

W = 512          # 作業解像度（縮小してアンチエイリアス）
K = W / 128.0    # 128 基準座標 → 作業座標


def s(*v):
    return tuple(int(round(x * K)) for x in v) if len(v) > 1 else int(round(v[0] * K))


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


PAPER_TOP = (255, 236, 154)
PAPER_BOT = (248, 212, 94)
DEEP = (239, 194, 62)
DEEP2 = (227, 182, 54)
INK = (92, 74, 30)

img = Image.new("RGBA", (W, W), (0, 0, 0, 0))

# 影
shadow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
ds = ImageDraw.Draw(shadow)
ds.rounded_rectangle([s(16), s(18), s(116), s(116)], radius=s(20), fill=(92, 74, 30, 70))
shadow = shadow.filter(ImageFilter.GaussianBlur(s(3)))
img.alpha_composite(shadow)

# 紙のグラデーション本体（縦グラデを丸角＋折れ角マスクで切り抜く）
grad = Image.new("RGBA", (W, W), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
top, bot = s(14), s(114)
for y in range(top, bot):
    t = (y - top) / (bot - top)
    gd.line([(0, y), (W, y)], fill=lerp(PAPER_TOP, PAPER_BOT, t) + (255,))

mask = Image.new("L", (W, W), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([s(14), s(14), s(114), s(114)], radius=s(20), fill=255)
# 右上を斜めにカット（折れ角の輪郭）
md.polygon([s(84, 14), s(116, 14), s(116, 44)], fill=0)
grad.putalpha(Image.composite(grad.getchannel("A"), Image.new("L", (W, W), 0), mask))
img.alpha_composite(grad)

# 折れ角の裏面
flap = Image.new("RGBA", (W, W), (0, 0, 0, 0))
fd = ImageDraw.Draw(flap)
fd.polygon([s(84, 14), s(84, 44), s(114, 44)], fill=DEEP + (255,))
fd.polygon([s(84, 14), s(114, 44), s(95, 44)], fill=DEEP2 + (255,))
img.alpha_composite(flap)

# ＋
draw = ImageDraw.Draw(img)
draw.rounded_rectangle([s(33), s(60), s(87), s(74)], radius=s(7), fill=INK + (255,))
draw.rounded_rectangle([s(53), s(40), s(67), s(94)], radius=s(7), fill=INK + (255,))

for size in (16, 48, 128):
    img.resize((size, size), Image.LANCZOS).save(f"icons/icon-{size}.png")
    print(f"icons/icon-{size}.png ok")
