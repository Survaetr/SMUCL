# -*- coding: utf-8 -*-
"""
SMUCL 2.0 宣传片 —— 发布会风格（浅色调）

1920x1080 / 60fps / 60 秒 / 逐帧程序化渲染

设计约束：
  · 全部使用真实运行截图（build/shots200），不画假 UI
  · 极简：一屏一句话，字号大、留白多、切点少
  · 动效只做三种：淡入上浮、缓推（Ken Burns）、横向滑入
  · 配色沿用落地页：海事蓝 + 校徽金 + 珊瑚色（取色演示）
"""
import os
import sys
import math
import subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "build", "shots200")
OUT = os.path.join(ROOT, "build", "promo3")
os.makedirs(OUT, exist_ok=True)

W, H, FPS = 1920, 1080, 60
DUR = 60.0
NFRAMES = int(DUR * FPS)

F_CN_B = "C:/Windows/Fonts/msyhbd.ttc"
F_CN = "C:/Windows/Fonts/msyh.ttc"
F_EN_B = "C:/Windows/Fonts/seguisb.ttf"
F_EN = "C:/Windows/Fonts/segoeui.ttf"

INK = (13, 27, 46)
INK2 = (86, 102, 128)
BLUE = (31, 86, 173)
BLUE_HI = (59, 124, 232)
GOLD = (181, 126, 24)
CORAL = (176, 66, 74)

_fontcache = {}


def font(path, size):
    key = (path, size)
    if key not in _fontcache:
        _fontcache[key] = ImageFont.truetype(path, size)
    return _fontcache[key]


# ---------------------------------------------------------------- 缓动
def clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def eout(x):
    """ease-out-expo：开头快、结尾稳，发布会字幕的常用曲线"""
    x = clamp(x)
    return 1.0 if x >= 1 else 1 - 2 ** (-10 * x)


def eout_cubic(x):
    x = clamp(x)
    return 1 - (1 - x) ** 3


def ein_out(x):
    x = clamp(x)
    return 3 * x * x - 2 * x * x * x


def seg(t, start, dur):
    """返回某一段内的归一化进度"""
    if dur <= 0:
        return 1.0 if t >= start else 0.0
    return clamp((t - start) / dur)


# ---------------------------------------------------------------- 背景
def build_bg():
    """浅色底：上白下灰蓝，右上角一片极淡的蓝光，底部一条高光"""
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    u = xx / (W - 1)
    v = yy / (H - 1)
    top = np.array([252, 253, 255], float)
    bot = np.array([236, 242, 250], float)
    t = (v ** 1.15)[..., None]
    img = top * (1 - t) + bot * t
    # 右上柔光
    d = np.sqrt(((u - 0.86) * 1.0) ** 2 + ((v + 0.10) * 1.35) ** 2)
    img += np.array([80, 140, 225], float) * np.exp(-(d ** 2) / 0.22)[..., None] * 0.10
    # 左下反向冷光
    d2 = np.sqrt(((u - 0.06) * 1.0) ** 2 + ((v - 1.05) * 1.3) ** 2)
    img += np.array([120, 150, 210], float) * np.exp(-(d2 ** 2) / 0.26)[..., None] * 0.07
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")


BG = build_bg()
# 顶部细网格，暗示"工程感"，透明度压到极低，边缘径向淡出
_grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
_g = ImageDraw.Draw(_grid)
for x in range(0, W, 96):
    _g.line([(x, 0), (x, H)], fill=(31, 86, 173, 9), width=1)
for y in range(0, H, 96):
    _g.line([(0, y), (W, y)], fill=(31, 86, 173, 9), width=1)
# 注意：putalpha 会整条替换 alpha，必须用 multiply 把渐变乘进原有 alpha，
# 否则整块网格底会被染成一个黑色圆斑
_yy, _xx = np.mgrid[0:H, 0:W].astype(np.float32)
_rr = np.sqrt(((_xx / W - 0.5) * 1.0) ** 2 + ((_yy / H - 0.25) * 1.4) ** 2)
_ga = np.clip(1 - _rr / 0.62, 0, 1) ** 1.4
_grid.putalpha(ImageChops.multiply(_grid.getchannel("A"), Image.fromarray((_ga * 255).astype(np.uint8), "L")))


