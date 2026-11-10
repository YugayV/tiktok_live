#!/usr/bin/env python3
"""Synthesizes the built-in alert sounds (public/sounds/*.mp3). Original, generated audio — no samples.
Run: python3 scripts/make-sounds.py  (needs numpy and ffmpeg)"""
import os, subprocess, tempfile, wave
import numpy as np

SR = 44100
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'sounds')
rng = np.random.default_rng(7)


def t(d):
    return np.arange(int(SR * d)) / SR


def env(d, a=0.005, r=None):
    x = t(d)
    e = np.minimum(1, x / a)
    return e * np.exp(-x / (r or d / 4))


def tone(f, d, kind='sine', r=None, a=0.005):
    x = t(d)
    if kind == 'sine':
        w = np.sin(2 * np.pi * f * x)
    elif kind == 'bell':
        w = sum(np.sin(2 * np.pi * f * m * x) * g for m, g in [(1, 1), (2.76, .4), (5.4, .2), (8.9, .08)])
    elif kind == 'square':
        w = np.sign(np.sin(2 * np.pi * f * x)) * .5
    elif kind == 'brass':
        w = sum(np.sin(2 * np.pi * f * k * x) / k for k in range(1, 9))
    return w * env(d, a, r)


def seq(notes, kind='sine', gap=0.0, r=None):
    """notes: list of (freq or list of freqs, duration)."""
    parts = []
    for f, d in notes:
        fs = f if isinstance(f, (list, tuple)) else [f]
        parts.append(sum(tone(x, d, kind, r) for x in fs) / len(fs))
        if gap:
            parts.append(np.zeros(int(SR * gap)))
    return np.concatenate(parts)


def mix(*tracks):
    n = max(len(x) for x in tracks)
    out = np.zeros(n)
    for x in tracks:
        out[:len(x)] += x
    return out


def noise(d):
    return rng.uniform(-1, 1, int(SR * d))


def lowpass(x, k):
    return np.convolve(x, np.ones(k) / k, mode='same')


N = {'C5': 523.25, 'D5': 587.33, 'E5': 659.25, 'G5': 783.99, 'A5': 880, 'B5': 987.77, 'C6': 1046.5, 'E6': 1318.5, 'G6': 1568, 'C4': 261.63, 'E4': 329.63, 'G4': 392, 'A4': 440}

SOUNDS = {
    'coin': seq([(N['B5'], .08), (N['E6'], .35)], 'square', r=.12),
    'pop': np.sin(2 * np.pi * np.cumsum(np.linspace(900, 180, int(SR * .09))) / SR) * env(.09, .002, .03),
    'chime': mix(tone(N['C6'], 1.4, 'bell', r=.45), np.concatenate([np.zeros(int(SR * .12)), tone(N['E6'], 1.3, 'bell', r=.4)]), np.concatenate([np.zeros(int(SR * .24)), tone(N['G6'], 1.2, 'bell', r=.4)])),
    'sparkle': np.concatenate([tone(f, .07, 'bell', r=.05) for f in [2093, 2637, 3136, 2637, 3520, 4186]] + [tone(4186, .4, 'bell', r=.12)]),
    'levelup': seq([(N['C5'], .09), (N['E5'], .09), (N['G5'], .09), (N['C6'], .32)], 'square', r=.1),
    'fanfare': seq([(N['G4'], .14), (N['C5'], .14), (N['E5'], .14), ([N['G5'], N['C5'], N['E5']], .9)], 'brass', r=.35) * .8,
    'tada': seq([([N['C5'], N['E5'], N['G5']], .16), ([N['C5'], N['E5'], N['G5'], N['C6']], 1.1)], 'brass', gap=.05, r=.4) * .8,
    'whoosh': lowpass(noise(.7), 30) * np.sin(np.linspace(0, np.pi, int(SR * .7))) ** 2 * 3,
    'drumroll': np.concatenate([lowpass(noise(.9), 6) * (0.4 + 0.6 * (np.sin(2 * np.pi * 28 * t(.9)) > 0)) * np.linspace(.3, 1, int(SR * .9)), mix(lowpass(noise(.5), 3) * env(.5, .001, .08), tone(70, .5, 'sine', r=.15) * 1.5)]),
    'horn': mix(*(tone(f, 1.1, 'brass', r=.9, a=.04) for f in [N['C4'], N['E4'], N['G4']])) * .6,
    'heart': seq([(N['E5'], .12), (N['A5'], .5)], 'bell', r=.2),
}

LABELS = {
    'coin': 'Монетка', 'pop': 'Поп', 'chime': 'Колокольчик', 'sparkle': 'Искры', 'levelup': 'Новый уровень',
    'fanfare': 'Фанфары', 'tada': 'Та-дам!', 'whoosh': 'Вжух', 'drumroll': 'Барабанная дробь', 'horn': 'Горн', 'heart': 'Сердечко',
}

os.makedirs(OUT, exist_ok=True)
for name, x in SOUNDS.items():
    x = x / (np.max(np.abs(x)) or 1) * 0.89
    x = np.concatenate([x, np.zeros(int(SR * .05))])
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        path = f.name
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype('<i2').tobytes())
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', path, '-codec:a', 'libmp3lame', '-b:a', '96k', os.path.join(OUT, f'{name}.mp3')], check=True)
    os.unlink(path)
    print(name, LABELS[name])
