#pragma once

// Where jarvisd's control transport lives (packages/desktop/src/daemon/control/endpoint.ts):
// one 0700 run dir, ~/.config/jarvis/run, holding jarvisd.sock and control.secret.

#include <QString>

namespace jarvis::protocol {

struct ControlPaths {
    QString runDirectory;
    QString socketPath;
    QString secretPath;
};

ControlPaths controlPaths(const QString& runDirectory);

// $JARVIS_RUN_DIR (tests), else $HOME/.config/jarvis/run.
QString defaultRunDirectory();

} // namespace jarvis::protocol
