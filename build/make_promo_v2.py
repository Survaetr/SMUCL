# -*- coding: utf-8 -*-
"""
SMUCL 1.5.0 宣传片 —— 发布会风格（逐帧程序化渲染）
1920x1080 / 60fps / 47 秒

相比 v1：
  · 引入校徽吉祥物（圆形徽章），作为「主讲人」出现在开场、中点与收尾
  · 内容更新到 1.5.0：整合包商店、加载器安装、存档分组、显卡偏好
  · 节奏更慢、更克制：镜头缓推、字幕上浮，切点更少
"""
import os
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "build", "promo2")
os.makedirs(OUT, exist_ok=True)

W, H, FPS = 1920, 1080, 60
DUR = 47.0

LOGO = os.path.join(ROOT, "assets", "logo-mc.png")
WORDMARK = os.path.join(ROOT, "assets", "wordmark.png")
MASCOT = os.path.join(ROOT, "assets", "mascot-badge.png")
SHOTS = os.path.join(ROOT, "build", "promo2")

FONT_CN_B = "C:/Windows/Fonts/msyhbd.ttc"
FONT_CN = "C:/Windows/Fonts/msyh.ttc"
FONT_EN_B = "C:/Windows/Fonts/segoeuib.ttf"
FONT_EN = "C:/Windows/Fonts/segoeui.ttf"

BG_DEEP = np.array([4, 6, 10], float)
BG_GLOW = np.array([22, 46, 88], float)
ACCENT = (122, 168, 240)
ACCENT_2 = (168, 196, 245)
WHITE = (246, 249, 255)
GREY = (146, 158, 178)


# ---------------------------------------------------------------- 缓动
def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def ease_out_expo(x):
    x = clamp(x)
    return 1.0 if x >= 1 else 1 - 2 ** (-10 * x)


def ease_out_cubic(x):
    x = clamp(x)
    return 1 - (1 - x) ** 3


def ease_in_out(x):
    x = clamp(x)
    return 3 * x * x - 2 * x * x * x


def seg(t, t0, t1):
    if t1 <= t0:
        return 1.0 if t >= t1 else 0.0
    return clamp((t - t0) / (t1 - t0))


# ---------------------------------------------------------------- 背景
def build_background():
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    cx, cy = W * 0.5, H * 0.42
    dx = (x - cx) / (W * 0.68)
    dy = (y - cy) / (H * 0.86)
    d = np.sqrt(dx * dx + dy * dy)
    glow = np.clip(1.0 - d, 0, 1) ** 2.2

    img = np.zeros((H, W, 3), np.float32)
    img += BG_DEEP
    img += glow[..., None] * BG_GLOW

    vx = (x - W / 2) / (W / 2)
    vy = (y - H / 2) / (H / 2)
    vig = 1 - 0.55 * np.clip((vx * vx + vy * vy) * 0.52, 0, 1)
    img *= vig[..., None]
    return np.clip(img, 0, 255).astype(np.uint8)


BG = Image.fromarray(build_background(), "RGB")
_rng = np.random.default_rng(11)
GRAIN = (_rng.normal(0, 1.4, (H, W, 1))).repeat(3, axis=2).astype(np.float32)


# ---------------------------------------------------------------- 资源
def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius, fill=255)
    return m


def load_card(path, target_w, crop_bottom=None):
    src = Image.open(path).convert("RGB")
    if crop_bottom:
        src = src.crop((0, 0, src.width, min(crop_bottom, src.height)))
    ratio = target_w / src.width
    im = src.resize((target_w, int(src.height * ratio)), Image.LANCZOS)
    w, h = im.size
    radius = 20

    card = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    card.paste(im, (0, 0), rounded_mask((w, h), radius))
    bd = ImageDraw.Draw(card)
    bd.rounded_rectangle([0, 0, w - 1, h - 1], radius, outline=(255, 255, 255, 24), width=1)

    pad = 90
    sh = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    sh.paste(Image.new("RGBA", (w, h), (0, 0, 0, 200)), (pad, pad), rounded_mask((w, h), radius))
    sh = sh.filter(ImageFilter.GaussianBlur(38))
    return card, sh


