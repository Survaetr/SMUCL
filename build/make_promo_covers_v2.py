# -*- coding: utf-8 -*-
"""SMUCL 1.5.0 宣传片封面：B站横版 + 抖音竖版"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "build", "promo2")

FONT_CN_B = "C:/Windows/Fonts/msyhbd.ttc"
FONT_EN_B = "C:/Windows/Fonts/segoeuib.ttf"
FONT_EN = "C:/Windows/Fonts/segoeui.ttf"

WHITE = (246, 249, 255)
GREY = (150, 162, 182)
ACCENT = (122, 168, 240)

BADGE = Image.open(os.path.join(ROOT, "assets", "mascot-badge.png")).convert("RGBA")
WORDS = Image.open(os.path.join(ROOT, "assets", "wordmark.png")).convert("RGBA")


def font(path, size):
    return ImageFont.truetype(path, size)


def bg(w, h, cx=0.5, cy=0.42):
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    dx = (x - w * cx) / (w * 0.7)
    dy = (y - h * cy) / (h * 0.85)
    d = np.sqrt(dx * dx + dy * dy)
    glow = np.clip(1 - d, 0, 1) ** 2.3
    img = np.zeros((h, w, 3), np.float32) + np.array([4, 6, 10], np.float32)
    img += glow[..., None] * np.array([24, 50, 96], np.float32)
    vx = (x - w / 2) / (w / 2)
    vy = (y - h / 2) / (h / 2)
    vig = 1 - 0.5 * np.clip((vx * vx + vy * vy) * 0.5, 0, 1)
    img *= vig[..., None]
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB").convert("RGBA")


def tracked(draw, s, f, center, fill, tracking=0, anchor="mm"):
    widths = [draw.textlength(ch, font=f) for ch in s]
    total = sum(widths) + tracking * max(0, len(s) - 1)
    x = center[0] - total / 2
    for ch, w in zip(s, widths):
        draw.text((x, center[1]), ch, font=f, fill=fill, anchor="lm")
        x += w + tracking


def place_badge(canvas, size, center):
    g = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(g).ellipse([size * 0.05, size * 0.05, size * 0.95, size * 0.95],
                              fill=(70, 130, 220, 120))
    g = g.filter(ImageFilter.GaussianBlur(size * 0.07))
    canvas.alpha_composite(g, (center[0] - size // 2, center[1] - size // 2))
    canvas.alpha_composite(BADGE.resize((size, size), Image.LANCZOS),
                           (center[0] - size // 2, center[1] - size // 2))


def cover(width, height, badge_size, badge_center, word_w, word_center, tag, sub, kicker_y):
    c = bg(width, height, 0.5, 0.34)
    place_badge(c, badge_size, badge_center)
    d = ImageDraw.Draw(c)

    wm = WORDS.resize((word_w, int(WORDS.height * word_w / WORDS.width)), Image.LANCZOS)
    c.alpha_composite(wm, (word_center[0] - wm.width // 2, word_center[1] - wm.height // 2))

    tracked(d, "VERSION 1.5.0", font(FONT_EN_B, int(width * 0.019)), (width // 2, kicker_y), ACCENT, 13)
    tracked(d, tag, font(FONT_CN_B, int(width * 0.042)), (width // 2, kicker_y + int(height * 0.082)), WHITE, 2)
    tracked(d, sub, font(FONT_CN_B, int(width * 0.023)), (width // 2, kicker_y + int(height * 0.140)), GREY, 2)
    tracked(d, "github.com/Survaetr/SMUCL", font(FONT_EN, int(width * 0.019)),
            (width // 2, height - int(height * 0.075)), (96, 120, 160), 1)
    return c.convert("RGB")


# B 站 1146x717
hb = cover(1146, 717, 210, (573, 176), 430, (573, 330),
           "整合包，一次点击", "Modrinth · CurseForge · 加载器一键装", 428)
hb.save(os.path.join(OUT, "cover_bilibili_1146x717.jpg"), quality=94)

# 抖音 1080x1920
vb = cover(1080, 1920, 400, (540, 620), 620, (540, 980),
           "整合包，一次点击", "Modrinth · CurseForge 直接装", 1130)
vb.save(os.path.join(OUT, "cover_douyin_1080x1920.jpg"), quality=94)

print("封面已生成:", hb.size, vb.size)
