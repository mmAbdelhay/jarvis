# Teaser

`jarvis-teaser.mp4` — a two-minute vertical (1080×1920, 30 fps) reel, 20 scenes:
the hook, boot, agents, voice, Arabic and English, the plan panel, the
terminal, the Workspace tabs, machine load, provider capacity, the dashboard,
sessions, Changes, prayer times, `jarvisd`, the phone, privacy, setup,
platforms and the end card.

It is rendered from `teaser.html`, a deterministic timeline: `render(t)` draws
the frame at `t` seconds. `ORDER` near the top of the script sets the scenes
and their lengths; the soundtrack follows it through `timeline.json`. Open
`teaser.html?t=12` to see one frame, or open it plain to watch it play in real
time. It uses the screenshots in `docs/media/`
and the app icon, so keep it where it is.

Some figures on screen are illustrative, not measured: the claude capacity, the
reset countdowns, the session total and both charts, the plan and its comments,
the conversation, the terminal's blocks, the files and commit in Changes, the
prayer times (roughly Alexandria in October), the `jarvisd` output, and the
setup screen's tool list.

To re-render (needs Playwright, Chromium, ffmpeg, and numpy for the audio):

```bash
cd docs/media/teaser
node render.mjs video           # frames → video_silent.mp4, and timeline.json
python3 audio.py                # timeline.json → soundtrack.wav
ffmpeg -i video_silent.mp4 -i soundtrack.wav -c:v copy -c:a aac -b:a 192k \
  -shortest -movflags +faststart jarvis-teaser.mp4
node render.mjs stills 5 20     # single frames, for checking layout
```
