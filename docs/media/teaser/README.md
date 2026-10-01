# Teaser

`jarvis-teaser-60s.mp4` — a 60-second vertical (1080×1920, 30 fps) reel.

It is rendered from `teaser.html`, a deterministic timeline: `render(t)` draws
the frame at `t` seconds. Open `teaser.html?t=12` to see one frame, or open it
plain to watch it play in real time. It uses the screenshots in `docs/media/`
and the app icon, so keep it where it is.

Some figures on screen are illustrative, not measured: the claude capacity, the
reset countdowns, the session total and both charts, and the files and commit
in the Changes scene.

To re-render (needs Playwright, Chromium, ffmpeg, and numpy for the audio):

```bash
cd docs/media/teaser
node render.mjs video           # frames → video_silent.mp4
python3 audio.py                # → soundtrack.wav
ffmpeg -i video_silent.mp4 -i soundtrack.wav -c:v copy -c:a aac -b:a 192k \
  -shortest -movflags +faststart jarvis-teaser-60s.mp4
node render.mjs stills 5 20     # single frames, for checking layout
```
