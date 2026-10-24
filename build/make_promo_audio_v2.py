# -*- coding: utf-8 -*-
"""
SMUCL 1.5.0 宣传片音轨 —— 音乐为主体（纯合成，无版权）
108 BPM / 四拍底鼓 / 侧链 ducking / 16 分琶音
转场冲击音压到约 1/3，把空间留给律动
"""
import os
import wave
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "build", "promo2", "audio.wav")
SR = 48000
DUR = 47.0
N = int(SR * DUR)

BPM = 108
BEAT = 60.0 / BPM
BAR = BEAT * 4

rng = np.random.default_rng(11)


def add(buf, sig, start):
    i0 = int(start * SR)
    if i0 >= N or i0 + len(sig) <= 0:
        return
    if i0 < 0:
        sig = sig[-i0:]
        i0 = 0
    n = min(len(sig), N - i0)
    buf[i0:i0 + n] += sig[:n]


def lowpass(x, cutoff, sr=SR):
    a = 1 - np.exp(-2 * np.pi * cutoff / sr)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += a * (x[i] - acc)
        y[i] = acc
    return y


def highpass(x):
    return np.diff(np.concatenate([[0.0], x]))


# ---------------------------------------------------------------- 鼓
def kick(amp=0.9):
    n = int(0.42 * SR)
    tt = np.arange(n) / SR
    f = 118 * np.exp(-tt * 24) + 46
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 7.5)
    click = rng.normal(0, 1, n) * np.exp(-tt * 160) * 0.35
    return (body + click) * amp


def clap(amp=0.32):
    n = int(0.22 * SR)
    tt = np.arange(n) / SR
    sig = np.zeros(n)
    for d in (0.0, 0.011, 0.023):
        burst = rng.normal(0, 1, n) * np.exp(-np.clip(tt - d, 0, None) * 55)
        sig += np.where(tt >= d, burst, 0)
    sig = highpass(highpass(sig))
    return sig * np.exp(-tt * 12) * amp


def hat(amp=0.12, decay=90):
    n = int(0.12 * SR)
    tt = np.arange(n) / SR
    return highpass(rng.normal(0, 1, n)) * np.exp(-tt * decay) * amp


def impact(amp=0.55):
    n = int(1.2 * SR)
    tt = np.arange(n) / SR
    f = 90 * np.exp(-tt * 5) + 38
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 3.2)
    tail = lowpass(rng.normal(0, 1, n), 2600) * np.exp(-tt * 3.6) * 0.5
    return (boom + tail) * amp


def riser(dur=2.0, amp=0.30):
    n = int(dur * SR)
    tt = np.arange(n) / SR
    noise = rng.normal(0, 1, n)
    out = np.zeros(n)
    acc = 0.0
    for i in range(n):
        p = i / n
        cut = 400 + 7000 * p ** 2
        a = 1 - np.exp(-2 * np.pi * cut / SR)
        acc += a * (noise[i] - acc)
        out[i] = acc
    out *= (tt / dur) ** 2.2 * amp
    return out


# ---------------------------------------------------------------- 音高
A4 = 440.0


def hz(semi):
    return A4 * 2 ** (semi / 12.0)


CHORDS = [
    (-12, [-12, 0, 3, 7]),     # Am
    (-16, [-16, -4, 0, 3]),    # F
    (-9, [-9, 3, 7, 10]),      # C
    (-14, [-14, -2, 2, 5]),    # G
]


