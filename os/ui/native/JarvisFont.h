#pragma once

#include <QtGlobal>

namespace jarvis::ui {
// IBM Plex Sans at round(15 × scale) px as the application font, so every
// Text and control inherits the design's body type. Call after QGuiApplication.
void applyJarvisFont(qreal scale = 1.0);
}
