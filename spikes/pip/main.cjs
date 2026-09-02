// Spike: does document.pictureInPictureElement work inside a WebContentsView
// under Electron? Run with: npx electron spikes/pip/main.cjs
const { app, BrowserWindow, WebContentsView } = require("electron");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 600 });
  await win.loadURL("data:text/html,<body style='background:%23204'><h1 style='color:white'>host</h1></body>");

  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 20, y: 60, width: 860, height: 500 });
  const wc = view.webContents;

  wc.on("media-started-playing", () => console.log("EVENT media-started-playing"));
  wc.on("media-paused", () => console.log("EVENT media-paused"));
  wc.on("enter-html-full-screen", () => console.log("EVENT enter-html-full-screen"));

  await wc.loadURL("http://127.0.0.1:8791/index.html");
  await new Promise((r) => setTimeout(r, 2500));

  const probe = await wc.executeJavaScript(`(() => {
    const v = document.querySelector('video');
    return {
      hasVideo: !!v,
      paused: v && v.paused,
      videoWidth: v && v.videoWidth,
      pipEnabled: document.pictureInPictureEnabled,
      disablePip: v && v.disablePictureInPicture,
      hasRequest: !!(v && v.requestPictureInPicture),
    };
  })()`);
  console.log("PROBE", JSON.stringify(probe));

  try {
    const result = await wc.executeJavaScript(`(async () => {
      const v = document.querySelector('video');
      try {
        const w = await v.requestPictureInPicture();
        return { ok: true, w: w.width, h: w.height, el: !!document.pictureInPictureElement };
      } catch (e) { return { ok: false, error: String(e) }; }
    })()`, true);
    console.log("REQUEST_PIP", JSON.stringify(result));
  } catch (e) {
    console.log("REQUEST_PIP_THREW", String(e));
  }

  await new Promise((r) => setTimeout(r, 2000));
  const after = await wc.executeJavaScript(`!!document.pictureInPictureElement`);
  console.log("PIP_ELEMENT_AFTER", after);
  console.log("WINDOWS", BrowserWindow.getAllWindows().length);

  setTimeout(() => app.quit(), 500);
});