# ---------------------------------------------------------------- 文字层
_tc = {}


def text_layer(text, fontpath, size, color, tracking=0.0, bold_pad=0):
    key = (text, fontpath, size, color, tracking)
    if key in _tc:
        return _tc[key]
    f = font(fontpath, size)
    # 先量宽：tracking 需要逐字排，宽度要自己算
    widths = []
    for ch in text:
        bb = f.getbbox(ch)
        widths.append(bb[2] if bb else size * 0.5)
    total = int(sum(widths) + tracking * max(0, len(text) - 1)) + bold_pad * 2
    asc, desc = f.getmetrics()
    img = Image.new("RGBA", (max(1, total), asc + desc + bold_pad * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x = bold_pad
    for ch, w in zip(text, widths):
        d.text((x, bold_pad), ch, font=f, fill=color + (255,))
        x += w + tracking
    _tc[key] = img
    return img


def paste(dst, src, x, y, alpha=1.0):
    if alpha <= 0.004:
        return
    if alpha >= 0.996:
        dst.paste(src, (int(x), int(y)), src)
        return
    a = src.getchannel("A").point(lambda p: int(p * alpha))
    dst.paste(src, (int(x), int(y)), a)


def draw_text(dst, text, x, y, fontpath, size, color, tracking=0.0, alpha=1.0, anchor="left"):
    layer = text_layer(text, fontpath, size, color, tracking)
    if anchor == "center":
        x -= layer.width / 2
    elif anchor == "right":
        x -= layer.width
    paste(dst, layer, x, y, alpha)
    return layer.width


# ---------------------------------------------------------------- 截图卡片
_cardcache = {}


def rounded_mask(w, h, r):
    key = ("m", w, h, r)
    if key in _cardcache:
        return _cardcache[key]
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w - 1, h - 1], radius=r, fill=255)
    _cardcache[key] = m
    return m


def card(src_name, w, h, radius=16, shadow=True):
    """把截图缩到 w×h，切圆角，配一层柔和投影（结果缓存）"""
    key = ("c", src_name, w, h, radius)
    if key in _cardcache:
        return _cardcache[key]
    src = Image.open(os.path.join(SHOTS, src_name)).convert("RGB")
    sw, sh = src.size
    scale = max(w / sw, h / sh)
    nw, nh = int(sw * scale + 0.5), int(sh * scale + 0.5)
    img = src.resize((nw, nh), Image.LANCZOS)
    left = (nw - w) // 2
    top = (nh - h) // 2
    img = img.crop((left, top, left + w, top + h)).convert("RGBA")
    img.putalpha(rounded_mask(w, h, radius))

    if not shadow:
        _cardcache[key] = img
        return img

    pad = 46
    canvas = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    sil = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    sil.paste((22, 40, 70, 92), (pad, pad + 16), rounded_mask(w, h, radius))
    sil = sil.filter(ImageFilter.GaussianBlur(22))
    canvas.alpha_composite(sil)
    canvas.alpha_composite(img, (pad, pad))
    _cardcache[key] = (canvas, pad)
    return _cardcache[key]


def paste_card(dst, name, cx, cy, w, h, alpha=1.0, radius=16):
    c = card(name, w, h, radius)
    if isinstance(c, tuple):
        canvas, pad = c
        paste(dst, canvas, cx - canvas.width / 2, cy - canvas.height / 2, alpha)
    else:
        paste(dst, c, cx - w / 2, cy - h / 2, alpha)


