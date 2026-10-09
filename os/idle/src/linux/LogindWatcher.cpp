#include "linux/LogindWatcher.h"

#include <QCoreApplication>
#include <QDBusInterface>
#include <QDBusObjectPath>
#include <QDBusReply>
#include <QDBusVariant>

using namespace Qt::StringLiterals;

namespace {
const QString kService = u"org.freedesktop.login1"_s;
const QString kManagerPath = u"/org/freedesktop/login1"_s;
const QString kManager = u"org.freedesktop.login1.Manager"_s;
const QString kSession = u"org.freedesktop.login1.Session"_s;
} // namespace

LogindWatcher::LogindWatcher(QDBusConnection bus, QObject* parent)
    : QObject(parent)
    , m_bus(std::move(bus))
{
    m_lidPoll.setInterval(2000);
    connect(&m_lidPoll, &QTimer::timeout, this, [this] {
        const bool closed = lidClosedNow();
        if (closed && !m_lidWasClosed)
            emit lidClosed();
        m_lidWasClosed = closed;
    });
}

bool LogindWatcher::start()
{
    QDBusInterface manager(kService, kManagerPath, kManager, m_bus);
    if (!manager.isValid())
        return false;
    QDBusReply<QDBusObjectPath> session = manager.call(u"GetSessionByPID"_s, quint32(QCoreApplication::applicationPid()));
    if (!session.isValid()) {
        const QString id = qEnvironmentVariable("XDG_SESSION_ID");
        if (!id.isEmpty())
            session = manager.call(u"GetSession"_s, id);
    }
    if (session.isValid()) {
        m_sessionPath = session.value().path();
        m_bus.connect(kService, m_sessionPath, kSession, u"Lock"_s, this, SLOT(onLock()));
    }
    m_bus.connect(kService, kManagerPath, kManager, u"PrepareForSleep"_s, this, SLOT(onPrepareForSleep(bool)));
    takeSleepDelay();
    m_lidWasClosed = lidClosedNow();
    m_lidPoll.start();
    return true;
}

void LogindWatcher::takeSleepDelay()
{
    if (m_delay.isValid())
        return;
    QDBusInterface manager(kService, kManagerPath, kManager, m_bus);
    QDBusReply<QDBusUnixFileDescriptor> fd = manager.call(u"Inhibit"_s, u"sleep"_s, u"Jarvis"_s,
                                                          u"Lock the screen before sleep"_s, u"delay"_s);
    if (fd.isValid())
        m_delay = fd.value();
}

void LogindWatcher::releaseSleepDelay()
{
    m_delay = QDBusUnixFileDescriptor(); // closes our copy: logind may suspend now
}

void LogindWatcher::onLock()
{
    emit lockRequested();
}

void LogindWatcher::onPrepareForSleep(bool start)
{
    if (start) {
        emit sleepComing();
        return;
    }
    takeSleepDelay(); // ready for the next suspend
    emit resumed();
}

bool LogindWatcher::lidClosedNow()
{
    QDBusInterface properties(kService, kManagerPath, u"org.freedesktop.DBus.Properties"_s, m_bus);
    const QDBusReply<QDBusVariant> reply = properties.call(u"Get"_s, kManager, u"LidClosed"_s);
    return reply.isValid() && reply.value().variant().toBool();
}