def chord_at(t):
    return CHORDS[int(t // (BAR * 2)) % len(CHORDS)]


def pluck(semi, amp=0.16, dur=0.28):
    n = int(dur * SR)
    tt = np.arange(n) / SR
    f = hz(semi)
    sig = (np.sin(2 * np.pi * f * tt) * 0.7
           + np.sin(2 * np.pi * f * 2 * tt) * 0.22
           + np.sin(2 * np.pi * f * 3 * tt) * 0.08)
    env = np.exp(-tt * 9) * (1 - np.exp(-tt * 200))
    return sig * env * amp


def bass(semi, amp=0.34, dur=0.42):
    n = int(dur * SR)
    tt = np.arange(n) / SR
    f = hz(semi)
    sig = (np.sin(2 * np.pi * f * tt)
           + 0.4 * np.sin(2 * np.pi * f * 2 * tt)
           + 0.18 * np.sin(2 * np.pi * f * 3 * tt))
    env = np.exp(-tt * 3.2) * (1 - np.exp(-tt * 120))
    return sig * env * amp


def pad_note(semi, dur, amp=0.05):
    n = int(dur * SR)
    tt = np.arange(n) / SR
    f = hz(semi)
    sig = (np.sin(2 * np.pi * f * tt)
           + 0.6 * np.sin(2 * np.pi * f * 1.004 * tt)
           + 0.35 * np.sin(2 * np.pi * f * 2 * tt))
    a = int(0.5 * SR)
    env = np.ones(n)
    if a < n:
        env[:a] = np.linspace(0, 1, a) ** 0.8
        env[-a:] = np.linspace(1, 0, a) ** 1.2
    return sig * env * amp


# ---------------------------------------------------------------- 编排
bassbuf = np.zeros(N)
arp = np.zeros(N)
padbuf = np.zeros(N)
fx = np.zeros(N)
kicks = np.zeros(N)
hats = np.zeros(N)
claps = np.zeros(N)
bell = np.zeros(N)

T_START, T_END = 4.4, 40.4
PEAK_START, PEAK_END = 19.8, 30.8

t = T_START
while t < T_END:
    add(kicks, kick(0.95), t)
    if PEAK_START <= t < PEAK_END:
        add(kicks, kick(0.42), t + BEAT / 2)
    t += BEAT

t = 13.4
while t < T_END:
    k = ((t - 13.4) / BEAT) % 4
    if abs(k - 1) < 0.01 or abs(k - 3) < 0.01:
        add(claps, clap(0.34), t)
    t += BEAT

t = T_START
while t < T_END:
    add(hats, hat(0.10 if t < PEAK_START else 0.13), t)
    if PEAK_START <= t < PEAK_END:
        add(hats, hat(0.05, 120), t + BEAT / 4)
        add(hats, hat(0.05, 120), t + BEAT * 0.75)
    else:
        add(hats, hat(0.045, 130), t + BEAT / 2)
    t += BEAT

t = 3.6
while t < T_END:
    root = chord_at(t)[1][0]
    add(bassbuf, bass(root, 0.30), t)
    add(bassbuf, bass(root, 0.18, 0.30), t + BEAT / 2)
    t += BEAT

t = 13.4
i = 0
while t < T_END:
    notes = chord_at(t)[1]
    semi = notes[i % len(notes)] + 12
    add(arp, pluck(semi, 0.13 if t < PEAK_START else 0.17), t)
    t += BEAT / 4
    i += 1

t = 0.0
while t < DUR:
    semi = chord_at(t)[1]
    dur = BAR * 2
    for s2 in semi:
        add(padbuf, pad_note(s2, min(dur, DUR - t), 0.058), t)
    # 片头额外的低频张力
    if t < 6.0:
        add(padbuf, pad_note(semi[0] - 12, min(dur, 6.0 - t), 0.06), t)
    t += dur

for cut in (13.4, 19.8, 40.6):
    add(fx, riser(1.8, 0.11), cut - 1.8)
for cut in (13.4, 19.8, 25.4, 30.8, 35.6):
    add(fx, impact(0.24), cut - 0.04)
add(fx, riser(3.2, 0.07), 0.5)

for semi, amp, dur in ((0, 0.16, 3.6), (7, 0.09, 3.0), (12, 0.05, 2.4)):
    n = int(dur * SR)
    tt = np.arange(n) / SR
    f = hz(12 + semi)
    sig = (np.sin(2 * np.pi * f * tt)
           + 0.4 * np.sin(2 * np.pi * f * 2.01 * tt)
           + 0.2 * np.sin(2 * np.pi * f * 3.02 * tt))
    sig *= np.exp(-tt * 1.6) * (1 - np.exp(-tt * 300)) * amp
    add(bell, sig, 40.7)

# ---------------------------------------------------------------- 侧链
kick_env = np.zeros(N)
t = T_START
while t < T_END:
    i0 = int(t * SR)
    n = min(int(0.35 * SR), N - i0)
    if n > 0:
        tt = np.arange(n) / SR
        kick_env[i0:i0 + n] = np.maximum(kick_env[i0:i0 + n], np.exp(-tt * 9))
    t += BEAT

duck = 1.0 - 0.62 * kick_env

# ---------------------------------------------------------------- 混音
mix_L = (kicks * 0.52 + claps * 1.06 + hats * 2.20
         + bassbuf * duck * 0.62
         + arp * duck * 3.15
         + padbuf * (0.55 + 0.45 * duck) * 1.45
         + fx * 0.34 + bell * 0.85)

mix_R = (kicks * 0.52 + claps * 1.06 + hats * 1.60
         + bassbuf * duck * 0.62
         + arp * duck * 3.55
         + padbuf * (0.55 + 0.45 * duck) * 1.45
         + fx * 0.34 + bell * 0.90)

# 只去直流，不要削低频（一阶差分在 50Hz 会衰减 40dB，底鼓贝斯会消失）
from scipy.signal import lfilter

mix_L = lfilter([1.0, -1.0], [1.0, -0.9995], mix_L)
mix_R = lfilter([1.0, -1.0], [1.0, -0.9995], mix_R)

fade = np.ones(N)
fi = int(0.35 * SR)
fade[:fi] = np.linspace(0, 1, fi) ** 0.6
fo = int(2.2 * SR)
fade[-fo:] = np.linspace(1, 0, fo) ** 1.4
mix_L *= fade
mix_R *= fade

# --- 总线压缩（软拐点），把 RMS 提上来而不爆音 ---
from scipy.ndimage import uniform_filter1d

def compress(x, thr=0.13, ratio=3.0, win=0.06):
    env = uniform_filter1d(np.abs(x), size=int(win * SR))
    env = np.maximum(env, 1e-6)
    gain = np.minimum(1.0, (thr / env) ** (1.0 - 1.0 / ratio))
    # 平滑增益，避免抽吸感
    gain = uniform_filter1d(gain, size=int(win * SR))
    return x * gain * 1.55

mix_L = compress(mix_L)
mix_R = compress(mix_R)
mix_L = np.tanh(mix_L * 1.05)
mix_R = np.tanh(mix_R * 1.05)
peak = max(np.abs(mix_L).max(), np.abs(mix_R).max()) or 1.0
g = 0.92 / peak
stereo = np.stack([mix_L * g, mix_R * g], axis=1)
pcm = (np.clip(stereo, -1, 1) * 32767).astype("<i2")

with wave.open(OUT, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())

print("音轨 v2 已生成:", OUT)
for i in range(0, int(DUR), 2):
    a, b = int(i * SR), min(int((i + 2) * SR), N)
    rms = float(np.sqrt((stereo[a:b] ** 2).mean()))
    print(f"  {i:>2}-{i + 2:>2}s  RMS {rms:.3f}  {'#' * int(rms * 90)}")
