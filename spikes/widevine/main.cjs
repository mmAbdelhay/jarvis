// Stage-1 spike: does Electron for Content Security actually decrypt and play
// a real Widevine stream? Runs the Shaka "Angel One" Widevine test asset
// against Shaka's public no-auth license proxy. Not part of the app.
const { app, components, BrowserWindow } = require("electron");
app.whenReady().then(async () => {
  await components.whenReady();
  console.log("[SPIKE] components: " + JSON.stringify(components.status()));
  const win = new BrowserWindow({ width: 420, height: 320, show: false });
  win.webContents.on("console-message", (_e, _lvl, msg) => {
    if (!msg.startsWith("[SPIKE]")) return;
    console.log(msg);
    if (msg.includes("RESULT")) setTimeout(() => app.exit(0), 500);
  });
  win.loadFile(require("node:path").join(__dirname, "index.html"));
  setTimeout(() => { console.log("[SPIKE] timeout"); app.exit(1); }, 60000);
});
