#pragma once

#include <QString>
#include <QStringList>
#include <functional>

namespace jarvis::shell {

// $XDG_RUNTIME_DIR/jarvis/classic-fallback (Rafiq M4 contracts §6.14), written by
// jarvis-shell-loop when the shell crash-loops.
QString classicMarkerPath();

// In a session that fell back to classic mode, a jarvis-shell launch (Super →
// --focus, --ptt) opens the classic chat panel instead of starting a second
// full shell. True when jarvis-classic --chat was started.
bool redirectToClassic(const QString& markerPath,
                       const std::function<bool(const QString& program, const QStringList& args)>& start);

// "Switch to classic" from the jarvisd-down banner (contracts §6.14): writes
// the marker jarvis-shell-guard reads ("reason=<reason>\nsince=<epoch>\n"),
// its directory private (0700) like the guard's. False when it cannot.
bool writeClassicMarker(const QString& markerPath, const QString& reason, qint64 since);

} // namespace jarvis::shell
