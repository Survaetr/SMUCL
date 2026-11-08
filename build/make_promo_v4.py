# -*- coding: utf-8 -*-
"""
SMUCL 2.0.1 宣传片 v4 —— 功能优先 / 卡点快剪

1920x1080 / 60fps / 60 秒 / 逐帧程序化渲染

设计依据（对标 B站《【Campfire】开源的 Minecraft 联机工具箱》BV1i7HV69E24，
72s / 18.3 万播放 / 3.9 万点赞，点赞率 21%）：
  · 开场 2 秒用「痛点 + 数字」建立情绪，不铺陈
  · 主体是功能密集轰炸，每个功能 2 小节（3.87s），切点踩 124BPM 的拍
  · 全程真实运行截图 + 鼠标指针与点击波纹，制造「实机操作」的手感
  · 配色段放在情绪高点，用左右对比 + 擦除，让观众「看见它变了」
  · 结尾只做一件事：告诉你去哪拿

吉祥物：东风谷海望（校徽萌化形象），开场 / 配色段 / 结尾三处出场。

渲染要点：
  · 全部素材来自 build/shots200（真实截图），不画假 UI
  · 位移只走整图裁剪与合成，不做逐像素模糊，保证 3600 帧跑得完
  · 字幕统一走底部渐变白带，任何截图上都清晰
"""
import os
import math
import subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "build", "shots200", "safe")   # 已脱敏（账号名与 UUID 已虚化）
MASCOT = os.path.join(ROOT, "build", "mascot")
OUT = os.path.join(ROOT, "build", "promo4")
os.makedirs(OUT, exist_ok=True)

W, H, FPS = 1920, 1080, 60

# ---- 124 BPM 网格：一拍 0.4839s，一小节 1.9355s，全片 31 小节 = 60.0s
BPM = 124
BEAT = 60.0 / BPM
BAR = BEAT * 4
DUR = BAR * 31
NFRAMES = int(round(DUR * FPS))

F_CN_B = "C:/Windows/Fonts/msyhbd.ttc"
F_CN = "C:/Windows/Fonts/msyh.ttc"
F_EN_B = "C:/Windows/Fonts/seguisb.ttf"
F_EN = "C:/Windows/Fonts/segoeui.ttf"

INK = (13, 27, 46)
INK2 = (78, 94, 120)
BLUE = (31, 86, 173)
BLUE_HI = (59, 124, 232)
GOLD = (181, 126, 24)
CORAL = (188, 74, 84)
DARK = (8, 16, 30)

_fc = {}


def font(path, size):
    k = (path, size)
    if k not in _fc:
        _fc[k] = ImageFont.truetype(path, size)
    return _fc[k]


# ---------------------------------------------------------------- 缓动
def clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def eout(x):
    x = clamp(x)
    return 1.0 if x >= 1 else 1 - 2 ** (-10 * x)


def eout_cubic(x):
    x = clamp(x)
    return 1 - (1 - x) ** 3


def ein_out(x):
    x = clamp(x)
    return 3 * x * x - 2 * x * x * x


def spring(x):
    """带回弹的过冲曲线，用于吉祥物与卡片的弹入"""
    x = clamp(x)
    if x >= 1:
        return 1.0
    return 1 - math.cos(x * math.pi * 1.5) * math.exp(-4.2 * x)


def seg(t, start, dur):
    if dur <= 0:
        return 1.0 if t >= start else 0.0
    return clamp((t - start) / dur)


# ---------------------------------------------------------------- 背景
def build_bg():
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    u, v = xx / (W - 1), yy / (H - 1)
    top = np.array([252, 253, 255], float)
    bot = np.array([233, 239, 249], float)
    t = (v ** 1.15)[..., None]
    img = top * (1 - t) + bot * t
    d = np.sqrt(((u - 0.86)) ** 2 + ((v + 0.10) * 1.35) ** 2)
    img += np.array([80, 140, 225], float) * np.exp(-(d ** 2) / 0.22)[..., None] * 0.10
    d2 = np.sqrt(((u - 0.06)) ** 2 + ((v - 1.05) * 1.3) ** 2)
    img += np.array([120, 150, 210], float) * np.exp(-(d2 ** 2) / 0.26)[..., None] * 0.07
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")


BG = build_bg()

# 顶部细网格（工程感），边缘径向淡出
_grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
_g = ImageDraw.Draw(_grid)
for x in range(0, W, 96):
    _g.line([(x, 0), (x, H)], fill=(31, 86, 173, 8), width=1)
