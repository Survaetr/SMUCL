# -*- coding: utf-8 -*-
"""
SMUCL 2.0.1 宣传片 v4 配乐 —— 124 BPM / 60 秒 / 48000Hz

设计：
  · 124 BPM 与画面切点严格对齐（一拍 0.4839s，一小节 1.9355s，全片 31 小节）
  · 编曲分层推进：0-4 小节只有 pad 与稀疏点，4 小节起进鼓，8 小节起进贝斯与琶音
  · 每个功能切换点（每 2 小节）加一个 riser，让画面切点听起来「有落点」
  · 收尾 2 小节抽掉鼓组，只留 pad 与一个长音，避免戛然而止
"""
import os
import wave
import numpy as np

SR = 48000
BPM = 124
BEAT = 60.0 / BPM
BAR = BEAT * 4
BARS = 31
DUR = BAR * BARS
N = int(round(DUR * SR))

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build", "promo4")
os.makedirs(OUT, exist_ok=True)

rng = np.random.default_rng(20261103)

# 和弦（半音相对 A2 的 MIDI 音高）：Am - F - C - G，四小节一循环
PROG = [
    [57, 60, 64],   # Am
    [53, 57, 60],   # F
    [48, 52, 55],   # C
    [55, 59, 62],   # G
]


def midi_hz(m):
    return 440.0 * 2 ** ((m - 69) / 12.0)


def env_ad(n, a, d, curve=2.2):
    a = max(1, int(a * SR))
    e = np.ones(n)
    e[:a] = np.linspace(0, 1, a) ** 0.8
    k = max(0, n - a)
    e[a:] = np.exp(-np.linspace(0, curve * 3.2, k))
    return e


def place(buf, sig, t, gain=1.0):
    i = int(round(t * SR))
    if i >= len(buf):
        return
    j = min(len(buf), i + len(sig))
    buf[i:j] += sig[: j - i] * gain


# ---------------------------------------------------------------- 音色
def kick(dur=0.30):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = 138 * np.exp(-t * 34) + 47
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t * 9.5)
    click = rng.normal(0, 1, n) * np.exp(-t * 190) * 0.28
    return np.tanh((body + click) * 1.9) * 0.92


def snare(dur=0.24):
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = rng.normal(0, 1, n)
    # 粗糙的高通：一阶差分
    noise = np.diff(np.concatenate([[0], noise]))
    tone = np.sin(2 * np.pi * 186 * t) * np.exp(-t * 24) * 0.5
    return (noise * np.exp(-t * 17) * 0.5 + tone) * 0.62


def hihat(dur=0.055, open_=False):
    d = 0.16 if open_ else dur
    n = int(d * SR)
    t = np.arange(n) / SR
    noise = np.diff(np.concatenate([[0], rng.normal(0, 1, n)]))
    return noise * np.exp(-t * (26 if open_ else 92)) * 0.30


