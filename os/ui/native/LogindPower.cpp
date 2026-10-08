#ifdef JARVIS_HAVE_DBUS
#include "LogindPower.h"

#include <QDBusMessage>
#include <QDBusPendingCallWatcher>
#include <QDBusPendingReply>

using namespace Qt::StringLiterals;

LogindPower::LogindPower(QDBusConnection bus, QObject* parent)
    : PowerActions(parent)
    , m_bus(std::move(bus))
{
}

void LogindPower::powerOff() { call(u"PowerOff"_s); }
void LogindPower::reboot() { call(u"Reboot"_s); }

void LogindPower::call(const QString& method)
{
    QDBusMessage message = QDBusMessage::createMethodCall(
        u"org.freedesktop.login1"_s, u"/org/freedesktop/login1"_s, u"org.freedesktop.login1.Manager"_s, method);
    message << false; // interactive = false: never ask for a password here
    auto* watcher = new QDBusPendingCallWatcher(m_bus.asyncCall(message, 10000), this);
    connect(watcher, &QDBusPendingCallWatcher::finished, this, [this](QDBusPendingCallWatcher* w) {
        w->deleteLater();
        const QDBusPendingReply<> reply = *w;
        if (reply.isError())
            emit failed(reply.error().message().isEmpty() ? reply.error().name() : reply.error().message());
    });
}

#endif // JARVIS_HAVE_DBUS
