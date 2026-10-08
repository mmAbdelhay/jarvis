#pragma once

#include <QString>

// The login screen's keyboard indicator (design: "EN"), from the system's
// first XKB layout. Read-only: cage takes its layout from the environment
// at start, so the greeter cannot switch it (see coordination notes).
QString keyboardCode(const QString& path = QStringLiteral("/etc/default/keyboard"));
QString keyboardName(const QString& path = QStringLiteral("/etc/default/keyboard"));
