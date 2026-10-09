#include "app/ShellIdentity.h"

#include <QGuiApplication>

using namespace Qt::StringLiterals;

namespace jarvis::shell {
QString shellAppId() { return u"jarvis-shell"_s; }
QString shellLayerScope() { return u"jarvis-shell"_s; }
QString overlayLayerScope() { return u"jarvis-cu-overlay"_s; }
void applyShellIdentity() { QGuiApplication::setDesktopFileName(shellAppId()); }
} // namespace jarvis::shell
