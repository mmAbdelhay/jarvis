#pragma once

#include <QString>

// The names jarvis-cu matches to keep Jarvis's own surfaces out of its reach
// (Rafiq v1.1 contracts §1: "the Rafiq shell" is an excluded surface). Change
// them only together with jarvis-cu's exclusion list.
namespace jarvis::shell {
QString shellAppId();        // Wayland app_id of every shell toplevel (the --settings window)
QString shellLayerScope();   // layer-shell namespace of the full-screen shell surface
QString overlayLayerScope(); // layer-shell namespace of the computer-use overlay
void applyShellIdentity();   // QGuiApplication::setDesktopFileName(shellAppId())
} // namespace jarvis::shell
