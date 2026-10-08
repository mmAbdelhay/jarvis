#pragma once

#include <QStringList>

#include "PowerActions.h"

// Records power requests instead of making them (tests, macOS dev runs).
class FakePower : public PowerActions {
    Q_OBJECT
public:
    using PowerActions::PowerActions;
    bool available() const override { return isAvailable; }
    void powerOff() override { calls.append(QStringLiteral("PowerOff")); }
    void reboot() override { calls.append(QStringLiteral("Reboot")); }

    bool isAvailable = true;
    QStringList calls;
};
