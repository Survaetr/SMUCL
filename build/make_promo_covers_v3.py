# -*- coding: utf-8 -*-
"""宣传片封面：B站横版 / 竖屏（抖音·视频号）/ 方形（QQ频道）

复用 make_promo_v3 里的排版工具，保证封面与视频视觉一致。
"""
import os
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_promo_v3 as P  # noqa: E402

OUT = os.path.join(P.ROOT, "build", "promo3")
os.makedirs(OUT, exist_ok=True)


def bg(w, h, tint=1.0):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    u = xx / (w - 1)
    v = yy / (h - 1)
    top = np.array([252, 253, 255], float)
    bot = np.array([234, 241, 250], float)
    t = (v ** 1.1)[..., None]
    img = top * (1 - t) + bot * t
    d = np.sqrt(((u - 0.84) * 1.0) ** 2 + ((v + 0.05) * 1.25) ** 2)
    img += np.array([80, 140, 225], float) * np.exp(-(d ** 2) / 0.20)[..., None] * 0.11 * tint
    d2 = np.sqrt(((u - 0.08) * 1.0) ** 2 + ((v - 1.02) * 1.2) ** 2)
    img += np.array([150, 140, 210], float) * np.exp(-(d2 ** 2) / 0.24)[..., None] * 0.07
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB").convert("RGBA")


def rrect(dst, box, r, fill=None, outline=None, width=1):
    ImageDraw.Draw(dst).rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def shot_card(name, w, h, r=14):
    img = Image.open(os.path.join(P.SHOTS, name)).convert("RGB")
    sw, sh = img.size
    s = max(w / sw, h / sh)
    img = img.resize((int(sw * s + 0.5), int(sh * s + 0.5)), Image.LANCZOS)
    img = img.crop(((img.width - w) // 2, (img.height - h) // 2,
                    (img.width - w) // 2 + w, (img.height - h) // 2 + h)).convert("RGBA")
    img.putalpha(P.rounded_mask(w, h, r))
    pad = 36
    canvas = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([pad, pad + 14, pad + w, pad + 14 + h], radius=r, fill=(20, 40, 78, 84))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(20)))
    canvas.alpha_composite(img, (pad, pad))
    return canvas


def tex(dst, s, x, y, fp, size, color, tracking=0.0, align="left", alpha=1.0):
    layer = P.text_layer(s, fp, size, color, tracking)
    if align == "center":
        x -= layer.width / 2
    elif align == "right":
        x -= layer.width
    P.paste(dst, layer, x, y, alpha)
    return layer.width


def badge(dst, x, y, size):
    b = Image.open(os.path.join(P.ROOT, "assets", "logo-mc.png")).convert("RGBA").resize((size, size), Image.LANCZOS)
    P.paste(dst, b, x, y, 1.0)
    return size


# ---------------------------------------------------------------- 横版 B站
def cover_wide():
    w, h = 1146, 717
    img = bg(w, h)
    tex(img, "SMUCL", 62, 84, P.F_EN_B, 96, P.INK, tracking=7)
    tex(img, "2.0", 64, 196, P.F_EN_B, 54, P.BLUE, tracking=5)
    tex(img, "动效 · 配色 · 更稳的更新", 64, 286, P.F_CN_B, 34, P.INK, tracking=0.5)
    tex(img, "上海海事大学 Minecraft 启动器", 66, 344, P.F_CN, 21, P.INK2, tracking=0.4)

    items = ["退场淡出 + 分级入场", "壁纸取色主题", "更新包三重校验"]
    for i, s in enumerate(items):
        y = 424 + i * 52
        ImageDraw.Draw(img).ellipse([66, y + 9, 78, y + 21], fill=P.BLUE)
        tex(img, s, 92, y, P.F_CN, 22, P.INK2)

    card = shot_card("wall-home.png", 520, 297)
    P.paste(img, card, w - 520 - 96, 250, 1.0)

    # 底部标识
    tex(img, "survaetr.github.io/SMUCL", 66, h - 66, P.F_EN, 19, P.BLUE, tracking=0.4)
    img.convert("RGB").save(os.path.join(OUT, "cover_wide_1146x717.jpg"), quality=92)
    print("cover_wide ok")


# ---------------------------------------------------------------- 竖屏
def cover_vertical():
    w, h = 1080, 1920
    img = bg(w, h, 1.15)
    badge(img, w / 2 - 46, 250, 92)
    tex(img, "SMUCL", w / 2, 380, P.F_EN_B, 132, P.INK, tracking=9, align="center")
    tex(img, "2.0", w / 2, 552, P.F_EN_B, 76, P.BLUE, tracking=6, align="center")
    tex(img, "动效与配色", w / 2, 664, P.F_CN_B, 46, P.INK, tracking=3, align="center")
    tex(img, "上海海事大学 Minecraft 启动器", w / 2, 740, P.F_CN, 25, P.INK2, align="center")

    card = shot_card("wall-home.png", 820, 468, 18)
    P.paste(img, card, (w - card.width) / 2, 850, 1.0)

    rows = [("动效全部重做", "切换有呼吸，按压有回弹"),
            ("主题色跟随背景", "取一枚主色，整套界面跟着变"),
            ("更新包三重校验", "体积 · 结构 · SHA-256")]
    y0 = 1430
    for i, (t1, t2) in enumerate(rows):
        y = y0 + i * 130
        rrect(img, [96, y, 104 + 6, y + 60], 3, fill=P.BLUE + (255,))
        tex(img, t1, 132, y - 4, P.F_CN_B, 34, P.INK)
        tex(img, t2, 132, y + 48, P.F_CN, 23, P.INK2)

    tex(img, "免费 · 开源 · Windows 免安装", w / 2, 1772, P.F_CN, 24, P.INK2, align="center")
    img.convert("RGB").save(os.path.join(OUT, "cover_vertical_1080x1920.jpg"), quality=92)
    print("cover_vertical ok")


# ---------------------------------------------------------------- 方形
def cover_square():
    w, h = 1080, 1080
    img = bg(w, h, 1.05)
    badge(img, 72, 96, 76)
    tex(img, "SMUCL", 172, 96, P.F_EN_B, 84, P.INK, tracking=6)
    tex(img, "2.0 · 动效与配色", 74, 226, P.F_CN_B, 40, P.BLUE, tracking=1.6)
    tex(img, "上海海事大学 Minecraft 启动器", 76, 292, P.F_CN, 22, P.INK2)

    card = shot_card("wall-home.png", 660, 377, 16)
    P.paste(img, card, 74, 400, 1.0)
    tex(img, "主题色跟随背景图", 78, 850, P.F_CN, 22, P.INK2)
    tex(img, "survaetr.github.io/SMUCL", 78, h - 86, P.F_EN, 20, P.BLUE, tracking=0.4)
    img.convert("RGB").save(os.path.join(OUT, "cover_square_1080.jpg"), quality=92)
    print("cover_square ok")


if __name__ == "__main__":
    cover_wide()
    cover_vertical()
    cover_square()
