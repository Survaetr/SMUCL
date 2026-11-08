# -*- coding: utf-8 -*-
"""
SMUCL 2.0.1 宣传片封面 v4（三版）

  cover_wide_1146x717.jpg     B站（16:10）
  cover_vertical_1080x1920.jpg 抖音 / 微信视频号（9:16）
  cover_square_1080.jpg       QQ频道（1:1）

构图统一：浅色底 + 吉祥物 + 大字标题 + 三张真实界面卡片斜叠，
缩到 200px 宽也能认出「启动器 + 界面 + 2.0」。
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "build", "shots200", "safe")   # 已脱敏（账号名与 UUID 已虚化）
MASCOT = os.path.join(ROOT, "build", "mascot")
OUT = os.path.join(ROOT, "build", "promo4")
os.makedirs(OUT, exist_ok=True)

F_CN_B = "C:/Windows/Fonts/msyhbd.ttc"
F_CN = "C:/Windows/Fonts/msyh.ttc"
F_EN_B = "C:/Windows/Fonts/seguisb.ttf"

INK = (13, 27, 46)
INK2 = (86, 102, 128)
BLUE = (31, 86, 173)
BLUE_HI = (59, 124, 232)

_fc = {}


def font(p, s):
    k = (p, s)
    if k not in _fc:
        _fc[k] = ImageFont.truetype(p, s)
    return _fc[k]


def bg(w, h):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    u, v = xx / (w - 1), yy / (h - 1)
    top = np.array([252, 253, 255], float)
    bot = np.array([228, 236, 248], float)
    img = top * (1 - v[..., None] ** 1.2) + bot * (v[..., None] ** 1.2)
    d = np.sqrt(((u - 0.78) * w / h) ** 2 + ((v + 0.15) * 1.3) ** 2)
    img += np.array([80, 140, 225], float) * np.exp(-(d ** 2) / 0.26)[..., None] * 0.16
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB").convert("RGBA")


def card(name, w, h, r=14):
    src = Image.open(os.path.join(SHOTS, name + ".png")).convert("RGB")
    sw, sh = src.size
    s = max(w / sw, h / sh)
    img = src.resize((int(sw * s + 0.5), int(sh * s + 0.5)), Image.LANCZOS)
    l, t = (img.width - w) // 2, (img.height - h) // 2
    img = img.crop((l, t, l + w, t + h)).convert("RGBA")
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w - 1, h - 1], radius=r, fill=255)
    img.putalpha(m)
    # 投影
    pad = 30
    cv = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    sh_layer = Image.new("RGBA", cv.size, (0, 0, 0, 0))
    sh_layer.paste((20, 38, 68, 105), (pad, pad + 10), m)
    cv.alpha_composite(sh_layer.filter(ImageFilter.GaussianBlur(16)))
    cv.alpha_composite(img, (pad, pad))
    return cv


def text(dst, s, x, y, fp, size, color, anchor="left", tracking=0.0):
    f = font(fp, size)
    if tracking:
        widths = [f.getbbox(c)[2] or size * 0.5 for c in s]
        total = int(sum(widths) + tracking * (len(s) - 1))
        lay = Image.new("RGBA", (max(1, total), size * 2), (0, 0, 0, 0))
        d = ImageDraw.Draw(lay)
        cx = 0
        for c, w in zip(s, widths):
            d.text((cx, 0), c, font=f, fill=color + (255,))
            cx += w + tracking
        w = lay.width
        if anchor == "center":
            x -= w / 2
        dst.alpha_composite(lay, (int(x), int(y)))
        return w
    bbox = f.getbbox(s)
    w = bbox[2] - bbox[0]
    if anchor == "center":
        x -= w / 2
    ImageDraw.Draw(dst).text((int(x), int(y)), s, font=f, fill=color + (255,))
    return w


def mascot(size):
    return Image.open(os.path.join(MASCOT, "mascot_badge_1024.png")).convert("RGBA").resize((size, size), Image.LANCZOS)


def paste_center(dst, img, cx, cy):
    dst.alpha_composite(img, (int(cx - img.width / 2), int(cy - img.height / 2)))


def badge(dst, s, x, y, size=34, color=BLUE):
    f = font(F_CN_B, size)
    w = f.getbbox(s)[2] + 40
    lay = Image.new("RGBA", (w, size + 20), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    d.rounded_rectangle((0, 0, w - 1, size + 19), radius=(size + 20) // 2,
                        fill=color + (34,), outline=color + (120,), width=2)
    d.text((20, 6), s, font=f, fill=color + (255,))
    dst.alpha_composite(lay, (int(x), int(y)))
    return w


# ---------------------------------------------------------------- 横版
def wide():
    w, h = 1146, 717
    im = bg(w, h)

    # 右上：三张卡片斜叠
    specs = [("saves", 330, 186, 0.0), ("packs", 330, 186, 0.0), ("versions", 330, 186, 0.0)]
    cx, cy = 760, 300
    for i, (nm, cw, ch, _) in enumerate(specs):
        c = card(nm, cw, ch)
        c = c.rotate(-6 + i * 1.0, resample=Image.BICUBIC, expand=True)
        paste_center(im, c, cx + i * 52 - 40, cy + i * 62 - 40)

    # 吉祥物压左下
    paste_center(im, mascot(232), 150, 214)

    text(im, "SMUCL 2.0", 62, 350, F_EN_B, 92, INK, tracking=1.0)
    text(im, "开源的 Minecraft 启动器", 66, 466, F_CN_B, 42, BLUE)
    text(im, "不用搬家 · 加载器 / 整合包 / 存档 一站管", 66, 530, F_CN, 27, INK2)
    badge(im, "上海海事大学 · MIT", 66, 590, 25)

    im.convert("RGB").save(os.path.join(OUT, "cover_wide_1146x717.jpg"), quality=94)
    print("横版 ok")


# ---------------------------------------------------------------- 竖版
def vertical():
    w, h = 1080, 1920
    im = bg(w, h)

    paste_center(im, mascot(360), w / 2, 330)

    text(im, "SMUCL", w / 2, 556, F_EN_B, 156, INK, anchor="center", tracking=4)
    badge(im, "2.0.1", w / 2 - 58, 744, 32)

    text(im, "开源的", w / 2, 830, F_CN_B, 72, BLUE, anchor="center")
    text(im, "Minecraft 启动器", w / 2, 918, F_CN_B, 72, BLUE, anchor="center")

    # 三张卡片纵向排列（保持卡片比例，避免被压成细条）
    for i, (nm, yy) in enumerate([("versions", 1140), ("packs", 1340), ("saves", 1540)]):
        c = card(nm, 660, 150, r=12)
        paste_center(im, c, w / 2 + (i - 1) * 6, yy)

    text(im, "加载器 · 整合包 · 存档 · 一键装", w / 2, 1700, F_CN, 33, INK2, anchor="center")
    text(im, "Windows 免安装 · 142 MB", w / 2, 1760, F_CN_B, 30, BLUE, anchor="center")

    im.convert("RGB").save(os.path.join(OUT, "cover_vertical_1080x1920.jpg"), quality=94)
    print("竖版 ok")


# ---------------------------------------------------------------- 方版
def square():
    w = h = 1080
    im = bg(w, h)

    c = card("versions", 420, 236)
    c = c.rotate(-5, resample=Image.BICUBIC, expand=True)
    paste_center(im, c, 716, 300)

    paste_center(im, mascot(210), 250, 286)

    text(im, "SMUCL 2.0", 92, 470, F_EN_B, 104, INK, tracking=1.0)
    text(im, "开源的 Minecraft 启动器", 96, 610, F_CN_B, 46, BLUE)
    text(im, "不用搬家 · 一站管完", 96, 690, F_CN, 30, INK2)
    badge(im, "上海海事大学 · MIT · 142 MB", 96, 770, 28)

    im.convert("RGB").save(os.path.join(OUT, "cover_square_1080.jpg"), quality=94)
    print("方版 ok")


if __name__ == "__main__":
    wide()
    vertical()
    square()