CARDS = {}
# 统一用完整窗口：裁切会让画面看起来像截图被切断
CROPS = {}
for name, tw in [
    ("home", 1140),
    ("packs", 1140),
    ("loaders", 1140),
    ("saves", 1140),
    ("settings", 1140),
]:
    p = os.path.join(SHOTS, f"src_{name}.png")
    if os.path.exists(p):
        CARDS[name] = load_card(p, tw, CROPS.get(name))

LOGOTEX = Image.open(LOGO).convert("RGBA")
LOGO_BIG = LOGOTEX.resize((240, 240), Image.LANCZOS)
LOGO_SM = LOGOTEX.resize((112, 112), Image.LANCZOS)
WORDS = Image.open(WORDMARK).convert("RGBA")
WORDS = WORDS.resize((int(WORDS.width * (660 / WORDS.width)), int(WORDS.height * (660 / WORDS.width))), Image.LANCZOS)

_badge = Image.open(MASCOT).convert("RGBA")
BADGE_CACHE = {}


def badge(size):
    if size not in BADGE_CACHE:
        BADGE_CACHE[size] = _badge.resize((size, size), Image.LANCZOS)
    return BADGE_CACHE[size]


def badge_glow(size, color=(70, 130, 220), strength=0.55):
    key = ("glow", size)
    if key not in BADGE_CACHE:
        g = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        d = ImageDraw.Draw(g)
        d.ellipse([size * 0.04, size * 0.04, size * 0.96, size * 0.96],
                  fill=(color[0], color[1], color[2], int(255 * strength)))
        BADGE_CACHE[key] = g.filter(ImageFilter.GaussianBlur(size * 0.07))
    return BADGE_CACHE[key]


# ---------------------------------------------------------------- 文字
_font_cache = {}


def font(path, size):
    key = (path, size)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(path, size)
    return _font_cache[key]


def new_layer():
    return Image.new("RGBA", (W, H), (0, 0, 0, 0))


def draw_tracked(layer, s, f, center, fill, tracking=0, alpha=255):
    if alpha <= 0:
        return
    tmp = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(tmp)
    widths = [d.textlength(ch, font=f) for ch in s]
    total = sum(widths) + tracking * max(0, len(s) - 1)
    x = center[0] - total / 2
    for ch, w in zip(s, widths):
        d.text((x, center[1]), ch, font=f, fill=fill + (int(alpha),), anchor="lm")
        x += w + tracking
    layer.alpha_composite(tmp)


def draw_text(layer, s, f, center, fill, alpha=255, anchor="mm"):
    if alpha <= 0:
        return
    tmp = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(tmp).text(center, s, font=f, fill=fill + (int(alpha),), anchor=anchor)
    layer.alpha_composite(tmp)


def fit_text(layer, s, path, size, center, fill, alpha, max_w=1500, tracking=0):
    f = font(path, size)
    while size > 18:
        f = font(path, size)
        w = sum(ImageDraw.Draw(layer).textlength(c, font=f) for c in s) + tracking * (len(s) - 1)
        if w <= max_w:
            break
        size -= 2
    draw_tracked(layer, s, f, center, fill, tracking, alpha)


