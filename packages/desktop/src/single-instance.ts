// One Jarvis app per user data directory (review I1).
//
// Two instances on one jarvis.yaml would be two in-process cores — two
// config writers, two session stores on one database, two bridges on one
// port — or, in background mode, two apps attached to one daemon. So the
// second instance hands over to the first (which brings its window
// forward) and quits before it builds anything.
//
// `--jarvis-daemon` launches never call this: they start the daemon and
// get out of the way, whether or not the app is open (main.ts).

export type SingleInstanceApp = {
  requestSingleInstanceLock(): boolean;
  on(event: "second-instance", listener: () => void): unknown;
  quit(): void;
};

/** True when this is the only instance; false after asking a second one to quit. */
export function claimSingleInstance(app: SingleInstanceApp, focus: () => void): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", focus);
  return true;
}