for y in range(0, H, 96):
    _g.line([(0, y), (W, y)], fill=(31, 86, 173, 8), width=1)
_yy, _xx = np.mgrid[0:H, 0:W].astype(np.float32)
_rr = np.sqrt(((_xx / W - 0.5)) ** 2 + ((_yy / H - 0.25) * 1.4) ** 2)
_ga = np.clip(1 - _rr / 0.62, 0, 1) ** 1.4
_grid.putalpha(ImageChops.multiply(_grid.getchannel("A"), Image.fromarray((_ga * 255).astype(np.uint8), "L")))

# 底部渐变白带：让字幕在任何截图上都清晰（缓存一次）
# 曲线必须「上段快饱和」——字幕区（约占带高一半处）要不透明度 ≥0.95，
# 早期用 t**2.1 在那里只有 0.22，字压在界面上会发花
BAND_H = 300
_band = Image.new("RGBA", (W, BAND_H), (255, 255, 255, 0))
_t = np.linspace(0, 1, BAND_H)
_ba = (np.clip(1 - np.exp(-((_t * 5.5) ** 1.3)), 0, 1) * 255).astype(np.uint8)
_ba[_t > 0.60] = 255   # 字幕所在的下一半必须完全不透明，否则卡片文字会透上来
_band.putalpha(Image.fromarray(np.repeat(_ba[:, None], W, axis=1), "L"))


# ---------------------------------------------------------------- 文字
_tc = {}


def text_layer(text, fontpath, size, color, tracking=0.0):
    key = (text, fontpath, size, color, tracking)
    if key in _tc:
        return _tc[key]
    f = font(fontpath, size)
    widths = []
    for ch in text:
        bb = f.getbbox(ch)
        widths.append(bb[2] if bb else size * 0.5)
    total = int(sum(widths) + tracking * max(0, len(text) - 1))
    asc, desc = f.getmetrics()
    img = Image.new("RGBA", (max(1, total), asc + desc), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x = 0
    for ch, w in zip(text, widths):
        d.text((x, 0), ch, font=f, fill=color + (255,))
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


def measure(text, fontpath, size, tracking=0.0):
    return text_layer(text, fontpath, size, (0, 0, 0), tracking).width


def text_shadow(dst, text, x, y, fontpath, size, color, alpha=1.0, anchor="center", blur=14):
    """给压在截图上的字加一层柔影，保证可读"""
    layer = text_layer(text, fontpath, size, color)
    if anchor == "center":
        x -= layer.width / 2
    elif anchor == "right":
        x -= layer.width
    sh = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    sh.paste((10, 22, 44, 120), (0, 0), layer)
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    paste(dst, sh, x, y + 6, alpha)
    paste(dst, layer, x, y, alpha)


# ---------------------------------------------------------------- 截图取景
_kb = {}


class Shot:
    """把截图缩到刚好吃满 1920×1080，再按 (中心, 缩放) 取景"""

    def __init__(self, name):
        path = os.path.join(SHOTS, name if name.endswith(".png") else name + ".png")
        src = Image.open(path).convert("RGB")
        sw, sh = src.size
        s = max(W / sw, H / sh)
        self.img = src.resize((int(sw * s + 0.5), int(sh * s + 0.5)), Image.LANCZOS)
        self.iw, self.ih = self.img.size

    def frame(self, zoom=1.0, cx=0.5, cy=0.5):
        cw = int(min(self.iw, W / max(1.0, zoom)))
        ch = int(min(self.ih, H / max(1.0, zoom)))
        left = int(clamp(cx * self.iw - cw / 2, 0, self.iw - cw))
        top = int(clamp(cy * self.ih - ch / 2, 0, self.ih - ch))
        return self.img.crop((left, top, left + cw, top + ch)).resize((W, H), Image.LANCZOS)

    def map_to_screen(self, px, py, zoom=1.0, cx=0.5, cy=0.5):
        """把截图里的相对坐标(0..1)映射到当前取景后的屏幕坐标"""
        cw = min(self.iw, W / max(1.0, zoom))
        ch = min(self.ih, H / max(1.0, zoom))
        left = clamp(cx * self.iw - cw / 2, 0, self.iw - cw)
        top = clamp(cy * self.ih - ch / 2, 0, self.ih - ch)
        return (px * self.iw - left) / cw * W, (py * self.ih - top) / ch * H


def shot(name):
    if name not in _kb:
        _kb[name] = Shot(name)
    return _kb[name]


# ---------------------------------------------------------------- 鼠标与点击
def _build_pointer(scale=1.0):
    s = int(46 * scale)
    img = Image.new("RGBA", (s + 24, s + 30), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = s / 46.0
    pts = [(0, 0), (0, 34 * k), (9 * k, 26 * k), (15 * k, 42 * k), (22 * k, 39 * k), (16 * k, 23 * k), (28 * k, 22 * k)]
    pts = [(x + 10, y + 8) for x, y in pts]
    # 阴影
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).polygon([(x + 2, y + 3) for x, y in pts], fill=(8, 18, 34, 110))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(3)))
    d.polygon(pts, fill=(255, 255, 255, 255), outline=(26, 38, 58, 255), width=max(1, int(2 * k)))
    return img


