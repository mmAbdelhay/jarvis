# Synthesises the teaser's soundtrack from timeline.json (written by render.mjs):
# a pad that changes chord with each scene, a pulse, whooshes into every cut,
# and the clicks, blips and hits the page lists as cues.
import json, wave
import numpy as np

TL = json.load(open('timeline.json'))
SR = 48000
DUR = float(TL['duration'])
scenes = sorted(TL['scenes'].items(), key=lambda kv: kv[1][0])
start = {k: v[0] for k, v in scenes}
t = np.arange(int(SR * DUR)) / SR
out = np.zeros_like(t)
rng = np.random.default_rng(7)

AM = [110, 164.81, 220, 261.63, 329.63]; FM = [87.31, 174.61, 220, 261.63, 349.23]
CM = [130.81, 196, 261.63, 329.63, 392]; GM = [98, 196, 246.94, 293.66, 392]
prog = [AM, FM, CM, GM]
chords = [(v[0], prog[i % 4]) for i, (k, v) in enumerate(scenes)]
chords[-1] = (chords[-1][0], AM + [440])

pad = np.zeros_like(t)
for i, (s0, notes) in enumerate(chords):
    end = chords[i + 1][0] if i + 1 < len(chords) else DUR
    w = np.clip((t - s0 + 1.0) / 2.0, 0, 1) * np.clip((end + 1.0 - t) / 2.0, 0, 1)
    for f in notes:
        for det in (-0.6, 0.6):
            pad += w * np.sin(2 * np.pi * (f + det) * t + rng.uniform(0, 6)) / len(notes)
pad *= 0.5 + 0.5 * np.sin(2 * np.pi * 0.25 * t) ** 2
pad *= np.clip(t / 2.5, 0, 1)
out += 0.16 * pad

def seg(at, length):
    x = t - at
    return x, (x >= 0) & (x < length)

beat = 60 / 100
for k in np.arange(start['s2'], start['s7'], beat):
    x, m = seg(k, .4)
    f = 55 + 70 * np.exp(-x[m] * 30)
    out[m] += 0.32 * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-x[m] * 9)
for k in np.arange(start['s5'] + beat / 2, start['s7'], beat):
    x, m = seg(k, .08)
    out[m] += 0.05 * rng.standard_normal(m.sum()) * np.exp(-x[m] * 60)

def whoosh(at, length=0.7, gain=0.18):
    x, m = seg(at - length, length + .3)
    n = np.convolve(rng.standard_normal(m.sum()), np.ones(6) / 6, mode='same')
    out[m] += gain * n * np.sin(np.clip(x[m] / (length + .3), 0, 1) * np.pi) ** 2

for k, (a, b) in scenes:
    if a > 0:
        whoosh(a + .15)

def hit(at, gain=.45):
    x, m = seg(at, DUR)
    out[m] += gain * np.sin(2 * np.pi * np.cumsum(45 + 60 * np.exp(-x[m] * 20)) / SR) * np.exp(-x[m] * 2.2)
    for f in (220, 329.63, 440, 659.25):
        out[m] += gain / 9 * np.sin(2 * np.pi * f * x[m]) * np.exp(-x[m] * .8)

for c in TL['cues']:
    at, kind = c['t'], c['kind']
    if kind == 'click':
        x, m = seg(at, .05)
        out[m] += 0.25 * rng.standard_normal(m.sum()) * np.exp(-x[m] * 120)
    elif kind == 'chirp':
        x, m = seg(at, .25)
        out[m] += 0.12 * np.sin(2 * np.pi * np.cumsum(600 + 1400 * x[m] / .25) / SR) * np.sin(np.pi * x[m] / .25)
    elif kind == 'blip':
        x, m = seg(at, .3)
        out[m] += 0.10 * np.sin(2 * np.pi * c['f'] * x[m]) * np.exp(-x[m] * 14)
    elif kind == 'swish':
        whoosh(at + .35, .45, .14)
    elif kind == 'hit':
        hit(at, .45 if at > DUR - 10 else .3)

out *= np.clip((DUR - t) / 1.2, 0, 1)
out = np.tanh(out * 1.4) / np.tanh(1.4)
out /= np.abs(out).max() / 0.89
stereo = np.stack([out, np.roll(out, 240)], axis=1)
with wave.open('soundtrack.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((stereo * 32767).astype('<i2').tobytes())
print(f'ok · {DUR:.1f}s · {len(TL["cues"])} cues')