# 撑满屏的截图：先把图缩到「刚好吃满 1920×1080」，再按 zoom 裁窗口。
# 之前的写法把 min_scale 乘错了，开场就裁掉 15%，实机画面看不到全貌。
class KenBurns:
    def __init__(self, name):
        src = Image.open(os.path.join(SHOTS, name)).convert("RGB")
        sw, sh = src.size
        s = max(W / sw, H / sh)
        self.img = src.resize((int(sw * s + 0.5), int(sh * s + 0.5)), Image.LANCZOS)
        self.iw, self.ih = self.img.size

    def frame(self, p, zoom_from=1.0, zoom_to=1.06, pan=(0.0, 0.0)):
        z = zoom_from + (zoom_to - zoom_from) * eout_cubic(p)
        cw = int(min(self.iw, W / z))
        ch = int(min(self.ih, H / z))
        cx = self.iw / 2 + pan[0] * max(0, (self.iw - cw)) / 2 * p
        cy = self.ih / 2 + pan[1] * max(0, (self.ih - ch)) / 2 * p
        left = int(clamp(cx - cw / 2, 0, self.iw - cw))
        top = int(clamp(cy - ch / 2, 0, self.ih - ch))
        return self.img.crop((left, top, left + cw, top + ch)).resize((W, H), Image.BILINEAR)


_kb = {}


def kenburns(name):
    if name not in _kb:
        _kb[name] = KenBurns(name)
    return _kb[name]


# ---------------------------------------------------------------- 装饰
def draw_rule(dst, x, y, w, alpha=1.0, color=(31, 86, 173)):
    img = Image.new("RGBA", (max(1, int(w)), 2), color + (int(120 * alpha),))
    paste(dst, img, x, y, 1.0)


def kicker(dst, text, x, y, alpha, color=BLUE):
    """小标签：一条短线 + 字距拉开的标题"""
    draw_rule(dst, x, y + 16, 28 * eout(alpha), alpha, color)
    draw_text(dst, text, x + 40, y, F_CN, 24, color, tracking=3.2, alpha=alpha)