# ---------------------------------------------------------------- 镜头
def scene_open(frame, t, a):
    """片头：logo 收缩落位 + 版本号 + 徽章轻浮"""
    layer = new_layer()
    k = ease_out_expo(seg(t, 0.15, 1.25))
    size = int(230 * (0.86 + 0.14 * k))
    lg = LOGOTEX.resize((size, size), Image.LANCZOS)
    tmp = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    tmp.alpha_composite(lg, (W // 2 - size // 2, 300 - size // 2 + 90))
    tmp.putalpha(tmp.split()[3].point(lambda v: int(v * k * a)))
    layer.alpha_composite(tmp)

    a1 = seg(t, 0.75, 1.55) * a
    draw_tracked(layer, "SMUCL", font(FONT_EN_B, 104), (W // 2, 512 + int((1 - ease_out_cubic(seg(t, 0.75, 1.6))) * 14)),
                 WHITE, 30, a1 * 255)

    a2 = seg(t, 1.15, 1.95) * a
    draw_tracked(layer, "1.5.0", font(FONT_EN_B, 26), (W // 2, 596), ACCENT, 14, a2 * 235)

    draw_tracked(layer, "上海海事大学 · MINECRAFT 启动器", font(FONT_CN, 24), (W // 2, 668), GREY, 6,
                 seg(t, 1.5, 2.4) * a * 210)
    frame.alpha_composite(layer)


def scene_bigword(frame, t, a, word, sub=None):
    layer = new_layer()
    kin = ease_out_expo(seg(t, 0.05, 0.95))
    rise = int((1 - kin) * 26)
    fit_text(layer, word, FONT_CN_B, 118, (W // 2, 500 + rise), WHITE, kin * a * 255, 1480, 4)
    if sub:
        s = seg(t, 0.45, 1.25) * a
        draw_tracked(layer, sub, font(FONT_CN, 30), (W // 2, 596 + int((1 - ease_out_cubic(seg(t, 0.45, 1.3))) * 12)),
                     GREY, 4, s * 225)
    # 细线
    lw = ease_out_cubic(seg(t, 0.55, 1.5)) * 120
    if lw > 1:
        d = ImageDraw.Draw(layer)
        d.line([W // 2 - lw, 636, W // 2 + lw, 636], fill=ACCENT + (int(90 * a),), width=2)
    frame.alpha_composite(layer)


def scene_mascot(frame, t, a, title, sub):
    """吉祥物特写：慢速推近 + 光晕"""
    layer = new_layer()
    k = ease_out_cubic(seg(t, 0.1, 1.6))
    size = int(390 + 34 * k)
    cx, cy = W // 2, 396 + int(math.sin(t * 1.4) * 6)

    g = badge_glow(size, strength=0.5)
    gt = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gt.alpha_composite(g, (cx - size // 2, cy - size // 2))
    gt.putalpha(gt.split()[3].point(lambda v: int(v * a)))
    layer.alpha_composite(gt)

    b = badge(size)
    bt = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bt.alpha_composite(b, (cx - size // 2, cy - size // 2))
    bt.putalpha(bt.split()[3].point(lambda v: int(v * ease_out_expo(seg(t, 0.05, 0.8)) * a)))
    layer.alpha_composite(bt)

    a1 = seg(t, 0.7, 1.5) * a
    fit_text(layer, title, FONT_CN_B, 66, (W // 2, 700 + int((1 - ease_out_cubic(seg(t, 0.7, 1.6))) * 16)),
             WHITE, a1 * 255, 1300, 3)
    draw_tracked(layer, sub, font(FONT_CN, 27), (W // 2, 762), GREY, 3, seg(t, 1.0, 1.8) * a * 220)
    frame.alpha_composite(layer)


def scene_shot(frame, t, a, key, kicker, title, sub=None, zoom=1.055):
    """产品镜头：缓推 + 上浮入场"""
    if key not in CARDS:
        return
    card, shadow = CARDS[key]
    layer = new_layer()

    ka = seg(t, 0.10, 0.85) * a
    draw_tracked(layer, kicker, font(FONT_EN_B, 21), (W // 2, 118), ACCENT, 9, ka * 230)
    ta = seg(t, 0.16, 0.95) * a
    fit_text(layer, title, FONT_CN_B, 58, (W // 2, 176 + int((1 - ease_out_cubic(seg(t, 0.16, 1.0))) * 14)),
             WHITE, ta * 255, 1500, 2)
    if sub:
        draw_tracked(layer, sub, font(FONT_CN, 25), (W // 2, 226), GREY, 3, seg(t, 0.42, 1.15) * a * 215)

    # 缓推：整组按 zoom 轻微放大
    k = ease_in_out(seg(t, 0.0, 1.0))
    s = 1.0 + (zoom - 1.0) * k
    cw, ch = card.size
    nw, nh = int(cw * s), int(ch * s)
    ci = card.resize((nw, nh), Image.LANCZOS)
    shi = shadow.resize((int(shadow.width * s), int(shadow.height * s)), Image.LANCZOS)

    enter = ease_out_expo(seg(t, 0.0, 0.9))
    oy = int((1 - enter) * 40)
    x = int(W // 2 - nw // 2)
    # 在标题下方可用区域内垂直居中（矮卡片不会顶在上半屏）
    top, bottom = 268, H - 34
    y = int(top + max(0, (bottom - top - nh) // 2) + oy)

    st = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    st.alpha_composite(shi, (x - (shi.width - nw) // 2, y - (shi.height - nh) // 2))
    st.putalpha(st.split()[3].point(lambda v: int(v * enter * a)))
    layer.alpha_composite(st)

    ct = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ct.alpha_composite(ci, (x, y))
    ct.putalpha(ct.split()[3].point(lambda v: int(v * enter * a)))
    layer.alpha_composite(ct)

    frame.alpha_composite(layer)


def scene_update(frame, t, a):
    """动效卡：发现新版本 + 下载进度"""
    layer = new_layer()
    ka = seg(t, 0.10, 0.75) * a
    draw_tracked(layer, "UPDATES", font(FONT_EN_B, 21), (W // 2, 150), ACCENT, 9, ka * 230)
    draw_text(layer, "后台盯着新版本", font(FONT_CN_B, 58), (W // 2, 214), WHITE, ka * 255)
    draw_text(layer, "发现即提示 · 300 KB 增量更新", font(FONT_CN, 27), (W // 2, 264), GREY,
              seg(t, 0.32, 1.0) * a * 220)

    k = ease_out_expo(seg(t, 0.42, 1.2))
    cw, ch = 900, 180
    x = W // 2 - cw // 2
    y = 388 + int((1 - k) * 40)

    card = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    d = ImageDraw.Draw(card)
    d.rounded_rectangle([0, 0, cw - 1, ch - 1], 24, fill=(18, 24, 36, int(232 * k * a)))
    d.rounded_rectangle([0, 0, cw - 1, ch - 1], 24, outline=(255, 255, 255, int(28 * k * a)), width=1)
    card.alpha_composite(LOGOTEX.resize((68, 68), Image.LANCZOS), (42, ch // 2 - 34))

    p = ease_in_out(seg(t, 1.5, 3.4))
    pct = int(p * 100)
    d.text((136, 58), "发现新版本 v1.5.0", font=font(FONT_CN_B, 31),
           fill=(246, 249, 255, int(255 * k * a)), anchor="lm")
    sub = "正在下载…" if pct < 100 else "已完成，重启后生效"
    d.text((136, 100), sub, font=font(FONT_CN, 22), fill=(146, 158, 178, int(235 * k * a)), anchor="lm")
    d.text((cw - 42, 58), f"{pct}%", font=font(FONT_EN_B, 30),
           fill=(122, 168, 240, int(255 * k * a)), anchor="rm")

    bx0, bx1, by = 136, cw - 42, 134
    d.rounded_rectangle([bx0, by, bx1, by + 6], 3, fill=(255, 255, 255, int(24 * k * a)))
    if p > 0:
        wid = int((bx1 - bx0) * p)
        d.rounded_rectangle([bx0, by, bx0 + max(wid, 6), by + 6], 3, fill=(122, 168, 240, int(255 * k * a)))

    layer.alpha_composite(card, (x, y))
    frame.alpha_composite(layer)


def scene_end(frame, t, a):
    layer = new_layer()

    k = ease_out_expo(seg(t, 0.0, 0.9))
    size = 132
    b = badge(size)
    g = badge_glow(size, strength=0.45)
    gt = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gt.alpha_composite(g, (W // 2 - size // 2, 286 - size // 2 + int((1 - k) * 16)))
    gt.putalpha(gt.split()[3].point(lambda v: int(v * k * a)))
    layer.alpha_composite(gt)
    bt = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bt.alpha_composite(b, (W // 2 - size // 2, 286 - size // 2 + int((1 - k) * 16)))
    bt.putalpha(bt.split()[3].point(lambda v: int(v * k * a)))
    layer.alpha_composite(bt)

    a1 = seg(t, 0.35, 1.2) * a
    wm = WORDS.resize((int(WORDS.width * 0.72), int(WORDS.height * 0.72)), Image.LANCZOS)
    wt = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    wt.alpha_composite(wm, (W // 2 - wm.width // 2, 420))
    wt.putalpha(wt.split()[3].point(lambda v: int(v * a1)))
    layer.alpha_composite(wt)

    draw_tracked(layer, "github.com/Survaetr/SMUCL", font(FONT_EN, 34), (W // 2, 610), ACCENT, 2,
                 seg(t, 0.7, 1.45) * a * 235)
    draw_tracked(layer, "WINDOWS · 免费 · 开源", font(FONT_CN, 26), (W // 2, 680), GREY, 7,
                 seg(t, 1.0, 1.75) * a * 215)
    frame.alpha_composite(layer)


# ---------------------------------------------------------------- 时间线
TL = [
    # (fn, t0, t1, args)
    (scene_open, 0.0, 4.6, ()),
    (scene_bigword, 4.6, 8.8, ("不用搬家。", "直接接管你已有的游戏目录")),
    (scene_mascot, 8.8, 13.4, ("你好，新旅程。", "SMUCL 1.5.0 · 现在连模组也替你装好")),
    (scene_shot, 13.4, 19.8, ("packs", "MODPACKS", "两个来源，一次点击", "Modrinth 免配置 · CurseForge 填 Key 即可")),
    (scene_shot, 19.8, 25.4, ("loaders", "LOADERS", "加载器，自己装", "Fabric · Quilt · Forge · NeoForge")),
    (scene_shot, 25.4, 30.8, ("saves", "SAVES", "存档，按版本归位", "按文件夹 / 按版本 / 按时间")),
    (scene_shot, 30.8, 35.6, ("settings", "SETTINGS", "显卡、内存，一次设好", "双显卡笔记本不再误走核显")),
    (scene_update, 35.6, 40.6, ()),
    (scene_end, 40.6, DUR + 2, ()),
]


def render_frame(t):
    frame = BG.copy().convert("RGBA")
    for fn, t0, t1, args in TL:
        if t < t0 or t > t1:
            continue
        local = t - t0
        dur = t1 - t0
        a = 1.0
        # 统一：入场 0.5s 渐显，出场 0.45s 渐隐（收尾场景不淡出）
        if fn is not scene_end:
            a *= seg(local, 0.0, 0.5)
            if dur - local < 0.45:
                a *= seg(dur - local, 0.0, 0.45)
        fn(frame, local, a, *args)

    arr = np.asarray(frame.convert("RGB"), np.float32) + GRAIN
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "stills":
        for name, t in [
            ("01_open", 2.4),
            ("02_word", 6.2),
            ("03_mascot", 11.4),
            ("04_packs", 16.4),
            ("05_loaders", 22.4),
            ("06_saves", 28.0),
            ("07_settings", 33.2),
            ("08_update", 38.4),
            ("09_end", 44.0),
        ]:
            render_frame(t).save(os.path.join(OUT, f"still_{name}.png"))
            print("still", name)
    elif sys.argv[1] == "render":
        import subprocess
        import imageio_ffmpeg

        ff = imageio_ffmpeg.get_ffmpeg_exe()
        audio = os.path.join(OUT, "audio.wav")
        out = os.path.join(OUT, "SMUCL_1.5.0_1080p60.mp4")
        total = int(DUR * FPS)

        cmd = [ff, "-y", "-f", "rawvideo", "-vcodec", "rawvideo",
               "-s", f"{W}x{H}", "-pix_fmt", "rgb24", "-r", str(FPS), "-i", "-"]
        if os.path.exists(audio):
            cmd += ["-i", audio, "-c:a", "aac", "-b:a", "256k"]
        cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "17",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-shortest", out]

        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for i in range(total):
            proc.stdin.write(render_frame(i / FPS).tobytes())
            if i % 300 == 0:
                print(f"  {i}/{total}  {i / total * 100:.0f}%", flush=True)
        proc.stdin.close()
        proc.wait()
        print("完成:", out, round(os.path.getsize(out) / 1024 / 1024, 1), "MB")
    else:
        print("用法: python make_promo_v2.py stills|render")