def bass_note(freq, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    saw = 2 * (t * freq % 1.0) - 1
    # 简易低通：与自身延时做滑动平均近似
    k = max(1, int(SR / freq / 6))
    saw = np.convolve(saw, np.ones(k) / k, mode="same")
    e = np.exp(-t * 5.2)
    return np.tanh((saw * 1.4 + np.sin(2 * np.pi * freq * 0.5 * t) * 0.5) * e) * 0.5


def pluck(freq, dur=0.22):
    n = int(dur * SR)
    t = np.arange(n) / SR
    sq = np.sign(np.sin(2 * np.pi * freq * t))
    tri = 2 * np.abs(2 * (t * freq % 1.0) - 1) - 1
    e = np.exp(-t * 15)
    return (sq * 0.34 + tri * 0.66) * e * 0.30


def pad_chord(freqs, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for f in freqs:
        for det in (-0.12, 0.0, 0.12):
            ff = f * (2 ** (det / 12))
            out += np.sin(2 * np.pi * ff * t + rng.uniform(0, 6))
    e = env_ad(n, 0.16, 0.4, curve=0.35)
    return out / (len(freqs) * 3) * e * 0.55


def riser(dur=0.5):
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = rng.normal(0, 1, n)
    # 越来越亮的噪声：用与高频正弦相乘来制造上行感
    sweep = 420 + 3400 * (t / dur) ** 2
    mod = np.sin(2 * np.pi * np.cumsum(sweep) / SR)
    e = (t / dur) ** 2.6
    return noise * (0.55 + 0.45 * mod) * e * 0.30


def impact(dur=0.7):
    n = int(dur * SR)
    t = np.arange(n) / SR
    boom = np.sin(2 * np.pi * (70 * np.exp(-t * 8) + 34) * t) * np.exp(-t * 4.5)
    return boom * 0.75


# ---------------------------------------------------------------- 编曲
buf = np.zeros(N)
beat = BEAT
bar = BAR

for b in range(BARS):
    t0 = b * bar
    chord = PROG[(b // 2) % 4]
    root = chord[0] - 12

    # --- Pad：每小节换一次，后面几段减薄
    if b < 28:
        g = 0.30 if b < 4 else 0.22
        place(buf, pad_chord([midi_hz(m) for m in chord], bar * 1.02), t0, g)

    # --- 鼓组
    drums_on = 4 <= b < 30
    if drums_on:
        for k in range(4):
            place(buf, kick(), t0 + k * beat, 0.95 if k in (0, 2) else 0.80)
        # 军鼓打 2、4 拍
        place(buf, snare(), t0 + beat, 0.42)
        place(buf, snare(), t0 + 3 * beat, 0.46)
        # 十六分踩镲，重音在正拍
        for i in range(16):
            acc = 0.62 if i % 4 == 0 else (0.36 if i % 2 == 0 else 0.22)
            place(buf, hihat(open_=(i == 14 and b % 4 == 3)), t0 + i * beat / 4, acc)
    elif b >= 30:
        # 收尾最后一小节给一记底鼓收束
        if b == 30:
            place(buf, kick(), t0, 0.85)
            place(buf, impact(), t0, 0.55)

    # --- 贝斯：8 小节后进，八分音符
    if 6 <= b < 29:
        for i in range(8):
            m = root + (12 if i in (3, 7) else 0)
            place(buf, bass_note(midi_hz(m), beat * 0.46), t0 + i * beat / 2, 0.62)

    # --- 琶音：8 小节后进，十六分，隔一个音留空制造跳跃感
    if 8 <= b < 28:
        seq = [chord[0], chord[1], chord[2], chord[1] + 12]
        for i in range(16):
            if i % 4 == 3:
                continue
            m = seq[i % 4] + (12 if (i // 4) % 2 else 0)
            place(buf, pluck(midi_hz(m), 0.20), t0 + i * beat / 4, 0.30 if i % 4 else 0.40)

    # --- 每 2 小节的切换点：riser + impact
    if b % 2 == 1 and 4 <= b < 28:
        place(buf, riser(beat * 0.9), t0 + bar - beat * 0.9, 0.44)
        place(buf, impact(), t0 + bar, 0.30)

# 结尾：一个长 pad 收尾
place(buf, pad_chord([midi_hz(m) for m in [48, 55, 64, 67]], 2.2), (BARS - 2) * bar, 0.34)

# ---------------------------------------------------------------- 母线
# 简易混响：几条递减延时，模拟大厅
rv = np.zeros(N)
for delay, g in ((0.083, 0.30), (0.131, 0.22), (0.197, 0.15), (0.271, 0.10)):
    d = int(delay * SR)
    rv[d:] += buf[:-d] * g
buf = buf * 0.82 + rv * 0.30

# 整体淡入淡出
fade_in = int(0.05 * SR)
buf[:fade_in] *= np.linspace(0, 1, fade_in)
fade_out = int(1.1 * SR)
buf[-fade_out:] *= np.linspace(1, 0, fade_out) ** 1.5

# 软限幅 + 归一化
buf = np.tanh(buf * 1.25)
peak = np.max(np.abs(buf)) or 1.0
buf = buf / peak * 0.72

st = np.stack([buf, np.roll(buf, int(0.006 * SR))], axis=1)
st = np.clip(st, -1, 1)
pcm = (st * 32767).astype(np.int16)

path = os.path.join(OUT, "audio.wav")
with wave.open(path, "wb") as f:
    f.setnchannels(2)
    f.setsampwidth(2)
    f.setframerate(SR)
    f.writeframes(pcm.tobytes())

rms = 20 * np.log10(np.sqrt(np.mean(buf ** 2)) + 1e-9)
print(f"写出 {path}  {DUR:.2f}s  {BPM}BPM  peak={np.max(np.abs(buf)):.2f}  RMS={rms:.1f}dB")
