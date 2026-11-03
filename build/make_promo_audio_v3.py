# -*- coding: utf-8 -*-
"""
SMUCL 2.0 宣传片音轨 —— 发布会风格（克制、明亮、无版权）

84 BPM / 4 拍 / 和弦垫 + 钢琴式琶音 + 轻低频脉冲
转场用一段上扬的噪声扫频，收尾留给一个长和弦

用法：python build/make_promo_audio_v3.py
输出：build/promo3/audio.wav（48kHz / 16bit / 立体声）
"""
import os
import wave
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "build", "promo3")
os.makedirs(OUT, exist_ok=True)

SR = 48000
DUR = 60.0
N = int(SR * DUR)

BPM = 84
BEAT = 60.0 / BPM
BAR = BEAT * 4

rng = np.random.default_rng(2026)


def add(buf, sig, start, gain=1.0):
    i0 = int(start * SR)
    if i0 >= N or i0 + len(sig) <= 0:
        return
    if i0 < 0:
        sig = sig[-i0:]
        i0 = 0
    n = min(len(sig), N - i0)
    buf[i0:i0 + n] += sig[:n] * gain


def sine(freq, n, phase=0.0):
    t = np.arange(n) / SR
    return np.sin(2 * np.pi * freq * t + phase)


def fft_band(x, lo=None, hi=None):
    """FFT 域带通/低通，够用且快"""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    m = np.ones_like(f)
    if lo:
        m *= 1 / (1 + np.exp(-(f - lo) / (lo * 0.35 + 1)))
    if hi:
        m *= 1 / (1 + np.exp((f - hi) / (hi * 0.30 + 1)))
    return np.fft.irfft(X * m, n=len(x))


def env(n, a, d, s=0.0, r=0.0, hold=None):
    """attack / decay / sustain / release 包络，时间单位秒"""
    na = max(1, int(a * SR))
    nd = max(1, int(d * SR))
    nr = max(1, int(r * SR))
    nh = n - na - nd - nr
    if nh < 0:
        nh = 0
    e = np.concatenate([
        np.linspace(0, 1, na),
        np.linspace(1, s, nd),
        np.full(nh, s),
        np.linspace(s, 0, nr),
    ])
    if len(e) < n:
        e = np.pad(e, (0, n - len(e)))
    return e[:n]


# ---------------------------------------------------------------- 音色
def pad_note(freq, dur, gain=1.0):
    """柔和和弦垫：三个略微失谐的正弦 + 缓慢起音"""
    n = int(dur * SR)
    sig = np.zeros(n)
    for det, w in ((0.0, 0.6), (0.7, 0.3), (-0.9, 0.3)):
        sig += sine(freq + det, n) * w
        sig += sine(freq * 2 + det, n) * w * 0.22
        sig += sine(freq * 3 + det, n) * w * 0.08
    sig *= env(n, min(1.6, dur * 0.35), 0.6, 0.75, 1.4)
    return sig * gain


def pluck(freq, dur=1.1, gain=1.0):
    """钢琴式颗粒：基频 + 少量谐波，指数衰减"""
    n = int(dur * SR)
    t = np.arange(n) / SR
    sig = (
        np.sin(2 * np.pi * freq * t) * 1.0
        + np.sin(2 * np.pi * freq * 2 * t) * 0.32
        + np.sin(2 * np.pi * freq * 3.01 * t) * 0.14
        + np.sin(2 * np.pi * freq * 4.98 * t) * 0.05
    )
    dec = np.exp(-t * 3.4)
    att = np.clip(t / 0.008, 0, 1)
    return sig * dec * att * gain