def check_icon(dst, cx, cy, r, alpha):
    s = int(r * 4)
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([2, 2, s - 3, s - 3], fill=(31, 86, 173, 26), outline=(31, 86, 173, 70), width=3)
    lw = max(3, s // 22)
    d.line([(s * 0.32, s * 0.52), (s * 0.45, s * 0.65), (s * 0.70, s * 0.36)], fill=(31, 86, 173, 255), width=lw, joint="curve")
    paste(dst, img, cx - s / 2, cy - s / 2, alpha)


# ---------------------------------------------------------------- 场景
def s1_logo(dst, t):
    """开场：徽章 + 字标，缓慢上浮"""
    a = eout(seg(t, 0.25, 1.3))
    a2 = eout(seg(t, 0.75, 1.3))
    a3 = eout(seg(t, 1.15, 1.3))
    cy = H * 0.44

    # 校徽：圆形遮罩 + 一圈细环
    badge = Image.open(os.path.join(ROOT, "assets", "logo-mc.png")).convert("RGBA")
    size = 168
    badge = badge.resize((size, size), Image.LANCZOS)
    ring = Image.new("RGBA", (size + 28, size + 28), (0, 0, 0, 0))
    ImageDraw.Draw(ring).ellipse([0, 0, ring.width - 1, ring.height - 1], outline=(31, 86, 173, 60), width=2)
    bx = W / 2 - size / 2
    by = cy - 150 + (1 - a) * 18
    paste(dst, ring, bx - 14, by - 14, a)
    paste(dst, badge, bx, by, a)

    draw_text(dst, "SMUCL", W / 2, cy + 14 + (1 - a2) * 16, F_EN_B, 118, INK, tracking=10, alpha=a2, anchor="center")
    draw_text(dst, "2.0", W / 2, cy + 148 + (1 - a3) * 14, F_EN_B, 68, BLUE, tracking=6, alpha=a3, anchor="center")
    draw_text(dst, "上海海事大学 · Minecraft 启动器", W / 2, cy + 246, F_CN, 27, INK2, tracking=2.4, alpha=eout(seg(t, 1.7, 1.2)), anchor="center")


def s2_statement(dst, t, lt):
    a = eout(seg(lt, 0.15, 1.1))
    b = eout(seg(lt, 0.65, 1.1))
    c = eout(seg(lt, 1.25, 1.1))
    y = H * 0.42
    draw_text(dst, "手感，也是一种功能。", W / 2, y + (1 - b) * 22, F_CN_B, 96, INK, alpha=b, anchor="center")
    draw_text(dst, "2.0 没有堆功能，我们把整个界面的动效与配色重做了一遍。", W / 2, y + 150 + (1 - c) * 18, F_CN, 34, INK2, alpha=c, anchor="center")
    draw_rule(dst, W / 2 - 60 * a, y - 92, 120 * a, a * 0.8)


def s3_motion(dst, t, lt):
    """动效：一行三张截图依次升起（不重叠，读得清）"""
    ka = eout(seg(lt, 0.1, 0.9))
    kicker(dst, "01  动效", 140, 118, ka)
    draw_text(dst, "每一次切换，都有呼吸", 140, 168 + (1 - eout(seg(lt, 0.25, 1.1))) * 20, F_CN_B, 68, INK, alpha=eout(seg(lt, 0.25, 1.1)))
    draw_text(dst, "退场淡出 · 内容分级浮起 · 按压回弹 · 进度缓动", 142, 268, F_CN, 26, INK2, alpha=eout(seg(lt, 0.55, 1.0)))

    trio = [("home.png", "首页"), ("versions.png", "版本管理"), ("download.png", "下载游戏")]
    w, h = 536, 307
    gap = 40
    total = w * 3 + gap * 2
    x0 = (W - total) / 2
    for i, (name, label) in enumerate(trio):
        p = eout(seg(lt, 0.55 + i * 0.16, 1.15))
        if p <= 0:
            continue
        cx = x0 + w / 2 + i * (w + gap)
        cy = 628 + (1 - p) * 34
        paste_card(dst, name, cx, cy, w, h, alpha=p)
        draw_text(dst, label, cx, cy + h / 2 + 34, F_CN, 21, INK2, alpha=p * 0.9, anchor="center")


def s4_accent(dst, t, lt):
    """取色：左蓝右珊瑚，中间一枚箭头"""
    kicker(dst, "02  主题色", 140, 108, eout(seg(lt, 0.1, 0.9)), GOLD)
    draw_text(dst, "让它长成你桌面的样子", 140, 156 + (1 - eout(seg(lt, 0.25, 1.1))) * 20, F_CN_B, 62, INK, alpha=eout(seg(lt, 0.25, 1.1)))
    draw_text(dst, "从背景图取一枚主色，按钮、选中态、横幅光晕一起跟着变", 142, 252, F_CN, 26, INK2, alpha=eout(seg(lt, 0.55, 1.0)))

    pa = eout(seg(lt, 0.45, 1.1))
    pb = eout(seg(lt, 1.15, 1.1))
    w, h = 760, 434
    paste_card(dst, "accent-a.png", W / 2 - w / 2 - 66 - (1 - pa) * 40, 716, w, h, pa * 0.92)
    paste_card(dst, "accent-b.png", W / 2 + w / 2 + 66 + (1 - pb) * 40, 716, w, h, pb)

    draw_text(dst, "固定校徽蓝", W / 2 - w / 2 - 66, 456, F_CN, 24, INK2, alpha=pa * 0.9, anchor="center")
    draw_text(dst, "跟随背景图取色", W / 2 + w / 2 + 66, 456, F_CN, 24, CORAL, alpha=pb, anchor="center")

    # 中间箭头
    aa = eout(seg(lt, 1.5, 0.9))
    if aa > 0:
        img = Image.new("RGBA", (120, 60), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.line([(6, 30), (96, 30)], fill=(120, 132, 152, 255), width=3)
        d.line([(74, 14), (98, 30), (74, 46)], fill=(120, 132, 152, 255), width=3, joint="curve")
        paste(dst, img, W / 2 - 60 - (1 - aa) * 12, 700, aa)


def s5_verify(dst, t, lt):
    kicker(dst, "03  更新", 140, 118, eout(seg(lt, 0.1, 0.9)))
    draw_text(dst, "坏包，进不了你的硬盘", 140, 168 + (1 - eout(seg(lt, 0.25, 1.1))) * 20, F_CN_B, 68, INK, alpha=eout(seg(lt, 0.25, 1.1)))
    draw_text(dst, "自动更新下载完成后，先过三道检查再动手。", 142, 268, F_CN, 26, INK2, alpha=eout(seg(lt, 0.5, 1.0)))

    rows = [("体积核对", "与 Release 记录逐字节比对"), ("zip 结构", "不是真正的 zip 就直接丢弃"), ("SHA-256 摘要", "与发布摘要不一致拒绝安装")]
    for i, (t1, t2) in enumerate(rows):
        p = eout(seg(lt, 0.7 + i * 0.22, 1.0))
        y = 420 + i * 132
        check_icon(dst, 190, y + 30, 26, p)
        draw_text(dst, t1, 244 + (1 - p) * 14, y, F_CN_B, 40, INK, alpha=p)
        draw_text(dst, t2, 246 + (1 - p) * 14, y + 52, F_CN, 24, INK2, alpha=p * 0.95)

    # 右侧：一张「更新包体检单」，数字全部来自真实产物
    pc = eout(seg(lt, 0.9, 1.3))
    if pc > 0:
        cw, chh = 640, 356
        cx, cy = 1368, 566
        pad = 30
        card_img = Image.new("RGBA", (cw + pad * 2, chh + pad * 2 + 16), (0, 0, 0, 0))
        sh = Image.new("RGBA", card_img.size, (0, 0, 0, 0))
        ImageDraw.Draw(sh).rounded_rectangle([pad, pad + 14, pad + cw, pad + 14 + chh], radius=20, fill=(22, 40, 70, 64))
        card_img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(18)))

        panel = Image.new("RGBA", (cw, chh), (0, 0, 0, 0))
        d = ImageDraw.Draw(panel)
        d.rounded_rectangle([0, 0, cw - 1, chh - 1], radius=20, fill=(255, 255, 255, 255), outline=(224, 233, 245, 255), width=2)
        card_img.alpha_composite(panel, (pad, pad))
        # 顶部色条：左右各缩进一点，跟圆角对齐
        d2 = ImageDraw.Draw(card_img)
        d2.rounded_rectangle([pad + 24, pad, pad + cw - 25, pad + 5], radius=3, fill=BLUE + (255,))

        draw_text(card_img, "更新包体检单", pad + 34, pad + 34, F_CN_B, 26, INK)
        draw_text(card_img, "app-2.0.0.zip", pad + 34, pad + 78, F_EN, 21, INK2)
        rows = [("体积", "385,530 字节"), ("结构", "PK 头正常"), ("SHA-256", "80b545…8d66c")]
        for i, (k, v) in enumerate(rows):
            y = pad + 132 + i * 60
            draw_text(card_img, k, pad + 34, y, F_CN, 21, INK2)
            draw_text(card_img, v, pad + 190, y, F_CN, 21, INK)
            # 右侧勾：直接画，避免字体缺字变成方块
            gx, gy = pad + cw - 58, y + 14
            d2.line([(gx - 9, gy), (gx - 2, gy + 7), (gx + 11, gy - 9)], fill=(34, 126, 78, 255), width=3, joint="curve")
            d2.line([(pad + 34, y + 44), (pad + cw - 34, y + 44)], fill=(233, 239, 248, 255), width=1)
        draw_text(card_img, "三项都过，才允许覆盖安装", pad + 34, pad + chh - 46, F_CN, 20, INK2, alpha=0.9)
        paste(dst, card_img, cx - card_img.width / 2, cy - card_img.height / 2, pc)