_pc = {}


def pointer(scale=1.0):
    key = round(scale, 2)
    if key not in _pc:
        _pc[key] = _build_pointer(scale)
    return _pc[key]


def draw_pointer(dst, x, y, alpha=1.0, scale=1.0):
    img = pointer(scale)
    paste(dst, img, x - 10 * scale, y - 8 * scale, alpha)


def click_ripple(dst, x, y, p, alpha=1.0, color=BLUE_HI):
    """点击波纹：两圈向外扩散，越来越淡"""
    if p <= 0 or p >= 1:
        return
    for i, delay in enumerate((0.0, 0.22)):
        q = clamp((p - delay) / (1 - delay))
        if q <= 0 or q >= 1:
            continue
        r = 14 + 92 * eout_cubic(q)
        a = (1 - q) ** 1.8 * 0.62 * alpha
        size = int(r * 2 + 8)
        lay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(lay).ellipse(
            (size / 2 - r, size / 2 - r, size / 2 + r, size / 2 + r),
            outline=color + (int(255 * a),), width=max(2, int(4 * (1 - q) + 1)),
        )
        paste(dst, lay, x - size / 2, y - size / 2, 1.0)


def cursor_path(t, t0, t1, p0, p1, click_at=None, ease=True):
    """鼠标从 p0 移到 p1；返回 (x, y, click_progress)"""
    p = seg(t, t0, max(0.001, t1 - t0))
    e = ein_out(p) if ease else p
    x = p0[0] + (p1[0] - p0[0]) * e
    y = p0[1] + (p1[1] - p0[1]) * e
    cp = 0.0
    if click_at is not None:
        cp = seg(t, click_at, 0.55)
    return x, y, cp


# ---------------------------------------------------------------- 吉祥物
_ms = {}


def mascot(size):
    if size not in _ms:
        img = Image.open(os.path.join(MASCOT, "mascot_badge_1024.png")).convert("RGBA")
        _ms[size] = img.resize((size, size), Image.LANCZOS)
    return _ms[size]


def draw_mascot(dst, cx, cy, size, alpha=1.0, rot=0.0, shadow=True):
    img = mascot(size)
    if rot:
        img = img.rotate(rot, resample=Image.BICUBIC, expand=True)
    if shadow:
        pad = int(size * 0.22)
        lay = Image.new("RGBA", (img.width + pad * 2, img.height + pad * 2), (0, 0, 0, 0))
        sil = Image.new("RGBA", lay.size, (0, 0, 0, 0))
        sil.paste((16, 30, 54, 110), (pad, pad + int(size * 0.05)), img.getchannel("A"))
        lay.alpha_composite(sil.filter(ImageFilter.GaussianBlur(int(size * 0.09))))
        lay.alpha_composite(img, (pad, pad))
        paste(dst, lay, cx - lay.width / 2, cy - lay.height / 2, alpha)
    else:
        paste(dst, img, cx - img.width / 2, cy - img.height / 2, alpha)


# ---------------------------------------------------------------- 字幕
def caption(dst, main, sub=None, alpha=1.0, rise=0.0, accent=None):
    """底部字幕：底部渐变白带 + 主字幕 + 可选副字幕 + 品牌色短线"""
    if alpha <= 0.004:
        return
    paste(dst, _band, 0, H - BAND_H, alpha)
    yb = H - 148 + rise
    mw = measure(main, F_CN_B, 54)
    draw_text(dst, main, W / 2, yb, F_CN_B, 54, INK, alpha=alpha, anchor="center")
    if accent:
        a = accent
        lw = int(min(120, mw * 0.28))
        bar = Image.new("RGBA", (lw, 6), a + (int(255 * alpha),))
        paste(dst, bar, W / 2 - lw / 2, yb + 70, 1.0)
    if sub:
        draw_text(dst, sub, W / 2, yb + 92, F_CN, 27, INK2, alpha=alpha * 0.95, anchor="center")


