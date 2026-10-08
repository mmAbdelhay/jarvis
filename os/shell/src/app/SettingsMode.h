#pragma once

class QGuiApplication;

// `jarvis-shell --settings` (Rafiq M4 contracts §2): Settings in an ordinary
// window with its own control connection; one per session (a second launch
// raises it). quitAfterMs > 0 quits after that long (smoke test).
int runSettingsWindow(QGuiApplication& app, int quitAfterMs = -1);