def s6_demo(dst, t, lt):
    """实机演示：两段缓推，中间交叉淡化"""
    aA = eout(seg(lt, 0.0, 0.7)) * (1 - ein_out(seg(lt, 4.35, 0.45)))
    aB = ein_out(seg(lt, 4.35, 0.55))
    if aA > 0:
        frame = kenburns("home.png").frame(seg(lt, 0.0, 4.8), 1.0, 1.05, pan=(0.30, 0.20))
        paste(dst, frame.convert("RGBA"), 0, 0, aA)
    if aB > 0:
        frame = kenburns("saves.png").frame(seg(lt, 4.35, 5.2), 1.06, 1.0, pan=(-0.28, 0.18))
        paste(dst, frame.convert("RGBA"), 0, 0, aB)

    # 标签放右上角，避开左侧边栏与顶部横幅，也不会跟字幕打架
    la = eout(seg(lt, 0.45, 0.9)) * (1 - eout(seg(lt, 8.0, 0.8)))
    if la > 0:
        pill = Image.new("RGBA", (196, 46), (0, 0, 0, 0))
        ImageDraw.Draw(pill).rounded_rectangle([0, 0, 195, 45], radius=23, fill=(255, 255, 255, 240))
        paste(dst, pill, W - 72 - 196, 66, la)
        draw_text(dst, "实机演示", W - 72 - 196 + 30, 76, F_CN, 21, INK, tracking=2.6, alpha=la)

    # 底部字幕条：上沿 56px 渐隐，下面压到接近实白
    bs = eout(seg(lt, 0.9, 1.0)) * (1 - eout(seg(lt, 7.6, 1.0)))
    if bs > 0:
        bar = Image.new("RGBA", (W, 210), (255, 255, 255, 0))
        d = ImageDraw.Draw(bar)
        for i in range(210):
            a = int(250 * (i / 56) ** 1.5) if i < 56 else 250
            d.line([(0, i), (W, i)], fill=(251, 252, 255, a))
        d.line([(0, 56), (W, 56)], fill=(226, 234, 246, 90), width=1)
        paste(dst, bar, 0, H - 210, bs)

        if lt < 4.9:
            p = bs * (1 - ein_out(seg(lt, 4.4, 0.4)))
            draw_text(dst, "6 个实例、11 个存档，一次扫描全部就位", W / 2, H - 150, F_CN_B, 40, INK, alpha=p, anchor="center")
            draw_text(dst, "版本隔离、模组数量、占用空间，一眼看清", W / 2, H - 88, F_CN, 24, INK2, alpha=p * 0.95, anchor="center")
        if lt > 4.3:
            p = bs * ein_out(seg(lt, 4.35, 0.6))
            draw_text(dst, "11 个存档，按实例、版本、时间分组", W / 2, H - 150, F_CN_B, 40, INK, alpha=p, anchor="center")
            draw_text(dst, "读 level.dat 拿到版本、模式与最后游玩时间", W / 2, H - 88, F_CN, 24, INK2, alpha=p * 0.95, anchor="center")