def kicker(dst, text, x, y, alpha, color=BLUE, size=26, anchor="left"):
    draw_text(dst, text, x, y, F_CN_B, size, color, tracking=0.5, alpha=alpha, anchor=anchor)


def chip(dst, text, x, y, alpha=1.0, color=BLUE, pad=(18, 9), size=25):
    """标签胶囊"""
    w = measure(text, F_CN_B, size)
    h = size + pad[1] * 2
    lay = Image.new("RGBA", (int(w + pad[0] * 2 + 4), int(h + 4)), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    d.rounded_rectangle(
        (2, 2, lay.width - 3, lay.height - 3), radius=lay.height // 2,
        fill=color + (int(38 * alpha),), outline=color + (int(120 * alpha),), width=2,
    )
    paste(dst, lay, x, y, 1.0)
    draw_text(dst, text, x + pad[0] + 2, y + pad[1] + 2, F_CN_B, size, color, alpha=alpha)
    return lay.width


# ---------------------------------------------------------------- 场景 0：开场
WORDS = [
    (0.00, "6 个实例"),
    (0.50, "601 个模组"),
    (1.00, "11 个存档"),
    (1.50, "4.3 GB 数据"),
]


def s0_open(dst, t, lt):
    """黑底数字快闪（每个词 0.5s，同一位置只留当前词）→ 一句反问 → 答案"""
    dark = Image.new("RGB", (W, H), DARK)
    paste(dark, _grid, 0, 0, 0.32)

    # ---- 0.00-2.00s：四个词依次登场，各自独占自己的位置，绝不叠字
    if lt < 2.02:
        idx = min(len(WORDS) - 1, int(lt / 0.5))
        st, txt = WORDS[idx]
        p = seg(lt, st, 0.15)
        out = seg(lt, st + 0.42, 0.14) if idx < len(WORDS) - 1 else 0.0
        a = eout(p) * (1 - eout(out))
        rise = (1 - eout_cubic(p)) * 34
        # 上方的引导小字
        draw_text(dark, "已识别到", W / 2, 360, F_CN, 30, (120, 140, 170),
                  tracking=2.0, alpha=eout(seg(lt, 0.02, 0.3)) * 0.9, anchor="center")
        draw_text(dark, txt, W / 2, 424 + rise, F_CN_B, 96, (255, 255, 255), alpha=a, anchor="center")
        # 底部进度点
        for i in range(len(WORDS)):
            on = i <= idx
            c = (255, 255, 255) if on else (60, 76, 100)
            r = 5 if i != idx else 7
            lay = Image.new("RGBA", (r * 2, r * 2), (0, 0, 0, 0))
            ImageDraw.Draw(lay).ellipse((0, 0, r * 2 - 1, r * 2 - 1), fill=c + (255,))
            paste(dark, lay, W / 2 + (i - 1.5) * 30 - r, 620, 0.9)

    # ---- 2.02s：反问（答案出现时淡出，避免叠字）
    p = seg(lt, 2.02, 0.42)
    if p > 0:
        out = seg(lt, 2.84, 0.26)
        draw_text(dark, "换启动器，最烦的是什么？", W / 2, 470, F_CN_B, 58,
                  (222, 231, 244), alpha=eout(p) * (1 - eout(out)), anchor="center")

    # ---- 2.86s：答案
    p = seg(lt, 2.86, 0.40)
    if p > 0:
        s = spring(p)
        draw_text(dark, "不用搬家。", W / 2, 452, F_CN_B, int(96 * (0.9 + 0.1 * s)),
                  (255, 255, 255), alpha=eout(seg(lt, 2.86, 0.22)), anchor="center")
        lw = int(380 * eout_cubic(seg(lt, 3.00, 0.52)))
        if lw > 2:
            bar = Image.new("RGBA", (lw, 8), BLUE_HI + (255,))
            paste(dark, bar, W / 2 - lw / 2, 566, 1.0)

    dst.paste(dark, (0, 0))


# ---------------------------------------------------------------- 场景 1：品牌
def s1_brand(dst, t, lt):
    dst.paste(BG, (0, 0))
    paste(dst, _grid, 0, 0, 0.9)

    # 吉祥物弹入
    p = seg(lt, 0.05, 0.75)
    if p > 0:
        s = spring(p)
        size = int(300 * (0.72 + 0.28 * s))
        cy = 430 - (1 - s) * 60
        draw_mascot(dst, W / 2, cy, size, alpha=eout(seg(lt, 0.05, 0.35)), rot=(1 - s) * -8)

    # 字标
    p = seg(lt, 0.30, 0.55)
    if p > 0:
        a = eout(p)
        y = 640 + (1 - eout_cubic(p)) * 34
        w1 = draw_text(dst, "SMUCL", W / 2, y, F_EN_B, 118, INK, tracking=6, alpha=a, anchor="center")
        # 2.0.1 小胶囊
        chip(dst, "2.0.1", W / 2 + w1 / 2 + 26, y + 44, alpha=a, color=BLUE, size=28)

    p = seg(lt, 0.55, 0.5)
    if p > 0:
        draw_text(dst, "上海海事大学 · Minecraft 启动器", W / 2, 800, F_CN, 36, INK2,
                  tracking=1.0, alpha=eout(p), anchor="center")

    # 三个卖点依次出现
    p = seg(lt, 0.95, 0.4)
    if p > 0:
        txt = "免安装 · MIT 开源 · 142 MB"
        draw_text(dst, txt, W / 2, 872, F_CN_B, 30, BLUE, tracking=1.2,
                  alpha=eout(p), anchor="center")

    # 从上一镜的黑底「裂开」进入浅色：两片暗色向两侧退出，露出品牌页
    p = seg(lt, 0.0, 0.46)
    if p < 1:
        e = ein_out(p)
        lw = int(W // 2 - W * e / 2)
        if lw > 0:
            dst.paste(Image.new("RGB", (lw, H), DARK), (0, 0))
            dst.paste(Image.new("RGB", (lw, H), DARK), (W - lw, 0))
            edge = Image.new("RGBA", (5, H), BLUE_HI + (225,))
            paste(dst, edge, lw - 2, 0, 1.0)
            paste(dst, edge, W - lw - 3, 0, 1.0)


# ---------------------------------------------------------------- 场景 2：功能快闪
# 每个功能：截图名、字幕、副字幕、鼠标路径（相对截图坐标）、特写中心与倍率
FEATURES = [
    dict(
        name="home", title="打开就认出你的实例", sub="顺着快捷方式找到 .minecraft，实例与存档原样列出来",
        focus=(0.30, 0.52, 1.30),
        mouse=((0.62, 0.86), (0.255, 0.545), 1.55),
    ),
    dict(
        name="versions", title="一个列表管所有加载器", sub="Forge、NeoForge、Fabric、Quilt 全部并排，各自隔离",
        focus=(0.52, 0.42, 1.34),
        mouse=((0.10, 0.90), (0.845, 0.360), 1.45),
    ),
    dict(
        name="download", title="新版本一键装好", sub="原版清单拉到最新，点一下就开始下载",
        focus=(0.62, 0.50, 1.28),
        mouse=((0.30, 0.92), (0.700, 0.418), 1.50),
    ),
    dict(
        name="packs", title="整合包，依赖自动补齐", sub="Modrinth 与 CurseForge 都能搜，原版和加载器一起装上",
        focus=(0.50, 0.44, 1.26),
        mouse=((0.72, 0.95), (0.500, 0.330), 1.60),
    ),
    dict(
        name="content", title="模组、光影、材质包", sub="装到哪个实例、哪个游戏版本，都在这一屏选",
        focus=(0.50, 0.46, 1.26),
        mouse=((0.30, 0.95), (0.500, 0.400), 1.55),
    ),
    dict(
        name="saves", title="11 个存档，一眼看清", sub="读 level.dat：世界名、版本、模式、最后游玩时间",
        focus=(0.34, 0.50, 1.32),
        mouse=((0.75, 0.90), (0.196, 0.470), 1.50),
    ),
    dict(
        name="accent", title="界面跟着壁纸变", sub=None, focus=None, mouse=None,
    ),
    dict(
        name="settings", title="Java 与内存，都替你算好", sub="按版本挑合适的 Java，内存给到物理内存的一半以内",
        focus=(0.30, 0.50, 1.30),
        mouse=((0.70, 0.88), (0.286, 0.520), 1.45),
    ),
]

FEAT_START = BAR * 4          # 7.742s
FEAT_DUR = BAR * 2            # 3.871s


def feat_slide(dst, f, lt):
    """普通功能页：全景缓推 → 特写，鼠标移动并点击"""
    name = f["name"]
    T = FEAT_DUR

    # 镜头：0-2.15s 全景缓推，2.15-3.10 推到特写，之后停住微收
    if lt < 2.15:
        z = 1.04 + 0.05 * eout_cubic(lt / 2.15)
        cx, cy = 0.5, 0.5
    else:
        p = eout_cubic(seg(lt, 2.15, 0.95))
        z = 1.09 + (f["focus"][2] - 1.09) * p
        cx = 0.5 + (f["focus"][0] - 0.5) * p
        cy = 0.5 + (f["focus"][1] - 0.5) * p

    sh = shot(name)
    frame = sh.frame(z, cx, cy)

    # 入场：极短横向推入（裁掉左侧留出背景，避免 offset 的环绕伪影）
    p_in = seg(lt, 0.0, 0.22)
    if p_in < 1:
        off = int(W * 0.055 * (1 - eout_cubic(p_in)))
        dst.paste(BG, (0, 0))
        if off > 0:
            dst.paste(frame.crop((0, 0, W - off, H)), (off, 0))
        else:
            dst.paste(frame, (0, 0))
    else:
        dst.paste(frame, (0, 0))

    # 鼠标：只在第一个镜头里出现
    if lt < 2.35 and f["mouse"]:
        p0, p1, click_at = f["mouse"]
        x0, y0 = sh.map_to_screen(p0[0], p0[1], 1.04, 0.5, 0.5)
        x1, y1 = sh.map_to_screen(p1[0], p1[1], 1.04, 0.5, 0.5)
        mx, my, cp = cursor_path(lt, 0.12, 1.30, (x0, y0), (x1, y1), click_at=1.45)
        pa = eout(seg(lt, 0.10, 0.25)) * (1 - eout(seg(lt, 2.15, 0.30)))
        if pa > 0.01:
            click_ripple(dst, mx, my, cp, alpha=pa)
            draw_pointer(dst, mx, my, pa)
            # 点击瞬间指针轻微下压
            if 1.45 <= lt <= 1.60:
                pass

    # 字幕
    cp = seg(lt, 0.14, 0.42)
    ca = eout(cp)
    rise = (1 - eout_cubic(cp)) * 26
    caption(dst, f["title"], f["sub"], alpha=ca, rise=rise, accent=BLUE)


def feat_accent(dst, t, lt):
    """配色段：左蓝右珊瑚，中间擦除分割，吉祥物在两侧各出现一次"""
    T = FEAT_DUR
    a_img = shot("accent-a")
    b_img = shot("accent-b")

    z = 1.02 + 0.04 * eout_cubic(lt / T)
    fa = a_img.frame(z, 0.5, 0.5)
    fb = b_img.frame(z, 0.5, 0.5)

    dst.paste(fa, (0, 0))

    # 0.35s 起：白色分割线从右往左扫，右侧露出珊瑚版
    sp = ein_out(seg(lt, 0.35, 0.85))
    split = int(W * (1 - sp))
    if split < W:
        dst.paste(fb.crop((split, 0, W, H)), (split, 0))
        if 0 < split < W:
            edge = Image.new("RGBA", (5, H), (255, 255, 255, 235))
            paste(dst, edge, split - 2, 0, 1.0)

    # 角标：左「固定校徽蓝」右「跟随壁纸」
    if sp > 0.55:
        la = eout(seg(lt, 0.95, 0.35))
        chip(dst, "固定校徽蓝", 64, 60, alpha=la * 0.96, color=BLUE, size=25)
        chip(dst, "跟随壁纸取色", W - 64 - 214, 60, alpha=la * 0.96, color=CORAL, size=25)

    # 吉祥物：右侧弹出，像在「换装」
    p = seg(lt, 1.25, 0.6)
    if p > 0:
        s = spring(p)
        size = int(150 * (0.7 + 0.3 * s))
        draw_mascot(dst, W - 150, H - 250, size, alpha=eout(seg(lt, 1.25, 0.3)))

    cp = seg(lt, 0.10, 0.42)
    caption(
        dst,
        "背景换一张，整个界面跟着换",
        "从壁纸里取主色，按钮、选中态、光晕一起变；图发灰就退回校徽蓝",
        alpha=eout(cp), rise=(1 - eout_cubic(cp)) * 26, accent=CORAL,
    )


# ---------------------------------------------------------------- 场景 3：连续操作
FLOW = [
    ("home", "点一下，启动"),
    ("versions", "多开也不打架"),
    ("saves", "存档就在旁边"),
    ("download", "缺什么补什么"),
]
FLOW_START = FEAT_START + FEAT_DUR * len(FEATURES)   # 38.71s
FLOW_SLOT = BAR                                       # 每个 1.935s


def s3_flow(dst, t, lt):
    idx = min(len(FLOW) - 1, int(lt / FLOW_SLOT))
    name, label = FLOW[idx]
    sub_t = lt - idx * FLOW_SLOT

    sh = shot(name)
    z = 1.10 - 0.03 * eout_cubic(sub_t / FLOW_SLOT)
    frame = sh.frame(z, 0.48, 0.48)

    # 硬切 + 极短的白闪，模仿实机切页
    dst.paste(frame, (0, 0))
    fl = seg(sub_t, 0.0, 0.12)
    if fl < 1:
        wht = Image.new("RGBA", (W, H), (255, 255, 255, int(90 * (1 - fl))))
        paste(dst, wht, 0, 0, 1.0)

    # 鼠标点击
    mx, my = W * 0.5, H * 0.56
    draw_pointer(dst, mx + 40 * (1 - eout(seg(sub_t, 0.02, 0.3))), my, 0.95)
    click_ripple(dst, mx, my, seg(sub_t, 0.05, 0.5), alpha=0.9)

    # 短字幕，从左下角快速弹出
    p = eout(seg(sub_t, 0.06, 0.22))
    if p > 0:
        paste(dst, _band, 0, H - BAND_H, p * 0.92)
        draw_text(dst, label, 96, H - 150 + (1 - p) * 18, F_CN_B, 52, INK, alpha=p)
        bar = Image.new("RGBA", (int(76 * eout_cubic(seg(sub_t, 0.10, 0.3))), 6), BLUE + (255,))
        paste(dst, bar, 96, H - 86, 1.0)


# ---------------------------------------------------------------- 场景 4：数据
STATS = [
    ("142", "MB", "免安装包"),
    ("4", "类", "加载器支持"),
    ("11", "个", "存档直接读"),
    ("MIT", "", "永久开源"),
]
STATS_START = FLOW_START + FLOW_SLOT * len(FLOW)      # 46.45s
STATS_DUR = BAR * 3                                   # 5.806s


def s4_stats(dst, t, lt):
    dst.paste(BG, (0, 0))
    paste(dst, _grid, 0, 0, 0.8)

    draw_text(dst, "它已经能用了", W / 2, 150, F_CN_B, 44, INK,
              alpha=eout(seg(lt, 0.02, 0.3)), anchor="center")

    n = len(STATS)
    gap = W / (n + 1)
    for i, (num, unit, label) in enumerate(STATS):
        st = 0.28 + i * BEAT * 0.75
        p = seg(lt, st, 0.45)
        if p <= 0:
            continue
        a = eout(p)
        s = spring(p)
        cx = gap * (i + 1)
        base = 560 - (1 - s) * 30

        # 数字滚动：从 0 数到目标；非数字（MIT）直接原样出现
        if num.isdigit():
            val = int(round(float(num) * eout_cubic(seg(lt, st, 0.75))))
            shown = str(val)
            nsize = 128
        else:
            shown = num
            nsize = 96
        draw_text(dst, shown, cx, base if num.isdigit() else base + 26, F_EN_B, nsize, INK, alpha=a, anchor="center")
        nw = measure(shown, F_EN_B, nsize)
        if unit:
            draw_text(dst, unit, cx + nw / 2 + 8, (base if num.isdigit() else base + 26) + 62, F_CN, 34, BLUE, alpha=a, anchor="left")

        # 分隔线
        if i < n - 1:
            ln = Image.new("RGBA", (2, int(120 * a)), (31, 86, 173, int(48 * a)))
            paste(dst, ln, gap * (i + 1) + gap / 2, base + 6, 1.0)

        draw_text(dst, label, cx, base + 150, F_CN, 30, INK2, alpha=a, anchor="center")

    draw_text(dst, "Windows 10/11 · 免安装 · 解压双击就用", W / 2, 880, F_CN, 30, INK2,
              alpha=eout(seg(lt, 1.6, 0.4)), anchor="center")


# ---------------------------------------------------------------- 场景 5：结尾
END_START = STATS_START + STATS_DUR                   # 52.26s
END_DUR = BAR * 4                                     # 7.742s -> 60.0s


def s5_end(dst, t, lt):
    dst.paste(BG, (0, 0))
    paste(dst, _grid, 0, 0, 0.85)

    # 吉祥物呼吸
    p = seg(lt, 0.02, 0.7)
    s = spring(p)
    size = int(250 * (0.78 + 0.22 * s))
    breathe = 1 + 0.012 * math.sin(lt * 2.6)
    draw_mascot(dst, W / 2, 330, int(size * breathe), alpha=eout(seg(lt, 0.02, 0.3)))

    p = seg(lt, 0.22, 0.5)
    if p > 0:
        a = eout(p)
        y = 560 + (1 - eout_cubic(p)) * 26
        draw_text(dst, "SMUCL", W / 2, y, F_EN_B, 104, INK, tracking=5, alpha=a, anchor="center")

    p = seg(lt, 0.40, 0.5)
    if p > 0:
        draw_text(dst, "上海海事大学 Minecraft 启动器", W / 2, 700, F_CN, 32, INK2,
                  tracking=1.0, alpha=eout(p), anchor="center")

    # 地址条
    p = seg(lt, 0.70, 0.5)
    if p > 0:
        a = eout(p)
        txt = "github.com/Survaetr/SMUCL"
        tw = measure(txt, F_EN_B, 40)
        bx, by = W / 2 - tw / 2 - 34, 782
        lay = Image.new("RGBA", (int(tw + 68), 76), (0, 0, 0, 0))
        d = ImageDraw.Draw(lay)
        d.rounded_rectangle((0, 0, lay.width - 1, lay.height - 1), radius=38,
                            fill=(255, 255, 255, 214), outline=(31, 86, 173, 60), width=2)
        paste(dst, lay, bx, by, a)
        draw_text(dst, txt, W / 2, by + 18, F_EN_B, 40, BLUE, alpha=a, anchor="center")

    p = seg(lt, 1.10, 0.5)
    if p > 0:
        draw_text(dst, "开源 · 想加什么功能，issue 里说", W / 2, 890, F_CN, 28, INK2,
                  alpha=eout(p), anchor="center")

    # 最后 2 秒：整体轻轻压暗收尾，避免戛然而止
    if lt > END_DUR - 1.2:
        k = seg(lt, END_DUR - 1.2, 1.2)
        fade = Image.new("RGBA", (W, H), (250, 251, 253, int(255 * k * 0.35)))
        paste(dst, fade, 0, 0, 1.0)


# ---------------------------------------------------------------- 调度
SCENES = [
    (0.0, BAR * 2, s0_open),
    (BAR * 2, BAR * 2, s1_brand),
    (FEAT_START, FEAT_DUR * len(FEATURES), None),   # 功能段特殊处理
    (FLOW_START, FLOW_SLOT * len(FLOW), s3_flow),
    (STATS_START, STATS_DUR, s4_stats),
    (END_START, END_DUR, s5_end),
]


def render_frame(t):
    frame = Image.new("RGB", (W, H), (255, 255, 255))

    if t < FEAT_START:
        for start, dur, fn in SCENES[:2]:
            if start <= t < start + dur:
                fn(frame, t, t - start)
                return frame
        return frame

    if t < FLOW_START:
        lt = t - FEAT_START
        idx = min(len(FEATURES) - 1, int(lt / FEAT_DUR))
        f = FEATURES[idx]
        sub = lt - idx * FEAT_DUR
        if f["name"] == "accent":
            feat_accent(frame, t, sub)
        else:
            feat_slide(frame, f, sub)
        return frame

    for start, dur, fn in SCENES[3:]:
        if fn and start <= t < start + dur:
            fn(frame, t, t - start)
            return frame
    return frame


def main():
    print(f"渲染 {NFRAMES} 帧 / {DUR:.1f}s / {BPM}BPM")
    import imageio_ffmpeg
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    video = os.path.join(OUT, "video.mp4")
    cmd = [
        ff, "-y", "-f", "rawvideo", "-vcodec", "rawvideo",
        "-s", f"{W}x{H}", "-pix_fmt", "rgb24", "-r", str(FPS), "-i", "-",
        "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "17",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", video,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for i in range(NFRAMES):
        t = i / FPS
        proc.stdin.write(render_frame(t).tobytes())
        if i % 300 == 0:
            print(f"  {i}/{NFRAMES}  {t:.1f}s")
    proc.stdin.close()
    proc.wait()
    print("完成:", video)


if __name__ == "__main__":
    main()
