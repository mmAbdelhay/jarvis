# Synthesises the teaser's soundtrack: an A-minor pad, a pulse from scene 2,
# whooshes into each cut, a keypress + chirp for the voice scene, and a final hit.
import numpy as np, wave
SR = 48000; DUR = 60.0
t = np.arange(int(SR * DUR)) / SR
out = np.zeros_like(t)
rng = np.random.default_rng(7)

def env(t0, a, d, length=None):
    x = t - t0
    e = np.where(x < 0, 0, np.where(x < a, x / a, np.exp(-(x - a) / d)))
    return e

# pad: A minor -> F -> C -> G, each chord a few detuned sines
AM = [110, 164.81, 220, 261.63, 329.63]; FM = [87.31, 174.61, 220, 261.63, 349.23]
CM = [130.81, 196, 261.63, 329.63, 392]; GM = [98, 196, 246.94, 293.66, 392]
chords = [(0, AM), (8, FM), (13.3, CM), (18.6, GM), (23.6, AM), (28.7, FM), (33.3, CM), (40.1, GM),
          (45.7, AM), (50.1, FM), (55.3, AM + [440])]
pad = np.zeros_like(t)
for i, (start, notes) in enumerate(chords):
    end = chords[i + 1][0] if i + 1 < len(chords) else DUR
    w = np.clip((t - start + 1.0) / 2.0, 0, 1) * np.clip((end + 1.0 - t) / 2.0, 0, 1)
    for f in notes:
        for det in (-0.6, 0.6):
            pad += w * np.sin(2 * np.pi * (f + det) * t + rng.uniform(0, 6)) / len(notes)
pad *= 0.5 + 0.5 * np.sin(2 * np.pi * 0.25 * t) ** 2
pad *= np.clip(t / 2.5, 0, 1)
out += 0.16 * pad

# pulse: soft kick on each beat from 3.1s, 100 bpm
beat = 60 / 100
for k in np.arange(3.1, 55.3, beat):
    x = t - k; m = (x >= 0) & (x < .4)
    f = 55 + 70 * np.exp(-x[m] * 30)
    out[m] += 0.32 * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-x[m] * 9)
# hats on off-beats in scenes 5-6
for k in np.arange(23.6 + beat / 2, 55.3, beat):
    x = t - k; m = (x >= 0) & (x < .08)
    out[m] += 0.05 * rng.standard_normal(m.sum()) * np.exp(-x[m] * 60)

# whooshes into each cut: noise with a rising bandpass-ish emphasis
def whoosh(at, length=0.7, gain=0.18):
    x = t - (at - length); m = (x >= 0) & (x < length + .3)
    n = rng.standard_normal(m.sum())
    n = np.convolve(n, np.ones(6) / 6, mode='same')  # soften
    shape = np.sin(np.clip(x[m] / (length + .3), 0, 1) * np.pi) ** 2
    out[m] += gain * n * shape
for cut in (3.25, 8.15, 13.45, 18.75, 23.75, 28.85, 33.45, 40.25, 45.85, 50.25, 55.45):
    whoosh(cut)

# voice scene: keypress click + rising chirp, and a confirm blip
for at in [19.5, 21.9, 44.05] + [40.1 + 1.6 + i * .22 for i in range(5)]:
    x = t - at; m = (x >= 0) & (x < .05)
    out[m] += 0.25 * rng.standard_normal(m.sum()) * np.exp(-x[m] * 120)
x = t - 19.55; m = (x >= 0) & (x < .25)
out[m] += 0.12 * np.sin(2 * np.pi * np.cumsum(600 + 1400 * x[m] / .25) / SR) * np.sin(np.pi * x[m] / .25)
for at, f in ((22.0, 880), (22.4, 1318.5), (44.15, 987.8), (44.35, 1318.5)):
    x = t - at; m = (x >= 0) & (x < .3)
    out[m] += 0.10 * np.sin(2 * np.pi * f * x[m]) * np.exp(-x[m] * 14)

# final hit
x = t - 55.4; m = x >= 0
out[m] += 0.45 * np.sin(2 * np.pi * np.cumsum(45 + 60 * np.exp(-x[m] * 20)) / SR) * np.exp(-x[m] * 2.2)
for f in (220, 329.63, 440, 659.25):
    out[m] += 0.05 * np.sin(2 * np.pi * f * x[m]) * np.exp(-x[m] * .8)

out *= np.clip((DUR - t) / 1.2, 0, 1)
out = np.tanh(out * 1.4) / np.tanh(1.4)
out /= np.abs(out).max() / 0.89
stereo = np.stack([out, np.roll(out, 240)], axis=1)
with wave.open('soundtrack.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((stereo * 32767).astype('<i2').tobytes())
print('ok')