def s7_stats(dst, t, lt):
    kicker(dst, "04  规格", 140, 118, eout(seg(lt, 0.1, 0.9)))
    draw_text(dst, "轻到可以塞进 U 盘", 140, 168 + (1 - eout(seg(lt, 0.2, 1.0))) * 20, F_CN_B, 68, INK, alpha=eout(seg(lt, 0.2, 1.0)))

    data = [("142", "MB", "免安装包"), ("4", "种", "加载器一键装"), ("MIT", "", "完全开源")]
    xs = [W * 0.22, W * 0.5, W * 0.78]
    base = 600  # 数字的大致基线
    for i, (num, unit, label) in enumerate(data):
        p = eout(seg(lt, 0.4 + i * 0.16, 1.0))
        y = base + (1 - p) * 18
        nw = draw_text(dst, num, xs[i], y, F_EN_B, 128, INK, alpha=p, anchor="center")
        if unit:
            # 单位贴数字右下角，底部对齐，避免悬在半空
            draw_text(dst, unit, xs[i] + nw / 2 + 6, y + 92, F_CN, 30, INK2, alpha=p)
        draw_text(dst, label, xs[i], y + 186, F_CN, 26, INK2, alpha=p * 0.95, anchor="center")
        if i:
            ln = Image.new("RGBA", (1, 150), (188, 202, 222, int(150 * p)))
            paste(dst, ln, xs[i] - W * 0.14, y + 16, 1.0)


