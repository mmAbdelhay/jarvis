#pragma once

#ifdef JARVIS_HAVE_DBUS

#include <QDBusConnection>

#include "PowerActions.h"

class LogindPower : public PowerActions {
    Q_OBJECT
public:
    explicit LogindPower(QDBusConnection bus = QDBusConnection::systemBus(), QObject* parent = nullptr);
    bool available() const override { return m_bus.isConnected(); }
    void powerOff() override;
    void reboot() override;

private:
    void call(const QString& method);
    QDBusConnection m_bus;
};

#endif // JARVIS_HAVE_DBUS