def sub(freq, dur, gain=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    sig = np.sin(2 * np.pi * freq * t) * np.exp(-t * 2.0)
    return sig * np.clip(t / 0.02, 0, 1) * gain


def whoosh(dur=1.5, gain=1.0, up=True):
    """转场：一段噪声从低到高扫上去，首尾都做淡入淡出"""
    n = int(dur * SR)
    x = rng.normal(0, 1, n)
    # 用两段不同带宽的噪声交叉淡化，模拟扫频
    lo = fft_band(x, lo=180, hi=900)
    hi = fft_band(x, lo=1200, hi=5200)
    t = np.linspace(0, 1, n)
    k = t ** 2 if up else (1 - t) ** 2
    sig = lo * (1 - k) + hi * k
    sig *= np.sin(np.pi * np.clip(t * 1.0, 0, 1)) ** 1.4
    return sig * gain


def tick(dur=0.16, gain=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    sig = rng.normal(0, 1, n) * np.exp(-t * 60)
    sig = fft_band(sig, lo=2400, hi=9000)
    return sig * gain


# ---------------------------------------------------------------- 编排
def build():
    L = np.zeros(N)
    R = np.zeros(N)

    # 和弦：Am - F - C - G，每小节一个
    A2, C3, E3 = 110.00, 130.81, 164.81
    F2, A3, C4 = 87.31, 220.00, 261.63
    C3b, E4, G3 = 130.81, 329.63, 196.00
    G2, B3, D4 = 98.00, 246.94, 293.66
    chords = [
        (A2, [A3, C4, E4]),
        (F2, [A3, C4, F2 * 4]),
        (C3b, [G3, C4, E4]),
        (G2, [B3, D4, G3 * 2]),
    ]

    nbars = int(np.ceil(DUR / BAR))
    for b in range(nbars):
        t0 = b * BAR
        root, notes = chords[b % 4]
        # 每两小节换一次和声，第二小节只保留长音，避免太满
        dur = BAR * (2.0 if b % 2 == 0 else 1.0)
        if t0 > DUR:
            break
        # 垫音：左右轻微错开做空间感
        for i, f in enumerate(notes):
            g = 0.055 if b % 2 == 0 else 0.032
            s = pad_note(f, min(dur + 0.8, DUR - t0 + 0.8), g)
            add(L, s, t0, 1.0)
            add(R, s, t0 + 0.006 * (i + 1), 0.95)
        # 低音脉冲：每小节第一拍
        s = sub(root, 2.4, 0.11)
        add(L, s, t0, 1.0)
        add(R, s, t0, 1.0)

        # 琶音：只在偶数小节铺，8 分音符
        if b % 2 == 0:
            pattern = [0, 1, 2, 1, 2, 0, 1, 2]
            for k, idx in enumerate(pattern):
                f = notes[idx % len(notes)] * (2 if k >= 4 else 1)
                s = pluck(f, 1.3, 0.085)
                add(L, s, t0 + k * BEAT / 2, 1.0)
                add(R, s, t0 + k * BEAT / 2 + 0.010, 0.85)

        # 轻打点：第 2、4 拍一点点噪声，给节奏骨架
        for k in (1, 3):
            s = tick(0.16, 0.030)
            add(L, s, t0 + k * BEAT, 1.0)
            add(R, s, t0 + k * BEAT + 0.004, 0.9)

    # 场景转场 whoosh（与画面切点对齐）
    for st in (7.0, 13.5, 22.0, 31.0, 38.5, 47.0, 53.5):
        s = whoosh(1.6, 0.075)
        add(L, s, st - 1.05, 1.0)
        add(R, s, st - 1.00, 0.9)

    # 结尾：一个长和弦 + 高频泛音渐弱
    t_end = 53.5
    for f, g in ((A2, 0.09), (E3, 0.05), (A3, 0.045), (C4, 0.04), (E4, 0.03)):
        n = int((DUR - t_end) * SR)
        sig = sine(f, n) * env(n, 0.8, 1.2, 0.6, DUR - t_end - 2.0)
        add(L, sig, t_end, g)
        add(R, sig, t_end + 0.008, g * 0.92)

    # 总线上做一点轻微的高频滚降，去掉刺耳感
    L = fft_band(L, hi=11000)
    R = fft_band(R, hi=11000)

    # 归一化到 -3 dBFS 左右，留出平台转码余量
    peak = max(np.abs(L).max(), np.abs(R).max())
    if peak > 0:
        g = 0.70 / peak
        L *= g
        R *= g

    # 首尾各 0.4s 淡入淡出
    f = int(0.4 * SR)
    for buf in (L, R):
        buf[:f] *= np.linspace(0, 1, f)
        buf[-f:] *= np.linspace(1, 0, f)
    return L, R


def main():
    L, R = build()
    data = np.stack([L, R], axis=1)
    pcm = np.clip(data * 32767, -32768, 32767).astype("<i2")
    path = os.path.join(OUT, "audio.wav")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    print("写出", path, f"{os.path.getsize(path)/1024/1024:.1f} MB")


if __name__ == "__main__":
    main()