def s8_end(dst, t, lt):
    a = eout(seg(lt, 0.15, 1.1))
    b = eout(seg(lt, 0.6, 1.1))
    c = eout(seg(lt, 1.0, 1.1))
    d = eout(seg(lt, 1.4, 1.1))
    cy = H * 0.40
    badge = Image.open(os.path.join(ROOT, "assets", "logo-mc.png")).convert("RGBA")
    size = 92
    badge = badge.resize((size, size), Image.LANCZOS)
    paste(dst, badge, W / 2 - size / 2, cy - 190 + (1 - a) * 12, a)
    draw_text(dst, "SMUCL", W / 2, cy - 62 + (1 - a) * 18, F_EN_B, 104, INK, tracking=9, alpha=a, anchor="center")
    draw_text(dst, "2.0 · 动效与配色", W / 2, cy + 98 + (1 - b) * 14, F_CN, 32, BLUE, tracking=2.2, alpha=b, anchor="center")
    draw_rule(dst, W / 2 - 90 * c, cy + 168, 180 * c, c * 0.7)
    draw_text(dst, "免费 · 开源 · Windows 免安装", W / 2, cy + 206 + (1 - c) * 14, F_CN, 28, INK2, alpha=c, anchor="center")
    draw_text(dst, "survaetr.github.io/SMUCL", W / 2, cy + 268 + (1 - d) * 12, F_EN, 30, BLUE, tracking=0.6, alpha=d, anchor="center")


# 场景表：(起始时间, 时长, 绘制函数, 是否需要局部时间)
SCENES = [
    (0.0, 7.0, s1_logo, False),
    (7.0, 6.5, s2_statement, True),
    (13.5, 8.5, s3_motion, True),
    (22.0, 9.0, s4_accent, True),
    (31.0, 7.5, s5_verify, True),
    (38.5, 9.5, s6_demo, True),
    (47.0, 6.5, s7_stats, True),
    (53.5, 6.5, s8_end, True),
]

XFADE = 0.55  # 场景交叉淡入时长


def render_frame(t):
    """在渐变底上重画一遍，避免纯色底与渐变底接缝"""
    f = BG.copy().convert("RGBA")
    f.alpha_composite(_grid)
    idx = 0
    for i, (st, du, fn, _) in enumerate(SCENES):
        if t >= st:
            idx = i
    st, du, fn, local = SCENES[idx]

    def paint(base, stime, tloc):
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        if local:
            fn(layer, stime, tloc)
        else:
            fn(layer, stime)
        return layer

    cur = paint(None, t, t - st)
    if idx > 0 and t - st < XFADE:
        pst, pdu, pfn, plocal = SCENES[idx - 1]
        prev = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        if plocal:
            pfn(prev, t, t - pst)
        else:
            pfn(prev, t)
        k = ein_out((t - st) / XFADE)
        cur = Image.fromarray(
            (np.asarray(prev, float) * (1 - k) + np.asarray(cur, float) * k).astype(np.uint8)
        )
    f.alpha_composite(cur)
    return f.convert("RGB")


def main():
    only = None
    if len(sys.argv) > 2 and sys.argv[1] == "--frames":
        only = (int(sys.argv[2]), int(sys.argv[3]))
    if len(sys.argv) > 1 and sys.argv[1] == "--stills":
        # 每 2 秒抽一张静帧，用于快速检查排版
        for i in range(0, int(DUR), 2):
            render_frame(i + 0.5).save(os.path.join(OUT, f"still_{i:02d}.png"))
            print("still", i)
        return

    ff = None
    proc = None
    if only is None:
        import imageio_ffmpeg

        ff = imageio_ffmpeg.get_ffmpeg_exe()
        cmd = [
            ff, "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
            "-i", "-", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "17",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            os.path.join(OUT, "video.mp4"),
        ]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    rng = range(NFRAMES) if only is None else range(only[0], min(only[1], NFRAMES))
    for i in rng:
        t = i / FPS
        frame = render_frame(t)
        if proc:
            proc.stdin.write(frame.tobytes())
        else:
            frame.save(os.path.join(OUT, f"f_{i:05d}.png"))
        if proc and i % 120 == 0:
            print(f"  {i}/{NFRAMES}  {t:5.1f}s", flush=True)

    if proc:
        proc.stdin.close()
        err = proc.stderr.read().decode("utf-8", "ignore")
        code = proc.wait()
        if code != 0:
            print("ffmpeg 失败:", err[-2000:])
            sys.exit(1)
        print("完成:", os.path.join(OUT, "video.mp4"))


if __name__ == "__main__":
    main()
