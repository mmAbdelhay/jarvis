# Picture-in-Picture inside a `WebContentsView`

**Question.** The Workspace's browser tabs are Electron `WebContentsView`s, not
`BrowserWindow`s. Does the page's own Picture-in-Picture API work there — and
is the resulting window a real always-on-top OS window — or does a floating
video have to be built out of an always-on-top `BrowserWindow` we own?

**Answer: native PiP works, and is the better window.** No `BrowserWindow`
needed.

## What was run

`spikes/pip/main.cjs` (`npx electron spikes/pip/main.cjs`, Electron 44) against
a local page serving an h.264 `<video>` over `http://127.0.0.1:8791`. The view
is created with exactly the app's hardening — `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`, no preload.

```
EVENT media-started-playing
PROBE {"hasVideo":true,"paused":false,"videoWidth":640,
       "pipEnabled":true,"disablePip":false,"hasRequest":true}
REQUEST_PIP {"ok":true,"w":366,"h":206,"el":true}
PIP_ELEMENT_AFTER true
WINDOWS 1
EVENT media-paused
```

Three things that decided it:

- `document.pictureInPictureEnabled` is **true** inside a sandboxed
  `WebContentsView`, and `requestPictureInPicture()` resolves with a real
  `PictureInPictureWindow` (366x206).
- `BrowserWindow.getAllWindows().length` stays **1**. The PiP window is
  Chromium's own widget, not something Electron surfaced as a window — which
  is why nothing has to be positioned, sized or closed by us.
- A full-screen `screencapture` while it was up showed the video floating over
  **Slack**, a different application entirely. It is genuinely always-on-top,
  across apps, not merely above our own window.

`executeJavaScript(code, /* userGesture */ true)` is required:
`requestPictureInPicture()` is gated on a user gesture, and the user's click
lands on our chrome rather than in the page.

## Why the `BrowserWindow` route was not taken

It was the fallback, and it is strictly worse:

- A window of ours can host a direct media URL, but not a video Chromium is
  already decoding through MSE — which is what YouTube and every other real
  player uses. It would have had to reload the video from scratch, losing the
  playback position, the buffer and any authenticated stream.
- The window's position, size, aspect ratio, close button and "return to tab"
  affordance would all have been ours to build, and would have looked nothing
  like the PiP window the user already knows from Chrome.

## Detection

`media-started-playing` / `media-paused` on the `WebContents` fire reliably
(both appear in the log above), but they fire for audio as readily as for
video. They are used as a *prompt to ask the page*, never as the answer — see
`FIND_PLAYING_VIDEO` in `electron-view.ts` and the `"media"` case in
`browser-host.ts`.
